// Model name canonicalization — normalize provider prefixes so the same
// upstream model from different providers resolves to one canonical name.

const PROVIDER_PREFIX_RE = /^[a-z0-9_-]+\//

export function canonicalize(modelId: string): string {
  let name = modelId.toLowerCase().trim()

  // Strip provider prefix (e.g. "openai/gpt-4o" → "gpt-4o")
  name = name.replace(PROVIDER_PREFIX_RE, '')

  return name
}
