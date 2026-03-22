# AIGate

Intelligent LLM API gateway with automatic provider fallback, price-based routing, and usage tracking.

## Features

- **OpenAI-compatible API** — drop-in replacement, works with any OpenAI SDK
- **Multi-provider routing** — automatic fallback chain across providers
- **Price-based routing** — routes to the cheapest available provider
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

Point your OpenAI SDK at AIGate:

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

AIGate routes to the cheapest available provider, with automatic fallback if a provider fails.

## Architecture

```
packages/
  gateway/    # Hono API server (Bun runtime)
  dashboard/  # React SPA (Vite)
  shared/     # Shared types
```

## License

MIT
