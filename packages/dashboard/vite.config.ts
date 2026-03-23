import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

const rootEnv = loadEnv('', '../..', 'PORT')
const gatewayPort = parseInt(rootEnv.PORT || process.env.PORT || '3000', 10)
const vitePort = gatewayPort + 1000

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(process.env.APP_VERSION || 'dev'),
  },
  server: {
    port: vitePort,
    proxy: {
      '/api': {
        target: `http://localhost:${gatewayPort}`,
        changeOrigin: true,
      },
    },
  },
})
