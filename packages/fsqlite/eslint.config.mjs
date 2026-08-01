import js from '@eslint/js'
import eslintConfigPrettier from 'eslint-config-prettier/flat'
import tseslint from 'typescript-eslint'

// Type-aware ESLint flat config for `fsqlite`. This is authored-from-scratch, zero-runtime-dep
// code held to the full strict bar — the `no-unsafe-*` family stays ON (no relaxations).
// Source, tests, workers, and examples are all linted; the tsconfig covers them.

const typedFiles = ['**/*.ts', 'scripts/**/*.mjs']

const withProject = (cfg) => ({
  ...cfg,
  files: typedFiles,
  languageOptions: {
    ...(cfg.languageOptions ?? {}),
    parserOptions: {
      ...(cfg.languageOptions?.parserOptions ?? {}),
      projectService: true,
      tsconfigRootDir: import.meta.dirname,
    },
  },
})

export default [
  { ignores: ['node_modules/**', 'dist/**'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked.map(withProject),
  ...tseslint.configs.stylisticTypeChecked.map(withProject),
  // Turn off formatting rules before the project rules below, so Prettier owns layout
  // without weakening any of the correctness-bearing lint floor.
  eslintConfigPrettier,
  {
    files: typedFiles,
    rules: {
      curly: ['error', 'all'],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'error',

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-confusing-void-expression': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'separate-type-imports',
          disallowTypeAnnotations: true,
        },
      ],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
      '@typescript-eslint/no-non-null-assertion': 'off',

      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSImportType',
          message:
            'Inline import() type expressions are not allowed. Use a top-of-file import statement.',
        },
        {
          selector: 'ImportExpression',
          message: 'Dynamic import() is not allowed. Use a static top-of-file import.',
        },
        {
          selector: 'TSPropertySignature[optional=true] > TSTypeAnnotation > TSBooleanKeyword',
          message:
            'Avoid optional booleans (`foo?: boolean`). Use `foo: boolean` or `foo: boolean | null`.',
        },
      ],
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
      },
    },
    rules: { 'no-console': 'off' },
  },
  // The CLI, the runnable examples, and the child-process workers print to stdout/stderr by
  // design; the test spawn helper streams child output too.
  {
    files: [
      'src/cli/**/*.ts',
      'examples/**/*.ts',
      'benchmarks/**/*.ts',
      'workers/**/*.ts',
      'test/spawn.ts',
      'test/cli-golden/**/*.ts',
    ],
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
  {
    files: ['examples/document-catalog.ts', 'test/adoption.test.ts', 'test/spawn.ts'],
    rules: {
      '@typescript-eslint/no-unnecessary-type-parameters': 'off',
    },
  },
]
