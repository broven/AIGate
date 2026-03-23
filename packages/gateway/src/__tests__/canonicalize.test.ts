import { describe, test, expect } from 'bun:test'
import { canonicalize, displayName, getAliases } from '../sync/canonicalize'

describe('canonicalize', () => {
  test('strips provider prefix', () => {
    expect(canonicalize('openai/gpt-4o')).toBe('gpt-4o')
    expect(canonicalize('google/gemini-2.5-pro')).toBe('gemini-2-5-pro')
  })

  test('normalizes version dots to dashes', () => {
    expect(canonicalize('claude-3.5-sonnet')).toBe('claude-3-5-sonnet')
    expect(canonicalize('claude-opus-4.6')).toBe('claude-opus-4-6')
    expect(canonicalize('gemini-2.5-pro')).toBe('gemini-2-5-pro')
    expect(canonicalize('gemini-2.5-flash')).toBe('gemini-2-5-flash')
    expect(canonicalize('gpt-3.5-turbo')).toBe('gpt-3-5-turbo')
  })

  test('handles prefix + dots together', () => {
    expect(canonicalize('openai/claude-3.5-sonnet')).toBe('claude-3-5-sonnet')
    expect(canonicalize('anthropic/claude-opus-4.6')).toBe('claude-opus-4-6')
  })

  test('handles multi-segment versions', () => {
    expect(canonicalize('model-v1.2.3')).toBe('model-v1-2-3')
  })

  test('does not change models without version dots', () => {
    expect(canonicalize('gpt-4o')).toBe('gpt-4o')
    expect(canonicalize('gpt-4o-realtime-preview')).toBe('gpt-4o-realtime-preview')
    expect(canonicalize('claude-sonnet-4')).toBe('claude-sonnet-4')
    expect(canonicalize('deepseek-chat')).toBe('deepseek-chat')
    expect(canonicalize('deepseek-r1')).toBe('deepseek-r1')
    expect(canonicalize('o1-preview')).toBe('o1-preview')
  })

  test('does not change date-suffixed models', () => {
    expect(canonicalize('claude-sonnet-4-20250514')).toBe('claude-sonnet-4-20250514')
  })

  test('lowercases input', () => {
    expect(canonicalize('Claude-3.5-Sonnet')).toBe('claude-3-5-sonnet')
  })

  test('dash-form input passes through unchanged', () => {
    expect(canonicalize('claude-3-5-sonnet')).toBe('claude-3-5-sonnet')
    expect(canonicalize('claude-opus-4-6')).toBe('claude-opus-4-6')
  })
})

describe('displayName', () => {
  test('converts single-digit dash pairs to dots', () => {
    expect(displayName('claude-3-5-sonnet')).toBe('claude-3.5-sonnet')
    expect(displayName('claude-opus-4-6')).toBe('claude-opus-4.6')
    expect(displayName('gemini-2-5-pro')).toBe('gemini-2.5-pro')
    expect(displayName('gpt-3-5-turbo')).toBe('gpt-3.5-turbo')
  })

  test('does not touch date suffixes', () => {
    expect(displayName('claude-sonnet-4-20250514')).toBe('claude-sonnet-4-20250514')
  })

  test('does not change models without version pairs', () => {
    expect(displayName('gpt-4o')).toBe('gpt-4o')
    expect(displayName('gpt-4o-realtime-preview')).toBe('gpt-4o-realtime-preview')
    expect(displayName('deepseek-chat')).toBe('deepseek-chat')
  })
})

describe('getAliases', () => {
  test('returns dot variant for versioned models', () => {
    expect(getAliases('claude-opus-4-6')).toEqual(['claude-opus-4.6'])
    expect(getAliases('claude-3-5-sonnet')).toEqual(['claude-3.5-sonnet'])
  })

  test('returns empty for non-versioned models', () => {
    expect(getAliases('gpt-4o')).toEqual([])
    expect(getAliases('deepseek-chat')).toEqual([])
  })
})
