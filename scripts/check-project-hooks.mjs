import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXECUTABLE_MODE = 0o755
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const tbdConfig = readFileSync(join(repoRoot, '.tbd', 'config.yml'), 'utf8')
// Same exact-semver rule the hook scripts apply before invoking npx.
const EXACT_SEMVER =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/
const tbdFallbackVersion = /^tbd_fallback_version:\s*(\S+)\s*$/m.exec(tbdConfig)?.[1]
assert(
  tbdFallbackVersion !== undefined && EXACT_SEMVER.test(tbdFallbackVersion),
  'Expected .tbd/config.yml to pin an exact tbd_fallback_version',
)

// The Claude and Codex hook scripts are maintained as byte-identical copies.
for (const [claudePath, codexPath] of [
  ['.claude/scripts/tbd-session.sh', '.codex/tbd-session.sh'],
  ['.claude/hooks/tbd-closing-reminder.sh', '.codex/tbd-closing-reminder.sh'],
]) {
  assert.equal(
    readFileSync(join(repoRoot, codexPath), 'utf8'),
    readFileSync(join(repoRoot, claudePath), 'utf8'),
    `${codexPath} must be a byte-identical copy of ${claudePath}`,
  )
}
const codexHooksPath = join(repoRoot, '.codex', 'hooks.json')
const codexHooksConfig = JSON.parse(readFileSync(codexHooksPath, 'utf8'))
const codexCommandHooks = Object.values(codexHooksConfig.hooks).flatMap((eventHooks) =>
  eventHooks.flatMap((eventHook) => eventHook.hooks),
)

assert(codexCommandHooks.length > 0, 'Expected Codex command hooks')

