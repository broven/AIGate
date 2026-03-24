import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { gatewayAuth } from './middleware/auth'
import { adminAuth } from './middleware/admin-auth'
import authApi from './api/auth'
import { parseOpenAIRequest, formatOpenAIResponse, formatOpenAIError } from './adapters/inbound/openai'
import { parseAnthropicRequest, formatAnthropicResponse, formatAnthropicError } from './adapters/inbound/anthropic'
import { parseGeminiRequest, formatGeminiResponse, formatGeminiError } from './adapters/inbound/gemini'
import { routeRequest } from './router/price-router'
import { logRequest } from './logging/request-logger'
import { extractUsageFromStream } from './logging/stream-usage-extractor'
import { initLlmsBridge, getTransformer, buildContext } from './adapters/llms-bridge'
import type { ApiFormat } from './adapters/registry'
import statsApi from './api/stats'
import providersApi from './api/providers'
import keysApi from './api/keys'
import modelsApi from './api/models'
import benchmarksApi from './api/benchmarks'
import { startSyncScheduler } from './sync/engine'
import { canonicalize } from './sync/canonicalize'

// Run migrations on startup
import './db/migrate'

// Require ADMIN_TOKEN to be set
if (!process.env.ADMIN_TOKEN) {
  console.error('\x1b[31m[ERROR] ADMIN_TOKEN environment variable is not set.\x1b[0m')
  console.error('Set ADMIN_TOKEN to secure the dashboard:')
  console.error('  ADMIN_TOKEN=your-secret-token bun run src/index.ts')
  console.error('  docker run -e ADMIN_TOKEN=your-secret-token ...')
  process.exit(1)
}

const app = new Hono()

// Global middleware
app.use('*', cors())
app.use('*', logger())

// Dashboard API (protected by admin token)
app.use('/api/*', adminAuth)
app.route('/api/auth', authApi)
app.route('/api', statsApi)
app.route('/api/providers', providersApi)
app.route('/api/keys', keysApi)
app.route('/api/models', modelsApi)
app.route('/api', benchmarksApi)

// --- Shared LLM request handler ---
interface RequestHandler {
  parseRequest: (body: any, gatewayKeyName: string, ...extra: any[]) => any
  formatResponse: (resp: any) => any
  formatError: (message: string, type: string, code?: string | number) => any
  sourceFormat: 'openai' | 'gemini' | 'claude'
}

// Only these headers are safe to forward from clients to upstream providers.
// Auth headers (authorization, x-api-key, x-goog-api-key, api-key, cookie, proxy-authorization)
// and provider-specific control headers (anthropic-beta, openai-organization) are intentionally
// excluded to prevent credential smuggling and provider-specific behavior leakage.
const ALLOWED_CLIENT_HEADERS = new Set([
  'accept',
  'user-agent',
  'x-request-id',
])

function extractClientHeaders(c: any): Record<string, string> {
  const headers: Record<string, string> = {}
  const raw = c.req.raw.headers as Headers
  raw.forEach((value: string, key: string) => {
    if (ALLOWED_CLIENT_HEADERS.has(key.toLowerCase())) {
      headers[key.toLowerCase()] = value
    }
  })
  return headers
}

