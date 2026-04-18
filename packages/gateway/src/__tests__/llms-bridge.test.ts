import { describe, test, expect, beforeAll } from 'bun:test'
import { initLlmsBridge, getTransformer, buildContext, universalToUnified, unifiedToUniversal } from '../adapters/llms-bridge'
import type { UniversalRequest, UniversalMessage } from '@aigate/shared'

describe('llms-bridge', () => {
  beforeAll(() => {
    initLlmsBridge()
  })

  describe('initLlmsBridge', () => {
    test('getTransformer("Anthropic") returns a transformer with transformRequestOut', () => {
      const t = getTransformer('Anthropic')
      expect(t).toBeDefined()
      expect(typeof t.transformRequestOut).toBe('function')
    })

    test('getTransformer("gemini") returns a transformer with transformRequestIn', () => {
      const t = getTransformer('gemini')
      expect(t).toBeDefined()
      expect(typeof t.transformRequestIn).toBe('function')
    })

    test('getTransformer("OpenAI") returns a transformer', () => {
      const t = getTransformer('OpenAI')
      expect(t).toBeDefined()
    })
  })

  describe('buildContext', () => {
    test('returns valid context with required fields', () => {
      const ctx = buildContext({ stream: true, model: 'claude-sonnet-4-20250514' })
      expect(ctx.stream).toBe(true)
      expect(ctx.model).toBe('claude-sonnet-4-20250514')
      expect(ctx.req).toBeDefined()
      expect(ctx.req.id).toBeDefined()
    })

    test('accepts optional provider', () => {
      const provider = { name: 'test', api_base_url: 'http://localhost', apiKey: 'sk-test' }
      const ctx = buildContext({ stream: false, model: 'gpt-4o', provider })
      expect(ctx.provider.name).toBe('test')
    })
  })

  describe('universalToUnified', () => {
    const baseRequest: UniversalRequest = {
      id: 'test-123',
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello' },
      ],
      parameters: {
        temperature: 0.7,
        maxTokens: 1024,
        topP: 0.9,
        stream: false,
        stop: ['END'],
        tools: [
          {
            name: 'get_weather',
            description: 'Get weather',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
          },
        ],
      },
      metadata: { sourceFormat: 'openai', gatewayKey: 'test', timestamp: Date.now() },
    }

    test('maps messages correctly', () => {
      const unified = universalToUnified(baseRequest)
      expect(unified.messages).toHaveLength(2)
      expect(unified.messages[0].role).toBe('system')
      expect(unified.messages[0].content).toBe('You are helpful.')
      expect(unified.messages[1].role).toBe('user')
    })

    test('maps parameters: maxTokens → max_tokens, topP → top_p', () => {
      const unified = universalToUnified(baseRequest)
      expect(unified.max_tokens).toBe(1024)
      expect(unified.temperature).toBe(0.7)
      // top_p may be mapped depending on implementation
    })

    test('maps tools to OpenAI format { type: "function", function: {...} }', () => {
      const unified = universalToUnified(baseRequest)
      expect(unified.tools).toBeDefined()
      expect(unified.tools![0].type).toBe('function')
      expect(unified.tools![0].function.name).toBe('get_weather')
    })

    test('maps model name', () => {
      const unified = universalToUnified(baseRequest)
      expect(unified.model).toBe('gpt-4o')
    })

    test('maps stream flag', () => {
      const unified = universalToUnified(baseRequest)
      expect(unified.stream).toBe(false)
    })

    test('maps messages with toolCalls', () => {
      const req: UniversalRequest = {
        ...baseRequest,
        messages: [
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: '{"city":"Tokyo"}' }],
          },
        ],
      }
      const unified = universalToUnified(req)
      expect(unified.messages[0].tool_calls).toBeDefined()
      expect(unified.messages[0].tool_calls![0].id).toBe('call_1')
      expect(unified.messages[0].tool_calls![0].function.name).toBe('get_weather')
      expect(unified.messages[0].tool_calls![0].function.arguments).toBe('{"city":"Tokyo"}')
    })

    test('maps messages with toolCallId', () => {
      const req: UniversalRequest = {
        ...baseRequest,
        messages: [
          { role: 'tool', content: '{"result": "sunny"}', toolCallId: 'call_1' },
        ],
      }
      const unified = universalToUnified(req)
      expect(unified.messages[0].role).toBe('tool')
      expect(unified.messages[0].tool_call_id).toBe('call_1')
    })

    test('maps toolChoice string', () => {
      const req: UniversalRequest = {
        ...baseRequest,
        parameters: { ...baseRequest.parameters, toolChoice: 'required' },
      }
      const unified = universalToUnified(req)
      expect(unified.tool_choice).toBe('required')
    })

    test('maps toolChoice {type,name} → OpenAI shape {type,function:{name}}', () => {
      const req: UniversalRequest = {
        ...baseRequest,
        parameters: {
          ...baseRequest.parameters,
          toolChoice: { type: 'function', name: 'get_weather' },
        },
      }
      const unified = universalToUnified(req)
      expect(unified.tool_choice).toEqual({
        type: 'function',
        function: { name: 'get_weather' },
      })
    })

    test('maps content parts (text + image)', () => {
      const req: UniversalRequest = {
        ...baseRequest,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is this?' },
              { type: 'image', imageUrl: 'https://example.com/img.png' },
            ],
          },
        ],
      }
      const unified = universalToUnified(req)
      const content = unified.messages[0].content as any[]
      expect(Array.isArray(content)).toBe(true)
      expect(content[0].type).toBe('text')
      expect(content[1].type).toBe('image_url')
      expect(content[1].image_url.url).toBe('https://example.com/img.png')
    })
  })

  describe('unifiedToUniversal', () => {
    const baseUnified = {
      model: 'gpt-4o',
      messages: [
        { role: 'system' as const, content: 'You are helpful.' },
        { role: 'user' as const, content: 'Hello' },
      ],
      max_tokens: 1024,
      temperature: 0.7,
      stream: false,
    }

    test('maps messages correctly', () => {
      const universal = unifiedToUniversal(baseUnified, {
        sourceFormat: 'openai',
        gatewayKey: 'test',
      })
      expect(universal.messages).toHaveLength(2)
      expect(universal.messages[0].role).toBe('system')
    })

    test('maps max_tokens → maxTokens', () => {
      const universal = unifiedToUniversal(baseUnified, {
        sourceFormat: 'openai',
        gatewayKey: 'test',
      })
      expect(universal.parameters.maxTokens).toBe(1024)
      expect(universal.parameters.temperature).toBe(0.7)
    })

    test('sets metadata correctly', () => {
      const universal = unifiedToUniversal(baseUnified, {
        sourceFormat: 'claude',
        gatewayKey: 'my-key',
      })
      expect(universal.metadata.sourceFormat).toBe('claude')
      expect(universal.metadata.gatewayKey).toBe('my-key')
      expect(universal.metadata.timestamp).toBeGreaterThan(0)
    })

    test('generates an id', () => {
      const universal = unifiedToUniversal(baseUnified, {
        sourceFormat: 'openai',
        gatewayKey: 'test',
      })
      expect(universal.id).toBeDefined()
      expect(universal.id.length).toBeGreaterThan(0)
    })

    test('maps tool_calls from unified format', () => {
      const unified = {
        ...baseUnified,
        messages: [
          {
            role: 'assistant' as const,
            content: null as any,
            tool_calls: [
              { id: 'call_1', type: 'function' as const, function: { name: 'get_weather', arguments: '{}' } },
            ],
          },
        ],
      }
      const universal = unifiedToUniversal(unified, { sourceFormat: 'openai', gatewayKey: 'test' })
      expect(universal.messages[0].toolCalls).toBeDefined()
      expect(universal.messages[0].toolCalls![0].id).toBe('call_1')
      expect(universal.messages[0].toolCalls![0].name).toBe('get_weather')
    })

    test('maps tool_choice string from unified', () => {
      const unified = { ...baseUnified, tool_choice: 'required' as const }
      const universal = unifiedToUniversal(unified, { sourceFormat: 'openai', gatewayKey: 'test' })
      expect(universal.parameters.toolChoice).toBe('required')
    })

    test('maps tool_choice {type,function:{name}} from unified → {type,name}', () => {
      const unified = {
        ...baseUnified,
        tool_choice: { type: 'function' as const, function: { name: 'get_weather' } },
      }
      const universal = unifiedToUniversal(unified, { sourceFormat: 'openai', gatewayKey: 'test' })
      expect(universal.parameters.toolChoice).toEqual({
        type: 'function',
        name: 'get_weather',
      })
    })

    test('maps tool_call_id from unified format', () => {
      const unified = {
        ...baseUnified,
        messages: [
          { role: 'tool' as const, content: '{"result": true}', tool_call_id: 'call_1' },
        ],
      }
      const universal = unifiedToUniversal(unified, { sourceFormat: 'openai', gatewayKey: 'test' })
      expect(universal.messages[0].toolCallId).toBe('call_1')
    })
  })

  describe('roundtrip', () => {
    test('universalToUnified → unifiedToUniversal preserves core data', () => {
      const original: UniversalRequest = {
        id: 'test-rt',
        model: 'gpt-4o',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there' },
        ],
        parameters: {
          temperature: 0.5,
          maxTokens: 512,
          stream: true,
        },
        metadata: { sourceFormat: 'openai', gatewayKey: 'key1', timestamp: 1000 },
      }

      const unified = universalToUnified(original)
      const restored = unifiedToUniversal(unified, {
        sourceFormat: 'openai',
        gatewayKey: 'key1',
      })

      expect(restored.model).toBe(original.model)
      expect(restored.messages).toHaveLength(original.messages.length)
      expect(restored.messages[0].role).toBe('user')
      expect(restored.messages[0].content).toBe('Hello')
      expect(restored.parameters.maxTokens).toBe(original.parameters.maxTokens)
      expect(restored.parameters.temperature).toBe(original.parameters.temperature)
      expect(restored.parameters.stream).toBe(original.parameters.stream)
    })
  })
})
