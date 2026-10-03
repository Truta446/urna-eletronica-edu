import { defineConfig, devices } from '@playwright/test';

/** Sobe backend (:3000) e front (:5173) se ainda não estiverem rodando. */
export default defineConfig({
  testDir: 'e2e',
  timeout: 180_000,
  // Os testes compartilham o backend (e o rate limit): um de cada vez.
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:5173', ...devices['Desktop Chrome'] },
  webServer: [
    {
      command: 'npm --prefix .. run dev',
      url: 'http://127.0.0.1:3000/health',
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: 'npm run dev',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
