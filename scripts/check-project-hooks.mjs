import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXECUTABLE_MODE = 0o755
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const codexHooksPath = join(repoRoot, '.codex', 'hooks.json')
const codexHooksConfig = JSON.parse(readFileSync(codexHooksPath, 'utf8'))
const codexCommandHooks = Object.values(codexHooksConfig.hooks).flatMap((eventHooks) =>
  eventHooks.flatMap((eventHook) => eventHook.hooks),
)

assert(codexCommandHooks.length > 0, 'Expected Codex command hooks')

for (const hook of codexCommandHooks) {
  assert.match(
    hook.command,
    /^bash "\$\(git rev-parse --show-toplevel\)\/\.codex\/[^"]+"(?: |$)/,
    `Codex hook must resolve its script from the Git root: ${hook.command}`,
  )
}

const claudeSettingsPath = join(repoRoot, '.claude', 'settings.json')
const claudeHooksConfig = JSON.parse(readFileSync(claudeSettingsPath, 'utf8'))
const claudeCommandHooks = Object.values(claudeHooksConfig.hooks).flatMap((eventHooks) =>
  eventHooks.flatMap((eventHook) => eventHook.hooks),
)

assert(claudeCommandHooks.length > 0, 'Expected Claude command hooks')

for (const hook of claudeCommandHooks) {
  assert.match(
    hook.command,
    /^bash "\$CLAUDE_PROJECT_DIR"\/\.claude\/\S+(?: |$)/,
    `Claude hook must resolve its script from the project root: ${hook.command}`,
  )
}

const codexPostToolUseCommand = codexHooksConfig.hooks.PostToolUse[0].hooks[0].command
const codexResult = spawnSync(codexPostToolUseCommand, {
  cwd: join(repoRoot, 'packages', 'fsqlite'),
  encoding: 'utf8',
  input: JSON.stringify({ tool_input: { command: 'pwd' } }),
  shell: true,
})

assert.equal(
  codexResult.status,
  0,
  `Codex PostToolUse hook failed from a package directory:\n${codexResult.stderr}`,
)

const claudePreCompactCommand = claudeHooksConfig.hooks.PreCompact[0].hooks[0].command
const claudeResult = spawnSync(claudePreCompactCommand, {
  cwd: join(repoRoot, 'packages', 'fsqlite'),
  encoding: 'utf8',
  env: { ...process.env, CLAUDE_PROJECT_DIR: repoRoot },
  shell: true,
})

assert.equal(
  claudeResult.status,
  0,
  `Claude PreCompact hook failed from a package directory:\n${claudeResult.stderr}`,
)

const closingHookCommands = [
  { name: 'Codex', command: codexPostToolUseCommand },
  { name: 'Claude', command: claudeHooksConfig.hooks.PostToolUse[0].hooks[0].command },
]
const hookTestDir = mkdtempSync(join(tmpdir(), 'fsqlite-closing-hook-'))
const closingMarker = join(hookTestDir, 'closing-ran')
try {
  writeFileSync(join(hookTestDir, 'jq'), '#!/bin/bash\nexit 1\n', { mode: EXECUTABLE_MODE })
  writeFileSync(
    join(hookTestDir, 'tbd'),
    '#!/bin/bash\nif [[ "$1" == "closing" ]]; then\n  printf "" > "$TBD_HOOK_TEST_MARKER"\n  exit 0\nfi\nexit 1\n',
    { mode: EXECUTABLE_MODE },
  )
  const hookEnv = {
    ...process.env,
    CLAUDE_PROJECT_DIR: repoRoot,
    HOME: hookTestDir,
    PATH: `${hookTestDir}:${process.env.PATH ?? ''}`,
    TBD_HOOK_TEST_MARKER: closingMarker,
  }

  for (const hook of closingHookCommands) {
    rmSync(closingMarker, { force: true })
    const withoutJq = spawnSync(hook.command, {
      cwd: join(repoRoot, 'packages', 'fsqlite'),
      encoding: 'utf8',
      env: hookEnv,
      input: JSON.stringify({ tool_input: { command: 'git push --dry-run' } }),
      shell: true,
    })
    assert.equal(
      withoutJq.status,
      0,
      `${hook.name} closing hook failed without jq:\n${withoutJq.stderr}`,
    )
    assert.equal(
      existsSync(closingMarker),
      true,
      `${hook.name} closing hook skipped tbd closing when jq was unavailable`,
    )

    const malformed = spawnSync(hook.command, {
      cwd: join(repoRoot, 'packages', 'fsqlite'),
      encoding: 'utf8',
      env: hookEnv,
      input: '{',
      shell: true,
    })
    assert.notEqual(malformed.status, 0, `${hook.name} closing hook accepted malformed JSON`)
    assert.match(
      malformed.stderr,
      /invalid hook JSON/i,
      `${hook.name} closing hook did not explain its malformed input`,
    )
  }
} finally {
  rmSync(hookTestDir, { recursive: true, force: true })
}
