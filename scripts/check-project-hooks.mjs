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
  {
    name: 'Codex',
    command: codexPostToolUseCommand,
  },
  {
    name: 'Claude',
    command: claudeHooksConfig.hooks.PostToolUse[0].hooks[0].command,
  },
]
const hookTestDir = mkdtempSync(join(tmpdir(), 'fsqlite-closing-hook-'))
const closingMarker = join(hookTestDir, 'closing-ran')
const npxMarker = join(hookTestDir, 'npx-ran')
try {
  writeFileSync(join(hookTestDir, 'jq'), '#!/bin/bash\nexit 1\n', { mode: EXECUTABLE_MODE })
  writeFileSync(
    join(hookTestDir, 'tbd'),
    '#!/bin/bash\nif [[ "$1" == "closing" ]]; then\n  printf "" > "$TBD_HOOK_TEST_MARKER"\n  exit "${TBD_HOOK_TEST_TBD_STATUS:-0}"\nfi\nexit 1\n',
    { mode: EXECUTABLE_MODE },
  )
  writeFileSync(
    join(hookTestDir, 'npx'),
    '#!/bin/bash\nprintf "" > "$TBD_HOOK_TEST_NPX_MARKER"\nexit "${TBD_HOOK_TEST_NPX_STATUS:-0}"\n',
    { mode: EXECUTABLE_MODE },
  )
  const hookEnv = {
    ...process.env,
    CLAUDE_PROJECT_DIR: repoRoot,
    HOME: hookTestDir,
    PATH: `${hookTestDir}:${process.env.PATH ?? ''}`,
    TBD_HOOK_TEST_MARKER: closingMarker,
    TBD_HOOK_TEST_NPX_MARKER: npxMarker,
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
  const symlinkedPackageDir = join(hookTestDir, 'symlinked-package')
  symlinkSync(join(repoRoot, 'packages', 'fsqlite'), symlinkedPackageDir)

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

    rmSync(npxMarker, { force: true })
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

    rmSync(npxMarker, { force: true })
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
    assert.match(
      withoutCliOutput,
      /npm install -g get-tbd@0\.4\.2/,
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
} finally {
  rmSync(hookTestDir, { recursive: true, force: true })
}
