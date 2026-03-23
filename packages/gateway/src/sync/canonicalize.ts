// Model name canonicalization — normalize provider prefixes and version
// separators so the same upstream model resolves to one canonical name.

const PROVIDER_PREFIX_RE = /^[a-z0-9_-]+\//

export function canonicalize(modelId: string): string {
  let name = modelId.toLowerCase().trim()

  // Strip provider prefix (e.g. "openai/gpt-4o" → "gpt-4o")
  name = name.replace(PROVIDER_PREFIX_RE, '')

  // Normalize version dots to dashes: "claude-3.5-sonnet" → "claude-3-5-sonnet"
  // Safe: dots between digits in model names are always version separators
  name = name.replace(/(\d)\.(?=\d)/g, '$1-')

  return name
}

// Display name: convert single-digit-dash-single-digit back to dots for UI.
// e.g. "claude-3-5-sonnet" → "claude-3.5-sonnet"
// Lookbehind/lookahead prevent touching date suffixes like -20250514
export function displayName(canonical: string): string {
  return canonical.replace(/(?<!\d)(\d)-(\d)(?!\d)/g, '$1.$2')
}

// Return alternate name forms (dot variant) if different from canonical
export function getAliases(canonical: string): string[] {
  const display = displayName(canonical)
  return display !== canonical ? [display] : []
}
