import { defineConfig, devices } from '@playwright/test';

const api = process.env.API_TARGET ?? 'http://127.0.0.1:3000';
const rust = api.endsWith(':3010');

/**
 * Sobe backend e front (:5173) se ainda não estiverem rodando.
 * API_TARGET=http://127.0.0.1:3010 roda o mesmo e2e contra o backend em Rust.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 180_000,
  // Os testes compartilham o backend (e o rate limit): um de cada vez.
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:5173', ...devices['Desktop Chrome'] },
  webServer: [
    {
      command: rust
        ? 'npm --prefix .. run rust:build && npm --prefix .. run rust:start'
        : 'npm --prefix .. run dev',
      url: `${api}/health`,
      reuseExistingServer: true,
      timeout: 300_000,
    },
    {
      command: 'npm run dev',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
