import { Hono } from 'hono'

const app = new Hono()

app.post('/verify', (c) => {
  const adminToken = process.env.ADMIN_TOKEN
  if (!adminToken) {
    return c.json({ error: { message: 'ADMIN_TOKEN not configured' } }, 503)
  }

  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: { message: 'Unauthorized' } }, 401)
  }

  const token = authHeader.slice(7)
  if (token !== adminToken) {
    return c.json({ error: { message: 'Invalid admin token' } }, 401)
  }

  return c.json({ ok: true })
})

export default app
