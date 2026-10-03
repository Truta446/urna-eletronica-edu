import { defineConfig } from 'vitest/config';

/**
 * Suíte de CONTRATO: os mesmos testes, via HTTP, contra a API TypeScript e a API Rust.
 * Uso: npm run test:contract
 */
export default defineConfig({
  test: {
    include: ['test/contract/**/*.contract.ts'],
    globalSetup: ['test/contract/servers.ts'],
    testTimeout: 90_000,
    hookTimeout: 180_000,
  },
});
