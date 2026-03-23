import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// Discover gateway port from portless routes (direct port, not via proxy)
let gatewayPort = parseInt(process.env.PORT || '3000', 10)
try {
  const routes = JSON.parse(readFileSync(join(homedir(), '.portless/routes.json'), 'utf-8'))
  const gw = routes.find((r: any) => r.hostname === 'gw.aigate.localhost')
  if (gw) gatewayPort = gw.port
} catch {
  // portless not running, fall back to PORT env or default
}

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(process.env.APP_VERSION || 'dev'),
  },
  server: {
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${gatewayPort}`,
        changeOrigin: true,
      },
    },
  },
})
