import { describe, test, expect, beforeAll } from 'bun:test'
import { initLlmsBridge } from '../adapters/llms-bridge'
import { getInboundAdapter, getOutboundAdapter, type ApiFormat } from '../adapters/registry'

beforeAll(async () => {
  initLlmsBridge()
})

describe('Adapter Registry', () => {
  describe('getInboundAdapter', () => {
    test('openai returns adapter with required methods', () => {
      const adapter = getInboundAdapter('openai')
      expect(typeof adapter.parseRequest).toBe('function')
      expect(typeof adapter.formatResponse).toBe('function')
      expect(typeof adapter.formatError).toBe('function')
    })

    test('claude returns adapter with required methods', () => {
      const adapter = getInboundAdapter('claude')
      expect(typeof adapter.parseRequest).toBe('function')
      expect(typeof adapter.formatResponse).toBe('function')
      expect(typeof adapter.formatError).toBe('function')
    })

    test('gemini returns adapter with required methods', () => {
      const adapter = getInboundAdapter('gemini')
      expect(typeof adapter.parseRequest).toBe('function')
      expect(typeof adapter.formatResponse).toBe('function')
      expect(typeof adapter.formatError).toBe('function')
    })

    test('unknown format throws error', () => {
      expect(() => getInboundAdapter('unknown' as ApiFormat)).toThrow()
    })
  })

  describe('getOutboundAdapter', () => {
    test('openai returns adapter with required methods', () => {
      const adapter = getOutboundAdapter('openai')
      expect(typeof adapter.sendRequest).toBe('function')
      expect(typeof adapter.parseResponse).toBe('function')
      expect(adapter.format).toBe('openai')
    })

    test('claude returns adapter with required methods', () => {
      const adapter = getOutboundAdapter('claude')
      expect(typeof adapter.sendRequest).toBe('function')
      expect(typeof adapter.parseResponse).toBe('function')
      expect(adapter.format).toBe('claude')
    })

    test('gemini returns adapter with required methods', () => {
      const adapter = getOutboundAdapter('gemini')
      expect(typeof adapter.sendRequest).toBe('function')
      expect(typeof adapter.parseResponse).toBe('function')
      expect(adapter.format).toBe('gemini')
    })

    test('unknown format throws error', () => {
      expect(() => getOutboundAdapter('unknown' as ApiFormat)).toThrow()
    })
  })
})
