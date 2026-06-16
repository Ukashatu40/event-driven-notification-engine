// eslint.config.mjs
// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs', 'scripts/**', 'tests/load/**', 'data/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      // ── Explicitly off ─────────────────────────────────────────────────────
      // Interface implementation methods must match async signature even if
      // no await is needed in the stub — turning this off is correct
      '@typescript-eslint/require-await': 'off',

      // Infrastructure adapters (Redis, Kafka, RabbitMQ, providers) deal with
      // JSON/unknown payloads from external libraries — unsafe-* rules produce
      // false positives throughout these files
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',

      // Dynamic routing keys and template literals with unknown types
      '@typescript-eslint/restrict-template-expressions': 'off',

      // Provider response fields come back as unknown from fetch()
      '@typescript-eslint/no-base-to-string': 'off',

      // require() is used in seed scripts for dotenv bootstrap ordering
      '@typescript-eslint/no-require-imports': 'off',

      // False positives with try/catch reassignment patterns
      'no-useless-assignment': 'off',

      // ── Downgraded to warn ──────────────────────────────────────────────────
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/unbound-method': 'warn',

      // Fastify + RabbitMQ consume callback patterns trigger this incorrectly
      '@typescript-eslint/no-misused-promises': [
        'warn',
        { checksVoidReturn: { arguments: false } },
      ],

      // ── Kept as error ───────────────────────────────────────────────────────
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      'prettier/prettier': ['error', { endOfLine: 'auto' }],
    },
  },
);
