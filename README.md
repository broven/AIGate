# AIGate

Intelligent LLM API gateway with automatic provider fallback, price-based routing, and usage tracking.

## Features

- **Multi-protocol API** — supports OpenAI, Anthropic, and Gemini API formats natively
- **Multi-provider routing** — automatic fallback chain across providers
- **Price-based routing** — routes to the cheapest available provider
- **Cross-format routing** — any client format → any upstream format (e.g. Claude Code → OpenAI provider)
- **Cooldown & retry** — failed providers are temporarily cooled down
- **Usage dashboard** — built-in web UI for monitoring requests, costs, and provider health
- **Provider sync** — automatically discovers models and pricing from provider APIs

## Quick Start

### Docker (recommended)

```bash
docker run -d \
  --name aigate \
  -p 3000:3000 \
  -e ADMIN_TOKEN=your-secret-token \
  -v aigate-data:/app/packages/gateway/data \
  ghcr.io/broven/aigate:latest
```

Open `http://localhost:3000` to access the dashboard and log in with your `ADMIN_TOKEN`.

To use a different port, just change the port mapping:

```bash
docker run -d \
  --name aigate \
  -p 8080:3000 \
  -e ADMIN_TOKEN=your-secret-token \
  -v aigate-data:/app/packages/gateway/data \
  ghcr.io/broven/aigate:latest
```

### Docker Compose

```yaml
services:
  aigate:
    image: ghcr.io/broven/aigate:latest
    container_name: aigate
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - ADMIN_TOKEN=your-secret-token   # Required: dashboard login token
    volumes:
      - aigate-data:/app/packages/gateway/data

volumes:
  aigate-data:
```

> **Volume**: `/app/packages/gateway/data` is where the SQLite database is stored. Mount this to persist data across container restarts. The database and tables are created automatically on first start.

### From source

```bash
pnpm install
cp .env.example .env       # then edit .env and set ADMIN_TOKEN
pnpm dev
```

## Configuration

All configuration is via environment variables. Everything has sensible defaults — zero config required.

| Variable | Default | Description |
|----------|---------|-------------|
| `ADMIN_TOKEN` | *(required)* | Token for dashboard authentication |
| `DATABASE_URL` | `./data/aigate.db` | SQLite database path |
| `ARTIFICIAL_ANALYSIS_API_TOKEN` | *(optional)* | API key for [benchmark charts](#benchmark-charts) |

Data is stored in a single SQLite file at the `DATABASE_URL` path. The database and tables are created automatically on first start. In Docker, this defaults to `/app/packages/gateway/data/aigate.db` — make sure to mount a volume at `/app/packages/gateway/data` to persist data.

## Usage

### 1. Create a gateway key

Open the dashboard at `http://localhost:3000` and create an API key in Settings.

### 2. Add providers

Add your LLM provider API keys (OpenAI, Anthropic, Google, etc.) in the Providers page. AIGate will automatically sync available models and pricing.

### 3. Send requests

AIGate accepts requests in OpenAI, Anthropic, and Gemini formats. Point any SDK at AIGate:

**OpenAI SDK**

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/v1",
    api_key="your-gateway-key",
)

response = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello!"}],
)
```

**Claude Code / Anthropic SDK**

```bash
export ANTHROPIC_BASE_URL=http://localhost:3000
export ANTHROPIC_API_KEY=your-gateway-key
```

**Gemini SDK**

```typescript
import { GoogleGenAI } from '@google/genai'

