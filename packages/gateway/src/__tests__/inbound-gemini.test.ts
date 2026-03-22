import { describe, test, expect, beforeAll } from 'bun:test'
import { initLlmsBridge } from '../adapters/llms-bridge'
import { parseGeminiRequest, formatGeminiResponse, formatGeminiError } from '../adapters/inbound/gemini'
import type { UniversalResponse } from '@aigate/shared'
import geminiReq from './fixtures/gemini-request.json'
import geminiToolReq from './fixtures/gemini-tool-request.json'

beforeAll(async () => {
  initLlmsBridge()
})

describe('Gemini Inbound Adapter', () => {
  describe('parseGeminiRequest', () => {
    test('basic text message → UniversalRequest', async () => {
      const req = await parseGeminiRequest(geminiReq, 'test-key', 'gemini-pro')
      expect(req.id).toBeDefined()
      expect(req.model).toBe('gemini-pro')
      expect(req.metadata.sourceFormat).toBe('gemini')
      expect(req.metadata.gatewayKey).toBe('test-key')
    })

    test('systemInstruction → system role message', async () => {
      const req = await parseGeminiRequest(geminiReq, 'test-key', 'gemini-pro')
      const systemMsg = req.messages.find((m) => m.role === 'system')
      expect(systemMsg).toBeDefined()
      expect(systemMsg!.content).toContain('helpful assistant')
    })

    test('user role preserved', async () => {
      const req = await parseGeminiRequest(geminiReq, 'test-key', 'gemini-pro')
      const userMsg = req.messages.find((m) => m.role === 'user')
      expect(userMsg).toBeDefined()
      expect(userMsg!.content).toContain('Hello')
    })

    test('generationConfig.temperature → parameters.temperature', async () => {
      const req = await parseGeminiRequest(geminiReq, 'test-key', 'gemini-pro')
      expect(req.parameters.temperature).toBe(0.7)
    })

    test('generationConfig.maxOutputTokens → parameters.maxTokens', async () => {
      const req = await parseGeminiRequest(geminiReq, 'test-key', 'gemini-pro')
      expect(req.parameters.maxTokens).toBe(1024)
    })

    test('functionCall parts → toolCalls', async () => {
      const req = await parseGeminiRequest(geminiToolReq, 'test-key', 'gemini-pro')
      const assistantMsg = req.messages.find((m) => m.role === 'assistant')
      expect(assistantMsg).toBeDefined()
      expect(assistantMsg!.toolCalls).toBeDefined()
      expect(assistantMsg!.toolCalls![0].name).toBe('get_weather')
    })

    test('functionResponse → role:"tool" messages', async () => {
      const req = await parseGeminiRequest(geminiToolReq, 'test-key', 'gemini-pro')
      const toolMsg = req.messages.find((m) => m.role === 'tool')
      expect(toolMsg).toBeDefined()
    })

    test('functionDeclarations → ToolDefinition', async () => {
      const req = await parseGeminiRequest(geminiToolReq, 'test-key', 'gemini-pro')
      expect(req.parameters.tools).toBeDefined()
      expect(req.parameters.tools![0].name).toBe('get_weather')
    })
  })

  describe('formatGeminiResponse', () => {
    const baseResponse: UniversalResponse = {
      id: 'test-resp-1',
      model: 'gemini-pro',
      content: 'Hello! How can I help?',
      finishReason: 'stop',
      usage: { inputTokens: 20, outputTokens: 10 },
    }

    test('text → candidates[0].content.parts', () => {
      const resp = formatGeminiResponse(baseResponse)
      expect(resp.candidates).toBeDefined()
      expect(resp.candidates[0].content.parts[0].text).toBe('Hello! How can I help?')
      expect(resp.candidates[0].content.role).toBe('model')
    })

    test('finishReason: stop → STOP', () => {
      const resp = formatGeminiResponse(baseResponse)
      expect(resp.candidates[0].finishReason).toBe('STOP')
    })

    test('finishReason: length → MAX_TOKENS', () => {
      const resp = formatGeminiResponse({ ...baseResponse, finishReason: 'length' })
      expect(resp.candidates[0].finishReason).toBe('MAX_TOKENS')
    })

    test('usage → usageMetadata', () => {
      const resp = formatGeminiResponse(baseResponse)
      expect(resp.usageMetadata.promptTokenCount).toBe(20)
      expect(resp.usageMetadata.candidatesTokenCount).toBe(10)
    })

    test('toolCalls → functionCall parts', () => {
      const resp = formatGeminiResponse({
        ...baseResponse,
        content: '',
        finishReason: 'tool_calls',
        toolCalls: [
          { id: 'call_1', name: 'get_weather', arguments: '{"location":"Tokyo"}' },
        ],
      })
      const fcPart = resp.candidates[0].content.parts.find((p: any) => p.functionCall)
      expect(fcPart).toBeDefined()
      expect(fcPart.functionCall.name).toBe('get_weather')
      expect(fcPart.functionCall.args).toEqual({ location: 'Tokyo' })
    })
  })

  describe('formatGeminiError', () => {
    test('returns Gemini error format', () => {
      const err = formatGeminiError('Something went wrong', 'INVALID_ARGUMENT')
      expect(err.error).toBeDefined()
      expect(err.error.message).toBe('Something went wrong')
      expect(err.error.status).toBe('INVALID_ARGUMENT')
    })
  })
})
