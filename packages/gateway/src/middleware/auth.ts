import { createMiddleware } from 'hono/factory'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db'

export const gatewayAuth = createMiddleware<{
  Variables: { gatewayKeyName: string }
}>(async (c, next) => {
  const authHeader = c.req.header('Authorization')
  const xApiKey = c.req.header('x-api-key')

  let token: string | undefined
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7)
  } else if (xApiKey) {
    token = xApiKey
  }

  if (!token) {
    return c.json({ error: { message: 'Missing API key. Provide via Authorization: Bearer <key> or x-api-key header.', type: 'invalid_request_error', code: 'invalid_api_key' } }, 401)
  }

  const keyRow = await db
    .select({ name: schema.gatewayKeys.name })
    .from(schema.gatewayKeys)
    .where(eq(schema.gatewayKeys.keyPlain, token))
    .limit(1)

  if (keyRow.length === 0) {
    return c.json({ error: { message: 'Invalid API key', type: 'invalid_request_error', code: 'invalid_api_key' } }, 401)
  }

  c.set('gatewayKeyName', keyRow[0]!.name)
  await next()
})
