import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { gatewayAuth } from './middleware/auth'
import { adminAuth } from './middleware/admin-auth'
import authApi from './api/auth'
import { parseOpenAIRequest, formatOpenAIResponse, formatOpenAIError } from './adapters/inbound/openai'
import { routeRequest } from './router/price-router'
import { logRequest } from './logging/request-logger'
import statsApi from './api/stats'
import providersApi from './api/providers'
import keysApi from './api/keys'
import modelsApi from './api/models'
import { startSyncScheduler } from './sync/engine'

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

// OpenAI-compatible proxy endpoint (requires gateway auth)
app.post('/v1/chat/completions', gatewayAuth, async (c) => {
  const body = await c.req.json()
  const gatewayKeyName = c.get('gatewayKeyName')

  let universalReq
  try {
    universalReq = parseOpenAIRequest(body, gatewayKeyName)
  } catch (error) {
    return c.json(
      formatOpenAIError(
        error instanceof Error ? error.message : 'Invalid request',
        'invalid_request_error',
        'invalid_request',
      ),
      400,
    )
  }

  const routeResult = await routeRequest(universalReq)

  // All providers failed
  if (!routeResult.finalProvider) {
    // Log the failed request
    logRequest({
      requestId: universalReq.id,
      model: universalReq.model,
      gatewayKey: gatewayKeyName,
      sourceFormat: 'openai',
      routeResult,
    })

    return c.json(
      formatOpenAIError(
        `All providers failed for model ${universalReq.model}. Attempts: ${routeResult.attempts.length}`,
        'server_error',
        'all_providers_failed',
      ),
      502,
    )
  }

  // Streaming response
  if (routeResult.streamResponse) {
    // Log without token counts (streaming — we don't know yet)
    logRequest({
      requestId: universalReq.id,
      model: universalReq.model,
      gatewayKey: gatewayKeyName,
      sourceFormat: 'openai',
      routeResult,
    })

    // Pipe through the upstream SSE stream
    return new Response(routeResult.streamResponse.body, {
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

  // Log with token counts
  logRequest({
    requestId: universalReq.id,
    model: universalReq.model,
    gatewayKey: gatewayKeyName,
    sourceFormat: 'openai',
    routeResult,
    response,
  })

  return c.json(
    formatOpenAIResponse(
      universalReq.id,
      universalReq.model,
      response.content,
      response.finishReason,
      response.toolCalls,
      response.usage,
    ),
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

  // Deduplicate canonical names
  const models = [...new Set(deployments.map((d) => d.canonical))]

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
    return new Response(file)
  }
  // SPA fallback
  const index = Bun.file('./dashboard/index.html')
  if (await index.exists()) {
    return new Response(index)
  }
  return c.json({ error: { message: 'Not found' } }, 404)
})

const port = parseInt(process.env.PORT || '3000', 10)
const host = process.env.HOST || '127.0.0.1'

console.log(`AIGate starting on http://${host}:${port}`)

// Start sync scheduler
startSyncScheduler()

export default {
  port,
  hostname: host,
  fetch: app.fetch,
  idleTimeout: 120, // seconds — sync can take a while creating group tokens
}