const ai = new GoogleGenAI({
  apiKey: 'your-gateway-key',
  httpOptions: { baseUrl: 'http://localhost:3000' },
})
```

AIGate routes to the cheapest available provider, with automatic fallback if a provider fails.

## Supported Endpoints

### Client-facing (Inbound)

| Endpoint | Format | Usage |
|----------|--------|-------|
| `POST /v1/chat/completions` | OpenAI | OpenAI SDK and compatible clients |
| `POST /v1/messages` | Anthropic | Claude Code, Anthropic SDK |
| `POST /v1beta/models/:model:generateContent` | Gemini | Gemini SDK |
| `POST /v1beta/models/:model:streamGenerateContent` | Gemini (streaming) | Gemini SDK streaming |
| `GET /v1/models` | OpenAI | List available models |

All endpoints accept auth via `Authorization: Bearer <key>` or `x-api-key: <key>`.

### Upstream Providers

**Provider types** (controls model sync):

| Type | Description |
|------|-------------|
| `newapi` | NewAPI-compatible backends (syncs via `/api/pricing`) |
| `openai-compatible` | Any OpenAI-compatible API (syncs via `/v1/models`) |

**API formats** (controls how requests are sent upstream):

| Format | Description | Auth |
|--------|-------------|------|
| `openai` (default) | OpenAI `/v1/chat/completions` | `Authorization: Bearer` |
| `claude` | Anthropic `/v1/messages` | `x-api-key` |
| `gemini` | Gemini `/v1beta/models/:model:generateContent` | `?key=` query param |

**Example configurations:**

| Upstream | Provider type | API format |
|----------|---------------|------------|
| OpenAI API | `openai-compatible` | `openai` |
| Anthropic API | `openai-compatible` | `claude` |
| Google Gemini | `openai-compatible` | `gemini` |
| OpenRouter | `openai-compatible` | `openai` |
| NewAPI relay | `newapi` | `openai` |

### Pricing Sources

A Provider's prices come from its own API when it publishes them, and otherwise
from [models.dev](https://models.dev). models.dev is indexed **per provider**,
so resolving a price requires knowing which provider slug to look under — set
`modelsDevSlug` on the Provider to supply it.

Once `modelsDevSlug` is set it takes priority for **pricing**, even when the
Provider's `/v1/models` responds normally. The model *list* and the model
*prices* are separate concerns: vLLM, Ollama and Azure all answer `/v1/models`
and none of them return prices. Without a slug those Deployments end up
unpriced — and an unpriced Deployment is **excluded from routing** rather than
scheduled at an unknown cost.

#### Free Providers

Some upstreams have no per-token price to look up at all: a flat-rate
subscription, or an account whose usage simply never bills. models.dev lists
Ollama Cloud's models with no `cost` field, for instance, so no slug can price
them.

Set the Provider's `costMultiplier` to exactly **0** to declare it free. A zero
multiplier already means "whatever the list price is, we pay 0" — this extends
that to Deployments that have no list price, resolving them to 0 instead of to
unknown. Such Deployments stay routable, cost 0, and therefore sort **ahead of
every priced Deployment**, so a free Provider is consumed first and the paid
ones act as its fallback.

Note the flip side: a zero multiplier sends all matching traffic to that
Provider first. If its upstream enforces its own quota or rate limit, that is
where the traffic will pile up.

### Provider Cost Limits

Each Provider can carry a hard spend ceiling:

| Field | Meaning |
|-------|---------|
| `dailyCostLimitUsd` | Max spend per UTC day. `null` = unlimited. |
| `monthlyCostLimitUsd` | Max spend per UTC calendar month. `null` = unlimited. |

When either window is reached, **every** Deployment of that Provider leaves the
candidate set — the allowance is account-level, not per-model. A request with no
remaining candidates gets **HTTP 503** carrying the Provider, the current spend,
the effective limit and the next UTC reset.

The *effective* limit is lower than the configured one while requests are in
flight, because their cost is not known until they finish. Each in-flight
request reserves `output rate × 4096 tokens` of headroom, which is released when
it completes. The dashboard shows both numbers.

Windows are fixed UTC — the daily window rolls at 00:00 UTC and the monthly one
at 00:00 UTC on the 1st. There is no alerting threshold and no temporary bypass.

### Cloudflare Workers AI

Verified end-to-end against a live Cloudflare account on 2026-08-21: a real
request through AIGate returned HTTP 200, sync discovered 25 Deployments, and
the recorded cost matched the hand-computed cost exactly.

Cloudflare Workers AI is configured as a plain OpenAI-compatible Provider — no
dedicated provider type:

| Field | Value |
|-------|-------|
| `type` | `openai-compatible` |
| `apiFormat` | `openai` |
| `endpoint` | `https://api.cloudflare.com/client/v4/accounts/{account_id}/ai` |
| `modelsDevSlug` | `cloudflare-workers-ai` |
| `apiKey` | a Cloudflare API token with Workers AI permissions |
| `dailyCostLimitUsd` | e.g. `0.11` (the free daily allowance — see below) |

