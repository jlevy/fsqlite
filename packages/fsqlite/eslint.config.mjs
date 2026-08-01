import tseslint from 'typescript-eslint'

// Type-aware ESLint flat config for `fsqlite`. This is authored-from-scratch, zero-runtime-dep
// code held to the full strict bar — the `no-unsafe-*` family stays ON (no relaxations).
// Source, tests, workers, and examples are all linted; the tsconfig covers them.

const withProject = (cfg) => ({
  ...cfg,
  files: ['**/*.ts'],
  languageOptions: {
    ...(cfg.languageOptions ?? {}),
    parserOptions: {
      ...(cfg.languageOptions?.parserOptions ?? {}),
      project: ['./tsconfig.json'],
      tsconfigRootDir: import.meta.dirname,
    },
  },
})

export default [
  { ignores: ['node_modules/**', 'dist/**', 'eslint.config.*', 'tsdown.config.*', 'scripts/**'] },
  ...tseslint.configs.recommendedTypeChecked.map(withProject),
  ...tseslint.configs.stylisticTypeChecked.map(withProject),
  {
    files: ['**/*.ts'],
    rules: {
      curly: ['error', 'multi-line'],
      'brace-style': ['error', '1tbs', { allowSingleLine: true }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'error',

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-confusing-void-expression': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports', disallowTypeAnnotations: true },
      ],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',

      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSImportType',
          message: 'Inline import() type expressions are not allowed. Use a top-of-file import statement.',
        },
        {
          selector: 'ImportExpression',
          message: 'Dynamic import() is not allowed. Use a static top-of-file import.',
        },
        {
          selector: 'TSPropertySignature[optional=true] > TSTypeAnnotation > TSBooleanKeyword',
          message: 'Avoid optional booleans (`foo?: boolean`). Use `foo: boolean` or `foo: boolean | null`.',
        },
      ],
    },
  },
  // The CLI, the runnable examples, and the child-process workers print to stdout/stderr by
  // design; the test spawn helper streams child output too.
  {
    files: ['src/cli/**/*.ts', 'examples/**/*.ts', 'workers/**/*.ts', 'test/spawn.ts', 'test/cli-golden/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  // Tests: empty stub callbacks are idiomatic; node:test's `test()` is fire-and-forget by
  // design (the runner tracks each case), so its top-level calls are not floating bugs.
  {
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
]