async function handleLLMRequest(
  c: any,
  handler: RequestHandler,
  ...parseExtra: any[]
) {
  const body = await c.req.json()
  const gatewayKeyName = c.get('gatewayKeyName')
  const clientHeaders = extractClientHeaders(c)

  let universalReq
  try {
    universalReq = await handler.parseRequest(body, gatewayKeyName, ...parseExtra)
    universalReq.model = canonicalize(universalReq.model)
    universalReq.clientHeaders = clientHeaders
  } catch (error) {
    return c.json(
      handler.formatError(
        error instanceof Error ? error.message : 'Invalid request',
        'invalid_request_error',
        'invalid_request',
      ),
      400,
    )
  }

  let routeResult
  try {
    routeResult = await routeRequest(universalReq)
  } catch (error) {
    return c.json(
      handler.formatError(
        error instanceof Error ? error.message : 'Internal routing error',
        'server_error',
        'internal_error',
      ),
      500,
    )
  }

  // All providers failed
  if (!routeResult.finalProvider) {
    logRequest({
      requestId: universalReq.id,
      model: universalReq.model,
      gatewayKey: gatewayKeyName,
      sourceFormat: handler.sourceFormat,
      routeResult,
    })

    return c.json(
      handler.formatError(
        `All providers failed for model ${universalReq.model}. Attempts: ${routeResult.attempts.length}`,
        'server_error',
        'all_providers_failed',
      ),
      502,
    )
  }

  // Streaming response
  if (routeResult.streamResponse) {
    const upstreamFormat = routeResult.upstreamFormat ?? 'openai'

    // Extract usage from the raw upstream stream BEFORE any format transformation
    const { passthrough, usage: usagePromise } = extractUsageFromStream(
      routeResult.streamResponse.body!,
      upstreamFormat,
    )

    // Build a new Response with the passthrough stream
    let streamResponse = new Response(passthrough, {
      status: routeResult.streamResponse.status,
      headers: routeResult.streamResponse.headers,
    })

    // Transform stream if client format differs from upstream format
    if (handler.sourceFormat !== upstreamFormat) {
      streamResponse = await transformStreamFormat(
        streamResponse,
        upstreamFormat,
        handler.sourceFormat,
        universalReq.model,
      )

      // If stream transformation returned an error (non-200), propagate it directly
      if (!streamResponse.ok) {
        return streamResponse
      }
    }

    // Log after stream completes (fire-and-forget)
    usagePromise.then((streamUsage) => {
      logRequest({
        requestId: universalReq.id,
        model: universalReq.model,
        gatewayKey: gatewayKeyName,
        sourceFormat: handler.sourceFormat,
        routeResult,
        response: streamUsage ? {
          id: '',
          model: universalReq.model,
          content: '',
          finishReason: 'stop',
          usage: streamUsage,
        } : undefined,
      })
    }).catch((err) => {
      console.error('Stream usage extraction failed:', err)
      logRequest({
        requestId: universalReq.id,
        model: universalReq.model,
        gatewayKey: gatewayKeyName,
        sourceFormat: handler.sourceFormat,
        routeResult,
      })
    })

    return new Response(streamResponse.body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  }

  // Non-streaming response
  const response = routeResult.response!

  logRequest({
    requestId: universalReq.id,
    model: universalReq.model,
    gatewayKey: gatewayKeyName,
    sourceFormat: handler.sourceFormat,
    routeResult,
    response,
  })

  return c.json(handler.formatResponse(response))
}

// --- OpenAI-compatible proxy endpoint ---
app.post('/v1/chat/completions', gatewayAuth, (c) =>
  handleLLMRequest(c, {
    parseRequest: parseOpenAIRequest,
    formatResponse: (resp) =>
      formatOpenAIResponse(resp.id, resp.model, resp.content, resp.finishReason, resp.toolCalls, resp.usage),
    formatError: formatOpenAIError,
    sourceFormat: 'openai',
  }),
)

// --- Anthropic Messages API endpoint ---
app.post('/v1/messages', gatewayAuth, (c) =>
  handleLLMRequest(c, {
    parseRequest: parseAnthropicRequest,
    formatResponse: formatAnthropicResponse,
    formatError: formatAnthropicError,
    sourceFormat: 'claude',
  }),
)

// --- Gemini API endpoint ---
app.post('/v1beta/models/:modelAction', gatewayAuth, (c) => {
  const modelAction = c.req.param('modelAction')
  // Parse "gemini-pro:generateContent" or "gemini-pro:streamGenerateContent"
  const colonIdx = modelAction.lastIndexOf(':')
  const modelName = colonIdx > 0 ? modelAction.slice(0, colonIdx) : modelAction
  const action = colonIdx > 0 ? modelAction.slice(colonIdx + 1) : 'generateContent'
  const isStream = action.startsWith('streamGenerateContent')

  return handleLLMRequest(
    c,
    {
      parseRequest: (body: any, keyName: string, model: string, stream: boolean) =>
        parseGeminiRequest(body, keyName, model, stream),
      formatResponse: formatGeminiResponse,
      formatError: formatGeminiError,
      sourceFormat: 'gemini',
    },
    modelName,
    isStream,
  )
})

// OpenAI models endpoint (for client compatibility)
app.get('/v1/models', gatewayAuth, async (c) => {
  const { db, schema } = await import('./db')
  const { eq } = await import('drizzle-orm')

  const deployments = await db
    .select({ canonical: schema.modelDeployments.canonical })
    .from(schema.modelDeployments)
    .where(eq(schema.modelDeployments.status, 'active'))

  // Exclude blacklisted models
  const blacklisted = await db
    .select({ canonical: schema.modelPreferences.canonical })
    .from(schema.modelPreferences)
    .where(eq(schema.modelPreferences.preference, 'blacklist'))
  const blackSet = new Set(blacklisted.map((r) => r.canonical))

  // Deduplicate canonical names, excluding blacklisted
  const models = [...new Set(deployments.map((d) => d.canonical))]
    .filter((c) => !blackSet.has(c))

  return c.json({
    object: 'list',
    data: models.map((id) => ({
      id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'aigate',
    })),
  })
})

// Serve static dashboard in production
app.get('/*', async (c) => {
  const path = c.req.path === '/' ? '/index.html' : c.req.path
  const file = Bun.file(`./dashboard${path}`)
  if (await file.exists()) {
    return new Response(file, {
      headers: file.type ? { 'Content-Type': file.type } : undefined,
    })
  }
  // SPA fallback
  const index = Bun.file('./dashboard/index.html')
  if (await index.exists()) {
    return new Response(index, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  }
  return c.json({ error: { message: 'Not found' } }, 404)
})

/**
 * Transform a streaming response from one API format to another using llms transformers.
 *
 * Supported conversions:
 * - openai → claude: AnthropicTransformer.transformResponseIn (OpenAI SSE → Anthropic SSE)
 * - openai → gemini: GeminiTransformer handles this but not yet implemented
 * - claude → openai: Not yet implemented (would need Anthropic SSE → OpenAI SSE)
 * - gemini → openai: GeminiTransformer.transformResponseOut (Gemini → OpenAI)
 */
async function transformStreamFormat(
  response: Response,
  fromFormat: ApiFormat,
  toFormat: ApiFormat,
  model: string,
): Promise<Response> {
  // OpenAI upstream → Anthropic client (most common: Claude Code + OpenAI-compat provider)
  if (fromFormat === 'openai' && toFormat === 'claude') {
    const transformer = getTransformer('Anthropic')
    if (transformer.transformResponseIn) {
      const ctx = buildContext({ stream: true, model })
      return await transformer.transformResponseIn(response, ctx)
    }
  }

  // Gemini upstream → OpenAI client
  if (fromFormat === 'gemini' && toFormat === 'openai') {
    const transformer = getTransformer('gemini')
    if (transformer.transformResponseOut) {
      return await transformer.transformResponseOut(response)
    }
  }

  // Unsupported conversion — return error response instead of corrupted stream
  const errorBody = JSON.stringify({
    error: { message: `Streaming format conversion from ${fromFormat} to ${toFormat} is not yet supported`, type: 'server_error' },
  })
  return new Response(errorBody, {
    status: 501,
    headers: { 'Content-Type': 'application/json' },
  })
}

const port = parseInt(process.env.PORT || '3000', 10)
const host = process.env.HOST || '127.0.0.1'

// Initialize llms bridge for format conversion (synchronous — must complete before server accepts requests)
initLlmsBridge()
console.log('llms TransformerService initialized')

console.log(`AIGate starting on http://${host}:${port}`)

// Start sync scheduler
startSyncScheduler()

export default {
  port,
  hostname: host,
  fetch: app.fetch,
  idleTimeout: 120, // seconds — sync can take a while creating group tokens
}
