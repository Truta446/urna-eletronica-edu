import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * O front conversa com a API pelo proxy do Vite (/api -> :3000). Mesma origem para o browser:
 * o backend não precisa (e não tem) CORS. API_TARGET=http://127.0.0.1:3010 aponta para o backend
 * em Rust (mesmo contrato HTTP).
 */
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.API_TARGET ?? 'http://127.0.0.1:3000',
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
