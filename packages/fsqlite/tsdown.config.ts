// fsqlite publishes a built dist for npm consumers: an ESM library entry (`.`), the
// importable CLI (`./cli`, which exports `main` and has no import-time effects), and the
// `fsqlite` bin that runs it. In-repo development and the test suite run from `src`
// directly; only published consumers use `dist`. node builtins (node:sqlite, node:fs, ...)
// stay external.
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/cli/index.ts', 'src/cli/bin.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  dts: true,
  clean: true,
  outDir: 'dist',
  treeshake: true,
  publint: true,
})