for (const hook of codexCommandHooks) {
  if (hook.command.includes('tbd-closing-reminder.sh')) {
    assert.match(
      hook.command,
      /^bash -c 'repo_root=\$\(pwd -P\);/,
      `Codex closing hook must locate itself from the working-directory ancestry: ${hook.command}`,
    )
    assert.doesNotMatch(
      hook.command,
      /git rev-parse/,
      `Codex closing hook bootstrap must not require git: ${hook.command}`,
    )
    continue
  }
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

const closingHookCommands = [
  {
    name: 'Codex',
    command: codexPostToolUseCommand,
  },
  {
    name: 'Claude',
    command: claudeHooksConfig.hooks.PostToolUse[0].hooks[0].command,
  },
]
const sessionHookCommands = [
  {
    name: 'Codex SessionStart',
    command: codexHooksConfig.hooks.SessionStart[0].hooks[0].command,
  },
  {
    name: 'Codex PreCompact',
    command: codexHooksConfig.hooks.PreCompact[0].hooks[0].command,
  },
  {
    name: 'Claude SessionStart',
    command: claudeHooksConfig.hooks.SessionStart[0].hooks[0].command,
  },
  {
    name: 'Claude PreCompact',
    command: claudeHooksConfig.hooks.PreCompact[0].hooks[0].command,
  },
]
const hookTestDir = mkdtempSync(join(tmpdir(), 'fsqlite-project-hooks-'))
const closingMarker = join(hookTestDir, 'closing-ran')
const primeMarker = join(hookTestDir, 'prime-ran')
const npxMarker = join(hookTestDir, 'npx-ran')
const shadowMarker = join(hookTestDir, 'shadow-ran')
const FALLBACK_COOL_OFF_MS = 14 * 24 * 60 * 60 * 1000
const FALLBACK_CUTOFF_TOLERANCE_MS = 10 * 60 * 1000
const resetNpxMarker = () => {
  rmSync(npxMarker, { force: true })
  rmSync(`${npxMarker}.env`, { force: true })
}
/**
 * The npx fallback must run under the repository's supply-chain rules: no install
 * scripts, and nothing published inside the 14-day cool-off.
 * @param {string} label
 */
const assertFallbackPolicy = (label) => {
  const env = Object.fromEntries(
    readFileSync(`${npxMarker}.env`, 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split('=', 2)),
  )
  assert.equal(env.ignore_scripts, 'true', `${label} fallback allowed npm install scripts`)
  const cutoff = Date.parse(env.before ?? '')
  assert.ok(
    Number.isFinite(cutoff) &&
      Math.abs(Date.now() - FALLBACK_COOL_OFF_MS - cutoff) < FALLBACK_CUTOFF_TOLERANCE_MS,
    `${label} fallback did not apply the 14-day cool-off (before=${env.before})`,
  )
}
try {
  writeFileSync(join(hookTestDir, 'jq'), '#!/bin/bash\nexit 1\n', { mode: EXECUTABLE_MODE })
  writeFileSync(
    join(hookTestDir, 'tbd'),
    '#!/bin/bash\nif [[ "$1" == "config" && "$2" == "get" && "$3" == "tbd_format" ]]; then\n  exit "${TBD_HOOK_TEST_CONFIG_STATUS:-0}"\nfi\nif [[ "$1" == "whoami" ]]; then\n  exit 0\nfi\nif [[ "$1" == "closing" ]]; then\n  printf "" > "$TBD_HOOK_TEST_MARKER"\n  exit "${TBD_HOOK_TEST_TBD_STATUS:-0}"\nfi\nif [[ "$1" == "prime" ]]; then\n  printf "" > "$TBD_HOOK_TEST_PRIME_MARKER"\n  exit 0\nfi\nexit 1\n',
    { mode: EXECUTABLE_MODE },
  )
  writeFileSync(
    join(hookTestDir, 'npx'),
    '#!/bin/bash\nprintf "%s\\n" "$@" > "$TBD_HOOK_TEST_NPX_MARKER"\nprintf "before=%s\\nignore_scripts=%s\\n" "${npm_config_before-}" "${npm_config_ignore_scripts-}" > "$TBD_HOOK_TEST_NPX_MARKER.env"\nexit "${TBD_HOOK_TEST_NPX_STATUS:-0}"\n',
    { mode: EXECUTABLE_MODE },
  )
  const shadowBin = join(hookTestDir, '.local', 'bin')
  mkdirSync(shadowBin, { recursive: true })
  writeFileSync(
    join(shadowBin, 'tbd'),
    '#!/bin/bash\nprintf "" > "$TBD_HOOK_TEST_SHADOW_MARKER"\nexit 0\n',
    { mode: EXECUTABLE_MODE },
  )
  const hookEnv = {
    ...process.env,
    CLAUDE_PROJECT_DIR: repoRoot,
    HOME: hookTestDir,
    PATH: `${hookTestDir}:${process.env.PATH ?? ''}`,
    TBD_HOOK_PATH_PREFIX: '',
    TBD_HOOK_TEST_MARKER: closingMarker,
    TBD_HOOK_TEST_PRIME_MARKER: primeMarker,
    TBD_HOOK_TEST_NPX_MARKER: npxMarker,
    TBD_HOOK_TEST_SHADOW_MARKER: shadowMarker,
  }

  for (const hook of sessionHookCommands) {
    rmSync(primeMarker, { force: true })
    resetNpxMarker()
    rmSync(shadowMarker, { force: true })
    const session = spawnSync(hook.command, {
      cwd: join(repoRoot, 'packages', 'fsqlite'),
      encoding: 'utf8',
      env: hookEnv,
      shell: true,
    })
    assert.equal(session.status, 0, `${hook.name} hook failed:\n${session.stderr}`)
    assert.equal(existsSync(primeMarker), true, `${hook.name} hook ignored TBD_HOOK_PATH_PREFIX`)
    assert.equal(
      existsSync(shadowMarker),
      false,
      `${hook.name} hook selected a machine-local tbd despite TBD_HOOK_PATH_PREFIX`,
    )
    assert.equal(
      existsSync(npxMarker),
      false,
      `${hook.name} hook contacted its npx fallback despite a hermetic tbd shim`,
    )

    rmSync(primeMarker, { force: true })
    resetNpxMarker()
    const incompatible = spawnSync(hook.command, {
      cwd: join(repoRoot, 'packages', 'fsqlite'),
      encoding: 'utf8',
      env: { ...hookEnv, TBD_HOOK_TEST_CONFIG_STATUS: '1' },
      shell: true,
    })
    assert.equal(
      incompatible.status,
      0,
      `${hook.name} hook failed its pinned fallback:\n${incompatible.stderr}`,
    )
    assert.equal(
      existsSync(primeMarker),
      false,
      `${hook.name} hook primed with a tbd that cannot read this repository format`,
    )
    assert.equal(
      readFileSync(npxMarker, 'utf8'),
      `--yes\nget-tbd@${tbdFallbackVersion}\nprime\n${hook.name.endsWith('PreCompact') ? '--brief\n' : ''}`,
      `${hook.name} hook did not use the exact configured fallback version`,
    )
    assertFallbackPolicy(`${hook.name}`)
  }

  const noCliBin = join(hookTestDir, 'no-cli-bin')
  mkdirSync(noCliBin)
  writeFileSync(join(noCliBin, 'bash'), '#!/bin/sh\nexec /bin/bash "$@"\n', {
    mode: EXECUTABLE_MODE,
  })
  writeFileSync(
    join(noCliBin, 'git'),
    '#!/bin/bash\nif [[ "$1" == "rev-parse" && "$2" == "--show-toplevel" ]]; then\n  printf "%s\\n" "$TBD_HOOK_TEST_REPO_ROOT"\n  exit 0\nfi\nexit 1\n',
    { mode: EXECUTABLE_MODE },
  )
  symlinkSync(process.execPath, join(noCliBin, 'node'))
  const noCliEnv = {
    ...process.env,
    CLAUDE_PROJECT_DIR: repoRoot,
    HOME: hookTestDir,
    PATH: noCliBin,
    TBD_HOOK_PATH_PREFIX: '',
    TBD_HOOK_TEST_REPO_ROOT: repoRoot,
  }
  const npxOnlyBin = join(hookTestDir, 'npx-only-bin')
  mkdirSync(npxOnlyBin)
  writeFileSync(join(npxOnlyBin, 'bash'), '#!/bin/sh\nexec /bin/bash "$@"\n', {
    mode: EXECUTABLE_MODE,
  })
  writeFileSync(
    join(npxOnlyBin, 'git'),
    '#!/bin/bash\nif [[ "$1" == "rev-parse" && "$2" == "--show-toplevel" ]]; then\n  printf "%s\\n" "$TBD_HOOK_TEST_REPO_ROOT"\n  exit 0\nfi\nexit 1\n',
    { mode: EXECUTABLE_MODE },
  )
  symlinkSync(process.execPath, join(npxOnlyBin, 'node'))
  symlinkSync(join(hookTestDir, 'npx'), join(npxOnlyBin, 'npx'))
  const npxOnlyEnv = {
    ...noCliEnv,
    PATH: npxOnlyBin,
    TBD_HOOK_TEST_NPX_MARKER: npxMarker,
    TBD_HOOK_TEST_NPX_STATUS: '37',
  }
  const noGitBin = join(hookTestDir, 'no-git-bin')
  mkdirSync(noGitBin)
  writeFileSync(join(noGitBin, 'bash'), '#!/bin/sh\nexec /bin/bash "$@"\n', {
    mode: EXECUTABLE_MODE,
  })
  symlinkSync(process.execPath, join(noGitBin, 'node'))
  symlinkSync(join(hookTestDir, 'tbd'), join(noGitBin, 'tbd'))
  const noGitEnv = {
    ...process.env,
    CLAUDE_PROJECT_DIR: repoRoot,
    HOME: hookTestDir,
    PATH: noGitBin,
    TBD_HOOK_PATH_PREFIX: '',
    TBD_HOOK_TEST_MARKER: closingMarker,
  }
  for (const hook of sessionHookCommands.filter(({ name }) => name.startsWith('Claude'))) {
    rmSync(primeMarker, { force: true })
    const withoutGitSession = spawnSync(hook.command, {
      cwd: join(repoRoot, 'packages', 'fsqlite'),
      encoding: 'utf8',
      env: { ...noGitEnv, TBD_HOOK_TEST_PRIME_MARKER: primeMarker },
      shell: true,
    })
    assert.equal(
      withoutGitSession.status,
      0,
      `${hook.name} hook failed when git was unavailable:\n${withoutGitSession.stderr}`,
    )
    assert.equal(
      existsSync(primeMarker),
      true,
      `${hook.name} hook skipped tbd prime when git was unavailable`,
    )
  }

  const symlinkedPackageDir = join(hookTestDir, 'symlinked-package')
  symlinkSync(join(repoRoot, 'packages', 'fsqlite'), symlinkedPackageDir)

  for (const hook of closingHookCommands) {
    rmSync(closingMarker, { force: true })
    rmSync(shadowMarker, { force: true })
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
    assert.equal(
      existsSync(shadowMarker),
      false,
      `${hook.name} closing hook selected a machine-local tbd ahead of the test shim`,
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

    resetNpxMarker()
    const failingTbd = spawnSync(hook.command, {
      cwd: join(repoRoot, 'packages', 'fsqlite'),
      encoding: 'utf8',
      env: { ...hookEnv, TBD_HOOK_TEST_TBD_STATUS: '23' },
      input: JSON.stringify({ tool_input: { command: 'git push --dry-run' } }),
      shell: true,
    })
    assert.equal(failingTbd.status, 23, `${hook.name} closing hook hid a tbd failure`)
    assert.equal(
      existsSync(npxMarker),
      false,
      `${hook.name} closing hook fell through to npx after a tbd failure`,
    )

    rmSync(closingMarker, { force: true })
    resetNpxMarker()
    const incompatibleTbd = spawnSync(hook.command, {
      cwd: join(repoRoot, 'packages', 'fsqlite'),
      encoding: 'utf8',
      env: { ...hookEnv, TBD_HOOK_TEST_CONFIG_STATUS: '1' },
      input: JSON.stringify({ tool_input: { command: 'git push --dry-run' } }),
      shell: true,
    })
    assert.equal(
      incompatibleTbd.status,
      0,
      `${hook.name} closing hook failed its pinned fallback:\n${incompatibleTbd.stderr}`,
    )
    assert.equal(
      existsSync(closingMarker),
      false,
      `${hook.name} closing hook ran a tbd that cannot read this repository format`,
    )
    assert.equal(
      readFileSync(npxMarker, 'utf8'),
      `--yes\nget-tbd@${tbdFallbackVersion}\nclosing\n`,
      `${hook.name} closing hook did not use the exact configured fallback version`,
    )
    assertFallbackPolicy(`${hook.name}`)

    resetNpxMarker()
    const failingNpx = spawnSync(hook.command, {
      cwd: join(repoRoot, 'packages', 'fsqlite'),
      encoding: 'utf8',
      env: npxOnlyEnv,
      input: JSON.stringify({ tool_input: { command: 'git push --dry-run' } }),
      shell: true,
    })
    assert.equal(failingNpx.status, 37, `${hook.name} closing hook hid an npx failure`)
    assert.equal(
      existsSync(npxMarker),
      true,
      `${hook.name} closing hook did not invoke its npx fallback`,
    )

    const withoutCli = spawnSync(hook.command, {
      cwd: join(repoRoot, 'packages', 'fsqlite'),
      encoding: 'utf8',
      env: noCliEnv,
      input: JSON.stringify({ tool_input: { command: 'git push --dry-run' } }),
      shell: true,
    })
    assert.notEqual(withoutCli.status, 0, `${hook.name} closing hook accepted a missing tbd CLI`)
    const withoutCliOutput = `${withoutCli.stdout}\n${withoutCli.stderr}`
    assert.match(
      withoutCliOutput,
      /tbd CLI not found.*npx is unavailable/is,
      `${hook.name} closing hook did not explain the missing CLI`,
    )
    assert.ok(
      withoutCliOutput.includes(`npm install -g get-tbd@${tbdFallbackVersion}\n`),
      `${hook.name} closing hook did not explain how to install the missing CLI`,
    )

    rmSync(closingMarker, { force: true })
    const withoutGit = spawnSync(hook.command, {
      cwd: join(repoRoot, 'packages', 'fsqlite'),
      encoding: 'utf8',
      env: noGitEnv,
      input: JSON.stringify({ tool_input: { command: 'git push --dry-run' } }),
      shell: true,
    })
    assert.equal(
      withoutGit.status,
      0,
      `${hook.name} closing hook failed when git was unavailable:\n${withoutGit.stderr}`,
    )
    assert.equal(
      existsSync(closingMarker),
      true,
      `${hook.name} closing hook skipped tbd closing when git was unavailable`,
    )

    const pushForms = [
      'git commit -m test\ngit push origin HEAD',
      `git -C "${repoRoot}" push origin HEAD`,
      '/usr/bin/git push origin HEAD',
      "GIT_SSH_COMMAND='ssh -i /tmp/key' git push origin HEAD",
      'env GIT_CONFIG_COUNT=1 git push origin HEAD',
      'command git push origin HEAD',
      'eval git push origin HEAD',
      'if git commit -m test; then git push origin HEAD; fi',
      'for i in 1; do git push origin HEAD; done',
      '(git push origin HEAD)',
      'case x in x) git push origin HEAD ;; esac',
    ]
    for (const command of pushForms) {
      rmSync(closingMarker, { force: true })
      const alternatePush = spawnSync(hook.command, {
        cwd: join(repoRoot, 'packages', 'fsqlite'),
        encoding: 'utf8',
        env: hookEnv,
        input: JSON.stringify({ tool_input: { command } }),
        shell: true,
      })
      assert.equal(
        alternatePush.status,
        0,
        `${hook.name} closing hook failed for command ${JSON.stringify(command)}:\n${alternatePush.stderr}`,
      )
      assert.equal(
        existsSync(closingMarker),
        true,
        `${hook.name} closing hook missed push command ${JSON.stringify(command)}`,
      )
    }

    const nonPushForms = [
      'echo git push',
      'git commit -m push',
      'git --help push',
      'git --version push',
      'git -h push',
      'if echo git push; then :; fi',
      'for git in push; do :; done',
      'eval echo git push',
      'eval "git push origin HEAD"',
      'printf "git push\\n"',
    ]
    for (const command of nonPushForms) {
      rmSync(closingMarker, { force: true })
      const nonPush = spawnSync(hook.command, {
        cwd: join(repoRoot, 'packages', 'fsqlite'),
        encoding: 'utf8',
        env: hookEnv,
        input: JSON.stringify({ tool_input: { command } }),
        shell: true,
      })
      assert.equal(
        nonPush.status,
        0,
        `${hook.name} closing hook failed for non-push command ${JSON.stringify(command)}`,
      )
      assert.equal(
        existsSync(closingMarker),
        false,
        `${hook.name} closing hook misclassified non-push command ${JSON.stringify(command)}`,
      )
    }
  }

  rmSync(closingMarker, { force: true })
  const symlinkedCodex = spawnSync(codexPostToolUseCommand, {
    cwd: symlinkedPackageDir,
    encoding: 'utf8',
    env: { ...noGitEnv, PWD: symlinkedPackageDir },
    input: JSON.stringify({ tool_input: { command: 'git push --dry-run' } }),
    shell: true,
  })
  assert.equal(
    symlinkedCodex.status,
    0,
    `Codex closing hook failed from a symlinked package directory:\n${symlinkedCodex.stderr}`,
  )
  assert.equal(
    existsSync(closingMarker),
    true,
    'Codex closing hook skipped tbd closing from a symlinked package directory',
  )

  // Run copies of the hooks in a git-free fixture whose config the test controls, so the
  // assertions prove the scripts read and validate the pin rather than echo a constant.
  const fixtureRoot = join(hookTestDir, 'fixture-repo')
  const fixtureScripts = {
    session: join(fixtureRoot, '.claude', 'scripts', 'tbd-session.sh'),
    closing: join(fixtureRoot, '.claude', 'hooks', 'tbd-closing-reminder.sh'),
  }
  mkdirSync(dirname(fixtureScripts.session), { recursive: true })
  mkdirSync(dirname(fixtureScripts.closing), { recursive: true })
  mkdirSync(join(fixtureRoot, 'scripts'), { recursive: true })
  mkdirSync(join(fixtureRoot, '.tbd'), { recursive: true })
  writeFileSync(
    fixtureScripts.session,
    readFileSync(join(repoRoot, '.claude', 'scripts', 'tbd-session.sh')),
  )
  writeFileSync(
    fixtureScripts.closing,
    readFileSync(join(repoRoot, '.claude', 'hooks', 'tbd-closing-reminder.sh')),
  )
  writeFileSync(
    join(fixtureRoot, 'scripts', 'detect-git-push.mjs'),
    readFileSync(join(repoRoot, 'scripts', 'detect-git-push.mjs')),
  )
  const fixtureConfig = join(fixtureRoot, '.tbd', 'config.yml')
  const fixtureEnv = {
    ...npxOnlyEnv,
    TBD_HOOK_TEST_NPX_STATUS: '0',
  }
  /** @param {'session' | 'closing'} kind @param {Record<string, string>} env */
  const runFixtureHook = (kind, env) =>
    spawnSync('bash', [fixtureScripts[kind]], {
      cwd: hookTestDir,
      encoding: 'utf8',
      env,
      input:
        kind === 'closing'
          ? JSON.stringify({ tool_input: { command: 'git push origin HEAD' } })
          : undefined,
    })
  const fixtureNpxArgs = { session: 'prime', closing: 'closing' }

  writeFileSync(fixtureConfig, 'tbd_format: f08\ntbd_fallback_version: 9.9.9-rc.1+build.5\n')
  for (const kind of /** @type {const} */ (['session', 'closing'])) {
    resetNpxMarker()
    const pinned = runFixtureHook(kind, fixtureEnv)
    assert.equal(pinned.status, 0, `fixture ${kind} hook failed:\n${pinned.stderr}`)
    assert.equal(
      readFileSync(npxMarker, 'utf8'),
      `--yes\nget-tbd@9.9.9-rc.1+build.5\n${fixtureNpxArgs[kind]}\n`,
      `fixture ${kind} hook did not use the configured fallback pin`,
    )
    assertFallbackPolicy(`fixture ${kind}`)

    resetNpxMarker()
    const failing = runFixtureHook(kind, { ...fixtureEnv, TBD_HOOK_TEST_NPX_STATUS: '41' })
    assert.equal(failing.status, 41, `fixture ${kind} hook hid an npx fallback failure`)
  }

  for (const badPin of [
    'tbd_fallback_version: latest\n',
    'tbd_fallback_version: ^0.10.0\n',
    'tbd_fallback_version: 0.10\n',
    'tbd_fallback_version: 0.10.0; rm -rf /\n',
    'tbd_fallback_version: 0.10.0 --registry=https://example.invalid\n',
    'tbd_fallback_version: get-tbd@0.10.0\n',
    '',
  ]) {
    writeFileSync(fixtureConfig, `tbd_format: f08\n${badPin}`)
    for (const kind of /** @type {const} */ (['session', 'closing'])) {
      resetNpxMarker()
      const rejected = runFixtureHook(kind, fixtureEnv)
      assert.equal(
        rejected.status,
        1,
        `fixture ${kind} hook accepted fallback config ${JSON.stringify(badPin)}`,
      )
      assert.match(
        rejected.stderr,
        /valid exact tbd_fallback_version/,
        `fixture ${kind} hook did not explain the invalid fallback pin`,
      )
      assert.equal(
        existsSync(npxMarker),
        false,
        `fixture ${kind} hook invoked npx with fallback config ${JSON.stringify(badPin)}`,
      )
    }
  }

  // A hook installed under a directory without its own .tbd must fail closed rather
  // than adopt an enclosing directory's config or execute its scripts.
  const ancestorRoot = join(hookTestDir, 'ancestor')
  const nestedRoot = join(ancestorRoot, 'nested-repo')
  const ancestorScriptMarker = join(hookTestDir, 'ancestor-script-ran')
  mkdirSync(join(ancestorRoot, '.tbd'), { recursive: true })
  mkdirSync(join(ancestorRoot, 'scripts'), { recursive: true })
  writeFileSync(join(ancestorRoot, '.tbd', 'config.yml'), 'tbd_fallback_version: 6.6.6\n')
  writeFileSync(
    join(ancestorRoot, 'scripts', 'detect-git-push.mjs'),
    `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(ancestorScriptMarker)}, '')\nconsole.log('yes')\n`,
  )
  const nestedScripts = {
    session: join(nestedRoot, '.claude', 'scripts', 'tbd-session.sh'),
    closing: join(nestedRoot, '.claude', 'hooks', 'tbd-closing-reminder.sh'),
  }
  mkdirSync(dirname(nestedScripts.session), { recursive: true })
  mkdirSync(dirname(nestedScripts.closing), { recursive: true })
  writeFileSync(nestedScripts.session, readFileSync(fixtureScripts.session))
  writeFileSync(nestedScripts.closing, readFileSync(fixtureScripts.closing))
  resetNpxMarker()
  const nestedSession = spawnSync('bash', [nestedScripts.session], {
    cwd: nestedRoot,
    encoding: 'utf8',
    env: fixtureEnv,
  })
  assert.equal(nestedSession.status, 1, 'session hook adopted an ancestor .tbd/config.yml')
  assert.match(nestedSession.stderr, /Cannot locate repository \.tbd\/config\.yml/)
  const nestedClosing = spawnSync('bash', [nestedScripts.closing], {
    cwd: nestedRoot,
    encoding: 'utf8',
    env: fixtureEnv,
    input: JSON.stringify({ tool_input: { command: 'git push origin HEAD' } }),
  })
  assert.equal(
    nestedClosing.status,
    0,
    `closing hook failed outside a tbd repo:\n${nestedClosing.stderr}`,
  )
  assert.equal(existsSync(ancestorScriptMarker), false, "closing hook ran an ancestor's script")
  assert.equal(existsSync(npxMarker), false, 'a hook outside a tbd repo invoked npx')
} finally {
  rmSync(hookTestDir, { recursive: true, force: true })
}
