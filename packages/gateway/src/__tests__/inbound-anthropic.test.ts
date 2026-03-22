import { describe, test, expect, beforeAll } from 'bun:test'
import { initLlmsBridge } from '../adapters/llms-bridge'
import { parseAnthropicRequest, formatAnthropicResponse, formatAnthropicError } from '../adapters/inbound/anthropic'
import type { UniversalResponse } from '@aigate/shared'
import anthropicReq from './fixtures/anthropic-request.json'
import anthropicToolReq from './fixtures/anthropic-tool-request.json'

beforeAll(async () => {
  initLlmsBridge()
})

describe('Anthropic Inbound Adapter', () => {
  describe('parseAnthropicRequest', () => {
    test('basic text message → UniversalRequest', async () => {
      const req = await parseAnthropicRequest(anthropicReq, 'test-key')
      expect(req.id).toBeDefined()
      expect(req.model).toBe('claude-sonnet-4-20250514')
      expect(req.metadata.sourceFormat).toBe('claude')
      expect(req.metadata.gatewayKey).toBe('test-key')
    })

    test('system param → system role message', async () => {
      const req = await parseAnthropicRequest(anthropicReq, 'test-key')
      const systemMsg = req.messages.find((m) => m.role === 'system')
      expect(systemMsg).toBeDefined()
      expect(systemMsg!.content).toContain('helpful assistant')
    })

    test('user message content preserved', async () => {
      const req = await parseAnthropicRequest(anthropicReq, 'test-key')
      const userMsg = req.messages.find((m) => m.role === 'user')
      expect(userMsg).toBeDefined()
      expect(userMsg!.content).toContain('Hello')
    })

    test('max_tokens → parameters.maxTokens', async () => {
      const req = await parseAnthropicRequest(anthropicReq, 'test-key')
      expect(req.parameters.maxTokens).toBe(1024)
    })

    test('temperature → parameters.temperature', async () => {
      const req = await parseAnthropicRequest(anthropicReq, 'test-key')
      expect(req.parameters.temperature).toBe(0.7)
    })

    test('stream flag preserved', async () => {
      const req = await parseAnthropicRequest(anthropicReq, 'test-key')
      expect(req.parameters.stream).toBe(false)
    })

    test('tool_use in assistant message → toolCalls', async () => {
      const req = await parseAnthropicRequest(anthropicToolReq, 'test-key')
      const assistantMsg = req.messages.find((m) => m.role === 'assistant')
      expect(assistantMsg).toBeDefined()
      expect(assistantMsg!.toolCalls).toBeDefined()
      expect(assistantMsg!.toolCalls!.length).toBeGreaterThan(0)
      expect(assistantMsg!.toolCalls![0].name).toBe('get_weather')
    })

    test('tool_result → role:"tool" messages', async () => {
      const req = await parseAnthropicRequest(anthropicToolReq, 'test-key')
      const toolMsg = req.messages.find((m) => m.role === 'tool')
      expect(toolMsg).toBeDefined()
      expect(toolMsg!.toolCallId).toBeDefined()
    })

    test('tools with input_schema → ToolDefinition with parameters', async () => {
      const req = await parseAnthropicRequest(anthropicToolReq, 'test-key')
      expect(req.parameters.tools).toBeDefined()
      expect(req.parameters.tools!.length).toBeGreaterThan(0)
      expect(req.parameters.tools![0].name).toBe('get_weather')
      expect(req.parameters.tools![0].parameters).toBeDefined()
    })

    test('content blocks (text array) → string content', async () => {
      const body = {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 100,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Hello world' }],
          },
        ],
      }
      const req = await parseAnthropicRequest(body, 'test-key')
      const userMsg = req.messages.find((m) => m.role === 'user')
      expect(userMsg).toBeDefined()
      // Content should be either the text string or a ContentPart array
      const content = userMsg!.content
      if (typeof content === 'string') {
        expect(content).toContain('Hello world')
      } else {
        expect(content[0]).toBeDefined()
      }
    })
  })

  describe('formatAnthropicResponse', () => {
    const baseResponse: UniversalResponse = {
      id: 'test-resp-1',
      model: 'claude-sonnet-4-20250514',
      content: 'Hello! How can I help you?',
      finishReason: 'stop',
      usage: { inputTokens: 20, outputTokens: 10 },
    }

    test('text content → content blocks', () => {
      const resp = formatAnthropicResponse(baseResponse)
      expect(resp.type).toBe('message')
      expect(resp.role).toBe('assistant')
      expect(resp.content).toBeDefined()
      expect(Array.isArray(resp.content)).toBe(true)
      expect(resp.content[0].type).toBe('text')
      expect(resp.content[0].text).toBe('Hello! How can I help you?')
    })

    test('finishReason: stop → end_turn', () => {
      const resp = formatAnthropicResponse(baseResponse)
      expect(resp.stop_reason).toBe('end_turn')
    })

    test('finishReason: length → max_tokens', () => {
      const resp = formatAnthropicResponse({ ...baseResponse, finishReason: 'length' })
      expect(resp.stop_reason).toBe('max_tokens')
    })

    test('finishReason: tool_calls → tool_use', () => {
      const resp = formatAnthropicResponse({ ...baseResponse, finishReason: 'tool_calls' })
      expect(resp.stop_reason).toBe('tool_use')
    })

    test('usage mapping: inputTokens → input_tokens', () => {
      const resp = formatAnthropicResponse(baseResponse)
      expect(resp.usage.input_tokens).toBe(20)
      expect(resp.usage.output_tokens).toBe(10)
    })

    test('toolCalls → tool_use content blocks', () => {
      const resp = formatAnthropicResponse({
        ...baseResponse,
        content: '',
        finishReason: 'tool_calls',
        toolCalls: [
          { id: 'toolu_1', name: 'get_weather', arguments: '{"location":"Tokyo"}' },
        ],
      })
      const toolBlock = resp.content.find((b: any) => b.type === 'tool_use')
      expect(toolBlock).toBeDefined()
      expect(toolBlock.name).toBe('get_weather')
      expect(toolBlock.input).toEqual({ location: 'Tokyo' })
    })

    test('model is preserved', () => {
      const resp = formatAnthropicResponse(baseResponse)
      expect(resp.model).toBe('claude-sonnet-4-20250514')
    })
  })

  describe('formatAnthropicError', () => {
    test('returns Anthropic error format', () => {
      const err = formatAnthropicError('Something went wrong', 'api_error')
      expect(err.type).toBe('error')
      expect(err.error.type).toBe('api_error')
      expect(err.error.message).toBe('Something went wrong')
    })
  })
})
