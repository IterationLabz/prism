import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve, join } from 'path'
import * as fs from 'fs'

const wasmPlugin = () => {
  return {
    name: 'wasm-plugin',
    configureServer(server: any) {
      server.middlewares.use('/wasm/', (req: any, res: any, next: any) => {
        if (req.url) {
          const filePath = join(__dirname, 'src/renderer/public/wasm', req.url.split('?')[0])
          if (fs.existsSync(filePath)) {
            if (filePath.endsWith('.mjs')) {
              res.setHeader('Content-Type', 'application/javascript')
            } else if (filePath.endsWith('.wasm')) {
              res.setHeader('Content-Type', 'application/wasm')
            }
            res.end(fs.readFileSync(filePath))
            return
          }
        }
        next()
      })
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload.ts') }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), wasmPlugin()],
    worker: { format: 'es' },
    optimizeDeps: {
      exclude: ['@huggingface/transformers', 'kokoro-js', 'onnxruntime-web']
    }
  }
})
