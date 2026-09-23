import tailwindcss from '@tailwindcss/vite'
import type { AddressInfo } from 'node:net'
import { defineConfig, type Plugin, type PreviewServer, type ViteDevServer } from 'vite'
import { hermesApi } from './server/hermes-api.ts'

const PORT = 5178

// Loopback only: the /api routes run `hermes cron` commands on this machine.
// strictPort: false lets Vite move to the next free port when PORT is taken.
const server = { host: '127.0.0.1', port: PORT, strictPort: false }

/** Say plainly when the preferred port was busy and which one we ended up on. */
function reportPortFallback(): Plugin {
  const watch = (s: ViteDevServer | PreviewServer) => {
    const http = s.httpServer
    http?.once('listening', () => {
      const { port } = http.address() as AddressInfo
      if (port !== PORT) s.config.logger.warn(`\n  Port ${PORT} was busy, so Hermes Cron is running on port ${port} instead.`)
    })
  }
  return { name: 'report-port-fallback', configureServer: watch, configurePreviewServer: watch }
}

export default defineConfig({
  plugins: [tailwindcss(), hermesApi(), reportPortFallback()],
  server,
  preview: server,
})
