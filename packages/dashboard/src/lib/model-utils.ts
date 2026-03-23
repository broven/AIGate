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
