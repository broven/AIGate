import { describe, test, expect, beforeAll } from 'bun:test'
import { initLlmsBridge } from '../adapters/llms-bridge'
import { buildAnthropicBody, parseAnthropicResponse } from '../adapters/outbound/anthropic'
import type { UniversalRequest } from '@aigate/shared'

beforeAll(async () => {
  initLlmsBridge()
})

const baseRequest: UniversalRequest = {
  id: 'test-out-1',
  model: 'claude-sonnet-4-20250514',
  messages: [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Hello' },
  ],
  parameters: {
    temperature: 0.7,
    maxTokens: 1024,
    stream: false,
  },
  metadata: { sourceFormat: 'openai', gatewayKey: 'test', timestamp: Date.now() },
}

describe('Anthropic Outbound Adapter', () => {
  describe('buildAnthropicBody', () => {
    test('system messages → top-level system param', async () => {
      const body = await buildAnthropicBody(baseRequest, 'claude-sonnet-4-20250514')
      expect(body.system).toBeDefined()
      // System should contain the system message content
      if (typeof body.system === 'string') {
        expect(body.system).toContain('helpful')
      } else if (Array.isArray(body.system)) {
        expect(body.system[0].text).toContain('helpful')
      }
      // Messages should NOT contain the system message
      const systemInMessages = body.messages?.find((m: any) => m.role === 'system')
      expect(systemInMessages).toBeUndefined()
    })

    test('user message preserved in messages array', async () => {
      const body = await buildAnthropicBody(baseRequest, 'claude-sonnet-4-20250514')
      const userMsg = body.messages?.find((m: any) => m.role === 'user')
      expect(userMsg).toBeDefined()
    })

    test('model is set to upstream model name', async () => {
      const body = await buildAnthropicBody(baseRequest, 'claude-sonnet-4-20250514')
      expect(body.model).toBe('claude-sonnet-4-20250514')
    })

    test('max_tokens is set', async () => {
      const body = await buildAnthropicBody(baseRequest, 'claude-sonnet-4-20250514')
      expect(body.max_tokens).toBe(1024)
    })

    test('stream flag included', async () => {
      const streamReq = { ...baseRequest, parameters: { ...baseRequest.parameters, stream: true } }
      const body = await buildAnthropicBody(streamReq, 'claude-sonnet-4-20250514')
      expect(body.stream).toBe(true)
    })

    test('tools → Anthropic tool format with input_schema', async () => {
      const req: UniversalRequest = {
        ...baseRequest,
        parameters: {
          ...baseRequest.parameters,
          tools: [{
            name: 'get_weather',
            description: 'Get weather',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
          }],
        },
      }
      const body = await buildAnthropicBody(req, 'claude-sonnet-4-20250514')
      expect(body.tools).toBeDefined()
      expect(body.tools[0].name).toBe('get_weather')
      expect(body.tools[0].input_schema).toBeDefined()
    })

    test('toolCalls in messages → tool_use content blocks', async () => {
      const req: UniversalRequest = {
        ...baseRequest,
        messages: [
          { role: 'user', content: 'Get weather' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: '{"city":"Tokyo"}' }],
          },
          { role: 'tool', content: '{"temp":22}', toolCallId: 'call_1' },
        ],
      }
      const body = await buildAnthropicBody(req, 'claude-sonnet-4-20250514')
      // The assistant message should have tool_use content blocks
      const assistantMsg = body.messages?.find((m: any) => m.role === 'assistant')
      expect(assistantMsg).toBeDefined()
    })
  })

  describe('parseAnthropicResponse', () => {
    test('extracts text from content blocks', () => {
      const raw = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello there!' }],
        model: 'claude-sonnet-4-20250514',
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      }
      const resp = parseAnthropicResponse(raw)
      expect(resp.content).toBe('Hello there!')
      expect(resp.model).toBe('claude-sonnet-4-20250514')
    })

    test('maps stop_reason: end_turn → stop', () => {
      const raw = {
        id: 'msg_123',
        content: [{ type: 'text', text: 'Hi' }],
        model: 'claude-sonnet-4-20250514',
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      }
      const resp = parseAnthropicResponse(raw)
      expect(resp.finishReason).toBe('stop')
    })

    test('maps stop_reason: max_tokens → length', () => {
      const raw = {
        id: 'msg_123',
        content: [{ type: 'text', text: 'Hi' }],
        model: 'claude-sonnet-4-20250514',
        stop_reason: 'max_tokens',
        usage: { input_tokens: 10, output_tokens: 5 },
      }
      const resp = parseAnthropicResponse(raw)
      expect(resp.finishReason).toBe('length')
    })

    test('maps stop_reason: tool_use → tool_calls', () => {
      const raw = {
        id: 'msg_123',
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Tokyo' } },
        ],
        model: 'claude-sonnet-4-20250514',
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 5 },
      }
      const resp = parseAnthropicResponse(raw)
      expect(resp.finishReason).toBe('tool_calls')
      expect(resp.toolCalls).toBeDefined()
      expect(resp.toolCalls![0].name).toBe('get_weather')
      expect(resp.toolCalls![0].arguments).toBe('{"city":"Tokyo"}')
    })

    test('maps usage correctly', () => {
      const raw = {
        id: 'msg_123',
        content: [{ type: 'text', text: 'Hi' }],
        model: 'claude-sonnet-4-20250514',
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 50 },
      }
      const resp = parseAnthropicResponse(raw)
      expect(resp.usage.inputTokens).toBe(100)
      expect(resp.usage.outputTokens).toBe(50)
    })
  })
})
