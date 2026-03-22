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
  -p 3000:3000 \
  -v aigate-data:/app/packages/gateway/data \
  ghcr.io/broven/aigate:latest
```

Open `http://localhost:3000` to access the dashboard.

### Docker Compose

```yaml
services:
  aigate:
    image: ghcr.io/broven/aigate:latest
    ports:
      - "3000:3000"
    volumes:
      - aigate-data:/app/packages/gateway/data

volumes:
  aigate-data:
```

### From source

```bash
pnpm install
pnpm dev
```

## Configuration

All configuration is via environment variables. Everything has sensible defaults — zero config required.

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `HOST` | `0.0.0.0` (Docker) / `127.0.0.1` (local) | Bind address |
| `DATABASE_URL` | `./data/aigate.db` | SQLite database path |

Data is stored in a single SQLite file. The database and tables are created automatically on first start.

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

### Streaming Format Conversion

| Upstream → Client | Status |
|-------------------|--------|
| OpenAI → OpenAI | Pass-through |
| OpenAI → Anthropic | Supported |
| Gemini → OpenAI | Supported |
| Others | Returns 501 error |

## Architecture

```
packages/
  gateway/    # Hono API server (Bun runtime)
  dashboard/  # React SPA (Vite)
  shared/     # Shared types
```

## License

MIT
