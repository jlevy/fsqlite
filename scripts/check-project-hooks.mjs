import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const hooksPath = join(repoRoot, '.codex', 'hooks.json')
const hooksConfig = JSON.parse(readFileSync(hooksPath, 'utf8'))
const commandHooks = Object.values(hooksConfig.hooks).flatMap((eventHooks) =>
  eventHooks.flatMap((eventHook) => eventHook.hooks),
)

assert(commandHooks.length > 0, 'Expected Codex command hooks')

for (const hook of commandHooks) {
  assert.match(
    hook.command,
    /^bash "\$\(git rev-parse --show-toplevel\)\/\.codex\/[^"]+"(?: |$)/,
    `Codex hook must resolve its script from the Git root: ${hook.command}`,
  )
}

const postToolUseCommand = hooksConfig.hooks.PostToolUse[0].hooks[0].command
const result = spawnSync(postToolUseCommand, {
  cwd: join(repoRoot, 'packages', 'fsqlite'),
  encoding: 'utf8',
  input: JSON.stringify({ tool_input: { command: 'pwd' } }),
  shell: true,
})

assert.equal(
  result.status,
  0,
  `Codex PostToolUse hook failed from a package directory:\n${result.stderr}`,
)
