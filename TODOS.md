# TODOS

## Gateway

### Log invalid API key attempts

**What:** Record failed auth attempts (IP, timestamp, key prefix) with rate limiting.

**Why:** Current design says "no logging" for invalid keys, which makes it impossible to debug client misconfiguration, detect abuse patterns, or diagnose key typos. Identified as Failure Mode F5 in eng review.

**Context:** Auth middleware returns 401 for invalid keys. Add a rate-limited log (e.g., max 10 per minute per IP) to a separate `auth_events` table or structured log output. Don't pollute `request_logs` — these aren't real requests.

**Effort:** S
**Priority:** P2
**Depends on:** None

### models.dev data cache + offline fallback

**What:** Cache models.dev API responses in SQLite and fall back to cached data when the API is unavailable.

**Why:** Sync engine depends on models.dev for pricing resolution and canonicalization sanity checks. If models.dev goes down, new models won't get pricing data. Identified as Failure Mode F3 in eng review.

**Context:** On first successful fetch, store the full models.dev response in a `models_dev_cache` table (or a single JSON blob row). On subsequent sync runs, if the fetch fails, use the cached version and log a warning. Cache TTL: 24 hours (re-fetch even if cache exists, but don't fail without it).

**Effort:** S
**Priority:** P2
**Depends on:** Sync engine implementation

### Gemini & Claude adapters + Universal Request Format

**What:** Add Gemini and Claude inbound/outbound adapters, which requires introducing the Universal Request Format abstraction.

**Why:** MVP proxies OpenAI-to-OpenAI directly (per eng review decision 1A). When non-OpenAI formats are needed, that's the trigger to introduce the universal format layer. These two changes are coupled — don't add the abstraction without a real consumer.

**Context:** Design doc has full type definitions for UniversalRequest/UniversalResponse. The adapter interface pattern is defined (inbound: client format → universal, outbound: universal → provider format). When implementing, also add the `shared/` package back into the monorepo. Reference the original design doc section "Core Data Types" for the type definitions.

**Effort:** M
**Priority:** P3
**Depends on:** MVP gateway working with OpenAI-only

## Dashboard

### Full design system via /design-consultation

**What:** Run /design-consultation to produce a comprehensive design system — font exploration, color psychology, motion design, and preview pages.

**Why:** Current DESIGN.md is minimum viable tokens (colors, type, spacing, component patterns). Sufficient for MVP implementation but may need refinement during visual polish. A full design consultation ensures consistency and intentionality.

**Context:** DESIGN.md was created during plan-design-review with terminal/dev-tool aesthetic direction. /design-consultation would expand this with: font pairing research (JetBrains Mono + Inter may not be optimal), animation/motion system, detailed component library, and generated preview pages to validate the design before full implementation.

**Effort:** S
**Priority:** P3
**Depends on:** MVP dashboard implemented (so design consultation can see real components)

## Completed
