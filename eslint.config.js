import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['dist/', 'coverage/', 'src/generated/', 'node_modules/', 'web/'] },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      'no-console': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'Math.random não é criptograficamente seguro. Use node:crypto.',
        },
      ],
    },
  },
  {
    // Fronteira de anonimato: a urna não pode conhecer eleitores nem a emissão de tokens.
    files: ['src/modules/ballot-box/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // Casa imports relativos e absolutos: '../voter/x.js', '../../modules/authorization'...
              regex: '(^|/)(voter|authorization)(/|$)',
              message:
                'ballot-box não pode depender de voter/authorization (separação eleitor ↔ voto).',
            },
          ],
        },
      ],
    },
  },
  { files: ['**/*.js'], extends: [tseslint.configs.disableTypeChecked] },
  prettier,
);
