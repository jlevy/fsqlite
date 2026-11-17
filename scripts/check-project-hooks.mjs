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
const FALLBACK_CACHE_DIR_NAME = 'tbd-fallback-npm'
const resetNpxMarker = () => {
  rmSync(npxMarker, { force: true })
}
/**
 * The npx fallback must run exactly the configured pin under the repository's
 * supply-chain rules, passed as flags so inherited npm environment settings cannot
 * override them: no install scripts, and a dedicated cache that other npx runs never
 * fill. get-tbd is first-party, so the fallback applies no cool-off cutoff.
 * @param {string} label
 * @param {string} pin
 * @param {string[]} args
 * @param {string} [expectedCache]
 */
const assertFallbackInvocation = (label, pin, args, expectedCache) => {
  const argv = readFileSync(npxMarker, 'utf8').split('\n').slice(0, -1)
  const [yes, ignoreScripts, cache, ...command] = argv
  const argvText = JSON.stringify(argv)
  assert.ok(
    !argv.some((arg) => arg === '--before' || arg.startsWith('--before=')),
    `${label} fallback passed a cool-off cutoff to first-party get-tbd: ${argvText}`,
  )
  assert.equal(yes, '--yes', `${label} fallback did not pass --yes first: ${argvText}`)
  assert.equal(
    ignoreScripts,
    '--ignore-scripts',
    `${label} fallback did not pass --ignore-scripts: ${argvText}`,
  )
  assert.ok(
    cache?.startsWith('--cache=') && cache.endsWith(`/${FALLBACK_CACHE_DIR_NAME}`),
    `${label} fallback did not use its dedicated npm cache: ${argvText}`,
  )
  if (expectedCache !== undefined) {
    assert.equal(cache, `--cache=${expectedCache}`, `${label} fallback used the wrong cache`)
  }
  assert.deepEqual(
    command,
    [`get-tbd@${pin}`, ...args],
    `${label} fallback did not run exactly the configured pin: ${argvText}`,
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
    '#!/bin/bash\nprintf "%s\\n" "$@" > "$TBD_HOOK_TEST_NPX_MARKER"\nexit "${TBD_HOOK_TEST_NPX_STATUS:-0}"\n',
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
    assertFallbackInvocation(
      hook.name,
      tbdFallbackVersion,
      hook.name.endsWith('PreCompact') ? ['prime', '--brief'] : ['prime'],
    )
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
    assertFallbackInvocation(`${hook.name} closing`, tbdFallbackVersion, ['closing'])

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
    const installHint = /Install it with: npm install -g --ignore-scripts get-tbd@(\S+)\n/.exec(
      withoutCliOutput,
    )
    assert.equal(
      installHint?.[1],
      tbdFallbackVersion,
      `${hook.name} closing hook did not explain how to install the missing CLI:\n${withoutCliOutput}`,
    )
    assert.doesNotMatch(
      withoutCliOutput,
      /--before|days ago|cool-off/,
      `${hook.name} closing hook applied a cool-off to first-party get-tbd:\n${withoutCliOutput}`,
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

  // The Codex wrapper walks up only to the project boundary (the first directory with
  // .git or .codex/hooks.json) and runs a closing hook only from a Codex-configured
  // boundary, never a stray copy in a nested directory or outside any project.
  /** @param {string} marker */
  const markerHook = (marker) => `#!/bin/bash\nprintf "" > ${JSON.stringify(marker)}\n`
  /** @param {string} cwd */
  const runCodexWrapper = (cwd) =>
    spawnSync(codexPostToolUseCommand, {
      cwd,
      encoding: 'utf8',
      env: noGitEnv,
      input: JSON.stringify({ tool_input: { command: 'git push origin HEAD' } }),
      shell: true,
    })
  /** @param {string} dir */
  const isProjectBoundary = (dir) =>
    existsSync(join(dir, '.git')) || existsSync(join(dir, '.codex', 'hooks.json'))
  const codexProject = join(hookTestDir, 'codex-project')
  const codexProjectMarker = join(hookTestDir, 'codex-project-hook-ran')
  const strayHookMarker = join(hookTestDir, 'stray-codex-hook-ran')
  /** @param {string} dir */
  const writeStrayHook = (dir) => {
    mkdirSync(join(dir, '.codex'), { recursive: true })
    writeFileSync(join(dir, '.codex', 'tbd-closing-reminder.sh'), markerHook(strayHookMarker))
  }
  mkdirSync(join(codexProject, '.git'), { recursive: true })
  mkdirSync(join(codexProject, '.codex'))
  writeFileSync(join(codexProject, '.codex', 'hooks.json'), '{}\n')
  writeFileSync(
    join(codexProject, '.codex', 'tbd-closing-reminder.sh'),
    markerHook(codexProjectMarker),
  )
  writeStrayHook(join(codexProject, 'sub'))
  const fromNested = runCodexWrapper(join(codexProject, 'sub'))
  assert.equal(
    fromNested.status,
    0,
    `Codex wrapper failed from a nested directory:\n${fromNested.stderr}`,
  )
  assert.equal(
    existsSync(codexProjectMarker),
    true,
    "Codex wrapper skipped the project's closing hook",
  )
  assert.equal(
    existsSync(strayHookMarker),
    false,
    'Codex wrapper ran a closing hook from a nested non-project directory',
  )

  const codexProjectWithoutHook = join(hookTestDir, 'codex-project-without-hook')
  mkdirSync(join(codexProjectWithoutHook, '.codex'), { recursive: true })
  writeFileSync(join(codexProjectWithoutHook, '.codex', 'hooks.json'), '{}\n')
  writeStrayHook(join(codexProjectWithoutHook, 'sub'))
  const missingHook = runCodexWrapper(join(codexProjectWithoutHook, 'sub'))
  assert.equal(missingHook.status, 1, 'Codex wrapper accepted a project without its closing hook')
  assert.match(missingHook.stderr, /Cannot locate the Codex closing hook/)
  assert.equal(existsSync(strayHookMarker), false, 'Codex wrapper ran a nested stray hook')

  const gitProjectWithoutCodex = join(hookTestDir, 'git-project-without-codex')
  mkdirSync(join(gitProjectWithoutCodex, '.git'), { recursive: true })
  writeStrayHook(gitProjectWithoutCodex)
  mkdirSync(join(gitProjectWithoutCodex, 'work'))
  const withoutCodexConfig = runCodexWrapper(join(gitProjectWithoutCodex, 'work'))
  assert.equal(
    withoutCodexConfig.status,
    0,
    'Codex wrapper failed in a project without Codex hooks',
  )
  assert.equal(withoutCodexConfig.stderr, '', 'Codex wrapper complained outside a Codex project')
  assert.equal(
    existsSync(strayHookMarker),
    false,
    'Codex wrapper ran a closing hook in a project without .codex/hooks.json',
  )

  const outsideProject = join(hookTestDir, 'outside-project', 'sub')
  writeStrayHook(outsideProject)
  const tmpAncestors = []
  for (let dir = hookTestDir; ; dir = dirname(dir)) {
    tmpAncestors.push(dir)
    if (dirname(dir) === dir) {
      break
    }
  }
  if (tmpAncestors.some(isProjectBoundary)) {
    console.log(
      'Skipping the outside-any-project Codex wrapper case: the temporary directory is inside a project.',
    )
  } else {
    const outside = runCodexWrapper(outsideProject)
    assert.equal(outside.status, 0, 'Codex wrapper failed outside any project')
    assert.equal(outside.stderr, '', 'Codex wrapper complained outside any project')
    assert.equal(existsSync(strayHookMarker), false, 'Codex wrapper ran a hook outside any project')
  }

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
  // A PATH with npx but no node: push detection in the closing hook needs node, and the
  // session hook does not.
  const noNodeBin = join(hookTestDir, 'no-node-bin')
  mkdirSync(noNodeBin)
  writeFileSync(join(noNodeBin, 'bash'), '#!/bin/sh\nexec /bin/bash "$@"\n', {
    mode: EXECUTABLE_MODE,
  })
  symlinkSync(join(hookTestDir, 'npx'), join(noNodeBin, 'npx'))
  const bashOnlyBin = join(hookTestDir, 'bash-only-bin')
  mkdirSync(bashOnlyBin)
  symlinkSync(join(noNodeBin, 'bash'), join(bashOnlyBin, 'bash'))

  for (const kind of /** @type {const} */ (['session', 'closing'])) {
    resetNpxMarker()
    const pinned = runFixtureHook(kind, fixtureEnv)
    assert.equal(pinned.status, 0, `fixture ${kind} hook failed:\n${pinned.stderr}`)
    assertFallbackInvocation(`fixture ${kind}`, '9.9.9-rc.1+build.5', [fixtureNpxArgs[kind]])

    // Inherited npm settings, in either case, must not loosen the fallback policy. The
    // shim only records argv; that flags win is npm's config precedence (command line
    // over environment), confirmed with `npm config get` rather than by this shim.
    const xdgCacheHome = join(hookTestDir, 'xdg-cache')
    resetNpxMarker()
    const overridden = runFixtureHook(kind, {
      ...fixtureEnv,
      NPM_CONFIG_IGNORE_SCRIPTS: 'false',
      npm_config_ignore_scripts: 'false',
      XDG_CACHE_HOME: xdgCacheHome,
    })
    assert.equal(overridden.status, 0, `fixture ${kind} hook failed:\n${overridden.stderr}`)
    assertFallbackInvocation(
      `fixture ${kind} with inherited npm settings`,
      '9.9.9-rc.1+build.5',
      [fixtureNpxArgs[kind]],
      join(xdgCacheHome, FALLBACK_CACHE_DIR_NAME),
    )

    resetNpxMarker()
    const failing = runFixtureHook(kind, { ...fixtureEnv, TBD_HOOK_TEST_NPX_STATUS: '41' })
    assert.equal(failing.status, 41, `fixture ${kind} hook hid an npx fallback failure`)

    // Without node, the closing hook cannot detect a push, so it fails closed before npx.
    // The session hook needs no node.
    resetNpxMarker()
    const withoutNode = runFixtureHook(kind, { ...fixtureEnv, PATH: noNodeBin })
    if (kind === 'closing') {
      assert.equal(withoutNode.status, 1, 'fixture closing hook accepted a missing node')
      assert.equal(existsSync(npxMarker), false, 'fixture closing hook ran npx without node')
    } else {
      assert.equal(
        withoutNode.status,
        0,
        `fixture session hook needed node:\n${withoutNode.stderr}`,
      )
      assertFallbackInvocation('fixture session without node', '9.9.9-rc.1+build.5', ['prime'])
    }

    // Without npx, the hook names the exact pin to install, with no cool-off.
    const withoutNpx = runFixtureHook(kind, {
      ...fixtureEnv,
      PATH: kind === 'session' ? bashOnlyBin : noCliBin,
    })
    assert.equal(withoutNpx.status, 1, `fixture ${kind} hook accepted a missing npx`)
    assert.match(
      withoutNpx.stderr,
      /Install it with: npm install -g --ignore-scripts get-tbd@9\.9\.9-rc\.1\+build\.5\n/,
      `fixture ${kind} hook gave no install hint without npx`,
    )
    assert.doesNotMatch(
      withoutNpx.stderr,
      /--before|days ago|cool-off/,
      `fixture ${kind} hook applied a cool-off to first-party get-tbd`,
    )
  }

  // A script copy outside .claude/scripts, .claude/hooks, or .codex refuses to guess.
  const unexpectedDir = join(hookTestDir, 'unexpected-location')
  mkdirSync(unexpectedDir)
  for (const kind of /** @type {const} */ (['session', 'closing'])) {
    const copy = join(unexpectedDir, `${kind}.sh`)
    writeFileSync(copy, readFileSync(fixtureScripts[kind]))
    resetNpxMarker()
    const unexpected = spawnSync('bash', [copy], {
      cwd: unexpectedDir,
      encoding: 'utf8',
      env: fixtureEnv,
      input: '{}',
    })
    assert.equal(unexpected.status, 1, `${kind} hook ran from an unexpected location`)
    assert.match(unexpected.stderr, new RegExp(`Unexpected ${kind} hook location`))
    assert.equal(existsSync(npxMarker), false, `${kind} hook ran npx from an unexpected location`)
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
  for (const [location, nestedScripts] of Object.entries({
    '.claude': {
      session: join(nestedRoot, '.claude', 'scripts', 'tbd-session.sh'),
      closing: join(nestedRoot, '.claude', 'hooks', 'tbd-closing-reminder.sh'),
    },
    '.codex': {
      session: join(nestedRoot, '.codex', 'tbd-session.sh'),
      closing: join(nestedRoot, '.codex', 'tbd-closing-reminder.sh'),
    },
  })) {
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
    assert.equal(
      nestedSession.status,
      1,
      `${location} session hook adopted an ancestor .tbd/config.yml`,
    )
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
      `${location} closing hook failed outside a tbd repo:\n${nestedClosing.stderr}`,
    )
    assert.equal(
      existsSync(ancestorScriptMarker),
      false,
      `${location} closing hook ran an ancestor's script`,
    )
    assert.equal(existsSync(npxMarker), false, `a ${location} hook outside a tbd repo invoked npx`)
  }
} finally {
  rmSync(hookTestDir, { recursive: true, force: true })
}
