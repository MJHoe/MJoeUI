import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const BACKEND = 'http://127.0.0.1:3030';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api/ws': { target: BACKEND.replace('http', 'ws'), ws: true },
      '/api': { target: BACKEND, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // local tool: one vendor bundle is fine, CodeMirror is already split out
    chunkSizeWarningLimit: 800,
  },
});
