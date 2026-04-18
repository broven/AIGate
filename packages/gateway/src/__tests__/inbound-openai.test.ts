import { describe, test, expect } from 'bun:test'
import {
  parseOpenAIRequest,
  formatOpenAIResponse,
  STRUCTURED_OUTPUT_SENTINEL,
} from '../adapters/inbound/openai'

const baseBody = {
  model: 'gpt-5.4',
  messages: [{ role: 'user', content: 'Pick a classic novel' }],
}

const jsonSchema = {
  type: 'object' as const,
  properties: {
    title: { type: 'string' },
    year: { type: 'number' },
  },
  required: ['title', 'year'],
  additionalProperties: false,
}

describe('OpenAI Inbound Adapter', () => {
  describe('parseOpenAIRequest — response_format: json_schema', () => {
    test('synthesizes sentinel tool and forces tool_choice', () => {
      const req = parseOpenAIRequest(
        {
          ...baseBody,
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'resp', schema: jsonSchema, strict: false },
          },
        } as any,
        'test-key',
      )
      expect(req.parameters.tools).toHaveLength(1)
      expect(req.parameters.tools![0].name).toBe(STRUCTURED_OUTPUT_SENTINEL)
      expect(req.parameters.tools![0].parameters).toEqual(jsonSchema)
      expect(req.parameters.toolChoice).toEqual({
        type: 'function',
        name: STRUCTURED_OUTPUT_SENTINEL,
      })
    })

    test('user tools coexist with synthetic sentinel tool', () => {
      const userTool = {
        type: 'function' as const,
        function: { name: 'get_weather', description: 'Weather', parameters: { type: 'object' } },
      }
      const req = parseOpenAIRequest(
        {
          ...baseBody,
          tools: [userTool],
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'resp', schema: jsonSchema },
          },
        } as any,
        'test-key',
      )
      expect(req.parameters.tools).toHaveLength(2)
      expect(req.parameters.tools!.map((t) => t.name)).toContain('get_weather')
      expect(req.parameters.tools!.map((t) => t.name)).toContain(STRUCTURED_OUTPUT_SENTINEL)
      expect(req.parameters.toolChoice).toEqual({
        type: 'function',
        name: STRUCTURED_OUTPUT_SENTINEL,
      })
    })

    test('stream: true + json_schema → throws', () => {
      expect(() =>
        parseOpenAIRequest(
          {
            ...baseBody,
            stream: true,
            response_format: {
              type: 'json_schema',
              json_schema: { name: 'resp', schema: jsonSchema },
            },
          } as any,
          'test-key',
        ),
      ).toThrow(/stream/)
    })

    test('missing json_schema.schema → throws', () => {
      expect(() =>
        parseOpenAIRequest(
          {
            ...baseBody,
            response_format: { type: 'json_schema', json_schema: { name: 'resp' } },
          } as any,
          'test-key',
        ),
      ).toThrow(/schema is required/)
    })

    test('user tool colliding with sentinel → throws', () => {
      expect(() =>
        parseOpenAIRequest(
          {
            ...baseBody,
            tools: [
              {
                type: 'function',
                function: {
                  name: STRUCTURED_OUTPUT_SENTINEL,
                  description: 'bad',
                  parameters: {},
                },
              },
            ],
            response_format: {
              type: 'json_schema',
              json_schema: { name: 'resp', schema: jsonSchema },
            },
          } as any,
          'test-key',
        ),
      ).toThrow(/reserved/)
    })
  })

  describe('parseOpenAIRequest — tool_choice passthrough', () => {
    test('client-provided tool_choice string passes through', () => {
      const req = parseOpenAIRequest(
        { ...baseBody, tool_choice: 'required' } as any,
        'test-key',
      )
      expect(req.parameters.toolChoice).toBe('required')
    })

    test('client-provided function tool_choice normalizes shape', () => {
      const req = parseOpenAIRequest(
        {
          ...baseBody,
          tools: [
            {
              type: 'function',
              function: { name: 'foo', description: 'd', parameters: {} },
            },
          ],
          tool_choice: { type: 'function', function: { name: 'foo' } },
        } as any,
        'test-key',
      )
      expect(req.parameters.toolChoice).toEqual({ type: 'function', name: 'foo' })
    })

    test('no json_schema, no tool_choice → undefined', () => {
      const req = parseOpenAIRequest(baseBody as any, 'test-key')
      expect(req.parameters.toolChoice).toBeUndefined()
    })
  })

  describe('formatOpenAIResponse — structured output repack', () => {
    test('sentinel tool_call → content is arguments string, finish_reason stop', () => {
      const argsJson = '{"title":"Middlemarch","year":1871}'
      const out = formatOpenAIResponse(
        'abc',
        'gpt-5.4',
        '',
        'tool_calls',
        [{ id: 'call_1', name: STRUCTURED_OUTPUT_SENTINEL, arguments: argsJson }],
        { inputTokens: 10, outputTokens: 5 },
      )
      expect(out.choices[0].message.content).toBe(argsJson)
      expect(out.choices[0].message.tool_calls).toBeUndefined()
      expect(out.choices[0].finish_reason).toBe('stop')
    })

    test('regular tool_call → unchanged (tool_calls emitted, finish_reason tool_calls)', () => {
      const out = formatOpenAIResponse(
        'abc',
        'gpt-5.4',
        '',
        'tool_calls',
        [{ id: 'call_1', name: 'get_weather', arguments: '{"city":"SF"}' }],
        { inputTokens: 10, outputTokens: 5 },
      )
      expect(out.choices[0].message.content).toBe('')
      expect(out.choices[0].message.tool_calls).toHaveLength(1)
      expect((out.choices[0].message.tool_calls as any[])[0].function.name).toBe('get_weather')
      expect(out.choices[0].finish_reason).toBe('tool_calls')
    })

    test('plain text response unchanged', () => {
      const out = formatOpenAIResponse(
        'abc',
        'gpt-5.4',
        'hello world',
        'stop',
        undefined,
        { inputTokens: 5, outputTokens: 2 },
      )
      expect(out.choices[0].message.content).toBe('hello world')
      expect(out.choices[0].message.tool_calls).toBeUndefined()
      expect(out.choices[0].finish_reason).toBe('stop')
    })
  })
})