**Send the canonical model name, not Cloudflare's id.** This is the single most
common way to get a 404 from AIGate. Canonicalisation keeps the `@cf/` prefix
(it is not a stripped provider prefix) but rewrites version dots to dashes, so
for `@cf/meta/llama-3.2-1b-instruct` the two names are:

| | Value |
|---|---|
| What clients send AIGate (`canonical`) | `@cf/meta/llama-3-2-1b-instruct` |
| What AIGate sends Cloudflare (`upstream`) | `@cf/meta/llama-3.2-1b-instruct` |

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer $AIGATE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"@cf/meta/llama-3-2-1b-instruct",
       "messages":[{"role":"user","content":"hi"}]}'
```

Neither `@cf/meta/llama-3.2-1b-instruct` (dots) nor `llama-3.2-1b-instruct`
(prefix dropped) will resolve. The `upstream` id keeps its original dots and is
what actually goes to Cloudflare.

**Free daily allowance.** Cloudflare grants 10,000 neurons/day ≈ **$0.11**. It
resets at 00:00 UTC and does **not** roll over. Setting
`dailyCostLimitUsd = 0.11` stops AIGate scheduling this Provider once the free
allowance is spent; leaving it empty means "keep going and pay Cloudflare's
rates".

Notes:

- The `endpoint` must **not** end in `/v1` — the outbound adapter appends
  `/v1/chat/completions` itself. models.dev lists the `api` field as
  `.../ai/v1`; do not copy that value verbatim.
- Cloudflare's OpenAI-compatible surface has no `GET /v1/models` — it answers
  **405**, so sync falls back to the configured models.dev slug. The observed
  sync log line is:

  ```
  /v1/models failed (/models returned 405), falling back to models.dev [cloudflare-workers-ai]
  ```

- models.dev lists 25 Workers AI models. Cloudflare serves more than that;
  models it does not list are **unpriced and therefore not routed**, rather than
  being scheduled at an unknown price.
- Prices are recorded in USD from models.dev. AIGate does not maintain a neuron
  price table. Measured: 18 input + 2 output tokens on
  `@cf/meta/llama-3-2-1b-instruct` at $0.027 / $0.201 per 1M = **$8.88e-07**,
  which is exactly what was recorded.
- Cloudflare also reports `usage.neurons` and a `cf-ai-neurons` response header.
  AIGate does not consume either today — cost comes from the models.dev rates.

### Streaming Format Conversion

| Upstream → Client | Status |
|-------------------|--------|
| OpenAI → OpenAI | Pass-through |
| OpenAI → Anthropic | Supported |
| Gemini → OpenAI | Supported |
| Others | Returns 501 error |

## Benchmark Charts

The dashboard includes a benchmark vs price scatter chart powered by [Artificial Analysis](https://artificialanalysis.ai). This is optional — the dashboard works fine without it, and you'll see a prompt on the Overview page when it's not configured.

To enable it:

1. Get an API key from [artificialanalysis.ai](https://artificialanalysis.ai)
2. Add the environment variable to your container:

**Docker:**

```bash
docker run -d \
  --name aigate \
  -p 3000:3000 \
  -e ADMIN_TOKEN=your-secret-token \
  -e ARTIFICIAL_ANALYSIS_API_TOKEN=your-aa-token \
  -v aigate-data:/app/packages/gateway/data \
  ghcr.io/broven/aigate:latest
```

**Docker Compose** — add to your `environment` section:

```yaml
    environment:
      - ADMIN_TOKEN=your-secret-token
      - ARTIFICIAL_ANALYSIS_API_TOKEN=your-aa-token
```

Benchmark data is cached for 24 hours to minimize API calls.

## Architecture

```
packages/
  gateway/    # Hono API server (Bun runtime)
  dashboard/  # React SPA (Vite)
  shared/     # Shared types
```

## License

MIT
