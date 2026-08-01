// fsqlite publishes a built dist for npm consumers: an ESM library entry (`.`) and a CLI
// bin (`./cli`). In-repo development and the test suite run from `src` directly; only
// published consumers use `dist`. node builtins (node:sqlite, node:fs, ...) stay external.
//
// The config is a plain object (not `defineConfig`) so it resolves without a package-local
// `node_modules` while fsqlite still lives inside this monorepo.
export default {
  entry: ['src/index.ts', 'src/cli/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  dts: true,
  clean: true,
  outDir: 'dist',
  treeshake: true,
  publint: true,
}
