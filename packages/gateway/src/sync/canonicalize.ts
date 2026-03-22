// Model name canonicalization — strip provider prefixes and date suffixes

const PROVIDER_PREFIXES = [
  'openai/', 'anthropic/', 'google/', 'meta-llama/', 'mistralai/',
  'deepseek/', 'cohere/', 'qwen/', 'microsoft/', 'z-ai/',
]

const DATE_SUFFIX_RE = /-\d{4}-\d{2}-\d{2}$/
const PREVIEW_SUFFIX_RE = /-preview$/

// Well-known model families for matching
const MODEL_FAMILIES: Record<string, RegExp> = {
  'gpt-4o': /^gpt-4o(?!-mini)/,
  'gpt-4o-mini': /^gpt-4o-mini/,
  'gpt-4-turbo': /^gpt-4-turbo/,
  'gpt-4': /^gpt-4(?!o|-turbo)/,
  'gpt-3.5-turbo': /^gpt-3\.5-turbo/,
  'o1': /^o1(?!-mini|-pro)/,
  'o1-mini': /^o1-mini/,
  'o1-pro': /^o1-pro/,
  'o3': /^o3(?!-mini)/,
  'o3-mini': /^o3-mini/,
  'o4-mini': /^o4-mini/,
  'claude-3-opus': /^claude-3-opus/,
  'claude-3.5-sonnet': /^claude-3[.-]5-sonnet/,
  'claude-3.5-haiku': /^claude-3[.-]5-haiku/,
  'claude-3.7-sonnet': /^claude-3[.-]7-sonnet/,
  'claude-sonnet-4-5': /^claude-(?:sonnet-)?4[.-]5[.-]?(?:sonnet)?/,
  'claude-sonnet-4-6': /^claude-(?:sonnet-)?4[.-]6[.-]?(?:sonnet)?/,
  'claude-opus-4-5': /^claude-(?:opus-)?4[.-]5[.-]?(?:opus)?/,
  'claude-opus-4-6': /^claude-(?:opus-)?4[.-]6[.-]?(?:opus)?/,
  'claude-haiku-4-5': /^claude-(?:haiku-)?4[.-]5[.-]?(?:haiku)?/,
  'claude-sonnet-4': /^claude-(?:sonnet-)?4[.-]?(?:sonnet)?/,
  'claude-opus-4': /^claude-(?:opus-)?4[.-]?(?:opus)?/,
  'gemini-2.0-flash': /^gemini-2\.0-flash/,
  'gemini-2.5-pro': /^gemini-2\.5-pro/,
  'gemini-2.5-flash': /^gemini-2\.5-flash/,
  'deepseek-chat': /^deepseek-chat/,
  'deepseek-r1': /^deepseek-r[12]/,
  'llama-3.3-70b': /^llama-3\.3-70b/,
  'qwen-2.5-72b': /^qwen-?2\.5-72b/,
}

export function canonicalize(modelId: string): string {
  let name = modelId.toLowerCase().trim()

  // Strip provider prefixes
  for (const prefix of PROVIDER_PREFIXES) {
    if (name.startsWith(prefix)) {
      name = name.slice(prefix.length)
      break
    }
  }

  // Try to match against known model families
  for (const [canonical, pattern] of Object.entries(MODEL_FAMILIES)) {
    if (pattern.test(name)) {
      return canonical
    }
  }

  // Strip date suffix for unknown models
  name = name.replace(DATE_SUFFIX_RE, '')

  return name
}
