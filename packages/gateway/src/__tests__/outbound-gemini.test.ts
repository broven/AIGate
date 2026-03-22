import { describe, test, expect, beforeAll } from 'bun:test'
import { initLlmsBridge } from '../adapters/llms-bridge'
import { buildGeminiBody, parseGeminiResponse } from '../adapters/outbound/gemini'
import type { UniversalRequest } from '@aigate/shared'

beforeAll(async () => {
  initLlmsBridge()
})

const baseRequest: UniversalRequest = {
  id: 'test-out-1',
  model: 'gemini-pro',
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

describe('Gemini Outbound Adapter', () => {
  describe('buildGeminiBody', () => {
    test('system message → systemInstruction', async () => {
      const body = await buildGeminiBody(baseRequest, 'gemini-pro')
      expect(body.systemInstruction).toBeDefined()
      // systemInstruction should contain the system text
      const sysText = typeof body.systemInstruction === 'string'
        ? body.systemInstruction
        : body.systemInstruction?.parts?.[0]?.text
      expect(sysText).toContain('helpful')
    })

    test('user message → contents array', async () => {
      const body = await buildGeminiBody(baseRequest, 'gemini-pro')
      expect(body.contents).toBeDefined()
      const userContent = body.contents.find((c: any) => c.role === 'user')
      expect(userContent).toBeDefined()
    })

    test('generationConfig includes temperature and maxOutputTokens', async () => {
      const body = await buildGeminiBody(baseRequest, 'gemini-pro')
      expect(body.generationConfig).toBeDefined()
      expect(body.generationConfig.temperature).toBe(0.7)
      expect(body.generationConfig.maxOutputTokens).toBe(1024)
    })

    test('tools → functionDeclarations', async () => {
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
      const body = await buildGeminiBody(req, 'gemini-pro')
      expect(body.tools).toBeDefined()
      const decl = body.tools[0]?.functionDeclarations?.[0]
      expect(decl).toBeDefined()
      expect(decl.name).toBe('get_weather')
    })
  })

  describe('parseGeminiResponse', () => {
    test('extracts text from parts', () => {
      const raw = {
        candidates: [{
          content: { parts: [{ text: 'Hello there!' }], role: 'model' },
          finishReason: 'STOP',
        }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
      }
      const resp = parseGeminiResponse(raw)
      expect(resp.content).toBe('Hello there!')
    })

    test('maps finishReason STOP → stop', () => {
      const raw = {
        candidates: [{
          content: { parts: [{ text: 'Hi' }], role: 'model' },
          finishReason: 'STOP',
        }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      }
      expect(parseGeminiResponse(raw).finishReason).toBe('stop')
    })

    test('maps finishReason MAX_TOKENS → length', () => {
      const raw = {
        candidates: [{
          content: { parts: [{ text: 'Hi' }], role: 'model' },
          finishReason: 'MAX_TOKENS',
        }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      }
      expect(parseGeminiResponse(raw).finishReason).toBe('length')
    })

    test('extracts functionCall → toolCalls', () => {
      const raw = {
        candidates: [{
          content: {
            parts: [{ functionCall: { name: 'get_weather', args: { city: 'Tokyo' } } }],
            role: 'model',
          },
          finishReason: 'STOP',
        }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      }
      const resp = parseGeminiResponse(raw)
      expect(resp.toolCalls).toBeDefined()
      expect(resp.toolCalls![0].name).toBe('get_weather')
      expect(resp.toolCalls![0].arguments).toBe('{"city":"Tokyo"}')
    })

    test('maps usage correctly', () => {
      const raw = {
        candidates: [{
          content: { parts: [{ text: 'Hi' }], role: 'model' },
          finishReason: 'STOP',
        }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 },
      }
      const resp = parseGeminiResponse(raw)
      expect(resp.usage.inputTokens).toBe(100)
      expect(resp.usage.outputTokens).toBe(50)
    })
  })
})
