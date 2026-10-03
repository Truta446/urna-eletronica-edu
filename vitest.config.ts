import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/helpers/global-setup.ts'],
    // Os testes de integração compartilham um único banco real; rodar arquivos em série
    // evita que a limpeza de um arquivo interfira em outro.
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
