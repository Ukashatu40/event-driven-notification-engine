// .eslintrc.js
module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: 'tsconfig.json',
    tsconfigRootDir: __dirname,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint/eslint-plugin'],
  extends: [
    'plugin:@typescript-eslint/recommended',
    'plugin:prettier/recommended',
  ],
  root: true,
  env: {
    node: true,
    jest: true,
  },
  ignorePatterns: ['.eslintrc.js'],
  rules: {
    // Interface implementation methods must match signature even if async not needed yet
    '@typescript-eslint/require-await': 'off',
    // Infrastructure adapters deal with JSON/unknown types from external libraries
    '@typescript-eslint/no-unsafe-assignment': 'warn',
    '@typescript-eslint/no-unsafe-member-access': 'warn',
    '@typescript-eslint/no-unsafe-call': 'warn',
    '@typescript-eslint/no-unsafe-argument': 'warn',
    '@typescript-eslint/no-unsafe-return': 'warn',
    // Template literal restriction too aggressive for dynamic routing keys
    '@typescript-eslint/restrict-template-expressions': 'off',
    // no-base-to-string: we handle String() casts explicitly
    '@typescript-eslint/no-base-to-string': 'off',
    // unbound-method: handled via arrow functions in most places
    '@typescript-eslint/unbound-method': 'warn',
    // no-misused-promises: Fastify reply patterns trigger this incorrectly
    '@typescript-eslint/no-misused-promises': [
      'error',
      { checksVoidReturn: { arguments: false } },
    ],
    // Standard rules
    '@typescript-eslint/interface-name-prefix': 'off',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-unused-vars': [
      'error',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      },
    ],
    // Allow require() in scripts (seed, generate-datasets etc.)
    '@typescript-eslint/no-require-imports': 'off',
    // no-useless-assignment — disable, false positives with try/catch patterns
    'no-useless-assignment': 'off',
  },
};
