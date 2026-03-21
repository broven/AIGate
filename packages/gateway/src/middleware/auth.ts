import { createMiddleware } from 'hono/factory'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db'
import { hashKey } from '../utils'

export const gatewayAuth = createMiddleware<{
  Variables: { gatewayKeyName: string }
}>(async (c, next) => {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: { message: 'Missing or invalid Authorization header', type: 'invalid_request_error', code: 'invalid_api_key' } }, 401)
  }

  const token = authHeader.slice(7)
  const hashed = hashKey(token)

  const keyRow = await db
    .select({ name: schema.gatewayKeys.name })
    .from(schema.gatewayKeys)
    .where(eq(schema.gatewayKeys.keyHash, hashed))
    .limit(1)

  if (keyRow.length === 0) {
    return c.json({ error: { message: 'Invalid API key', type: 'invalid_request_error', code: 'invalid_api_key' } }, 401)
  }

  c.set('gatewayKeyName', keyRow[0]!.name)
  await next()
})
