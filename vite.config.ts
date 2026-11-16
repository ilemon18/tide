import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const host = process.env.TAURI_DEV_HOST

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Tauri expects a fixed port; don't auto-switch ports in dev
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    // Tauri uses WKWebView on macOS, so align with the Safari version
    target: 'safari15',
    minify: 'oxc',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // Language packs aren't grouped manually: let Vite split them by dynamic import into their own chunks,
        // so opening a .rs file only downloads the rust pack instead of every pack.
        manualChunks(id) {
          if (id.includes('@xterm')) return 'xterm'
          if (id.includes('@codemirror') && !id.includes('/lang-') && !id.includes('legacy-modes'))
            return 'codemirror'
        },
      },
    },
  },
})