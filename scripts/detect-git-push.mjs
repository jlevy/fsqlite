import { readFileSync } from 'node:fs'

const SINGLE_QUOTE = String.fromCharCode(39)
const COMMAND_SEPARATORS = new Set(['\n', ';', '&', '|'])
const COMMAND_DECORATORS = new Set(['command', 'env', 'exec', 'nohup', 'sudo', 'time'])
const DECORATOR_OPTIONS_WITH_VALUE = new Set([
  '-C',
  '-D',
  '-R',
  '-S',
  '-T',
  '-a',
  '-g',
  '-h',
  '-p',
  '-u',
  '--argv0',
  '--chdir',
  '--chroot',
  '--command-timeout',
  '--group',
  '--host',
  '--prompt',
  '--split-string',
  '--unset',
  '--user',
])
const GIT_OPTIONS_WITH_VALUE = new Set([
  '-C',
  '-c',
  '--config-env',
  '--exec-path',
  '--git-dir',
  '--namespace',
  '--super-prefix',
  '--work-tree',
])
const TERMINAL_GIT_OPTIONS = new Set(['-h', '-v', '--help', '--list-cmds', '--version'])

function tokenizeShell(command) {
  const tokens = []
  let escaped = false
  let quote = ''
  let word = ''

  const flushWord = () => {
    if (word !== '') tokens.push(word)
    word = ''
  }

  for (const char of command) {
    if (escaped) {
      if (char !== '\n') word += char
      escaped = false
      continue
    }
    if (quote !== '') {
      if (char === quote) {
        quote = ''
      } else if (quote === '"' && char === '\\') {
        escaped = true
      } else {
        word += char
      }
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '"' || char === SINGLE_QUOTE) {
      quote = char
      continue
    }
    if (COMMAND_SEPARATORS.has(char)) {
      flushWord()
      tokens.push(null)
      continue
    }
    if (/\s/u.test(char)) {
      flushWord()
      continue
    }
    word += char
  }

  if (escaped) word += '\\'
  flushWord()
  return tokens
}

function isAssignment(token) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/u.test(token)
}

function isGitExecutable(token) {
  return token === 'git' || token.endsWith('/git')
}

function isTerminalGitOption(token) {
  return (
    TERMINAL_GIT_OPTIONS.has(token) ||
    token.startsWith('--help=') ||
    token.startsWith('--list-cmds=') ||
    token.startsWith('--version=')
  )
}

function containsGitPush(command) {
  let atCommandStart = true
  let scanningGit = false
  let sawDecorator = false
  let skipDecoratorOptionValue = false
  let skipGitOptionValue = false

  for (const token of tokenizeShell(command)) {
    if (token === null) {
      atCommandStart = true
      scanningGit = false
      sawDecorator = false
      skipDecoratorOptionValue = false
      skipGitOptionValue = false
      continue
    }

    if (scanningGit) {
      if (skipGitOptionValue) {
        skipGitOptionValue = false
        continue
      }
      if (token === 'push') return true
      if (isTerminalGitOption(token)) {
        scanningGit = false
        continue
      }
      if (GIT_OPTIONS_WITH_VALUE.has(token)) {
        skipGitOptionValue = true
        continue
      }
      if (token.startsWith('-')) continue
      scanningGit = false
      continue
    }

    if (!atCommandStart) continue
    if (skipDecoratorOptionValue) {
      skipDecoratorOptionValue = false
      continue
    }
    if (isAssignment(token)) continue
    if (COMMAND_DECORATORS.has(token)) {
      sawDecorator = true
      continue
    }
    if (sawDecorator && DECORATOR_OPTIONS_WITH_VALUE.has(token)) {
      skipDecoratorOptionValue = true
      continue
    }
    if (sawDecorator && token.startsWith('-')) continue
    if (isGitExecutable(token)) {
      scanningGit = true
      atCommandStart = false
      continue
    }
    atCommandStart = false
  }

  return false
}

try {
  const input = JSON.parse(readFileSync(0, 'utf8'))
  const command = input?.tool_input?.command
  process.stdout.write(typeof command === 'string' && containsGitPush(command) ? 'yes' : 'no')
} catch {
  console.error('tbd closing reminder: invalid hook JSON')
  process.exit(1)
}
