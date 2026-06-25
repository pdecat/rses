import { spawn } from 'child_process'
import { existsSync } from 'fs'

const INSTALL_HINTS = {
  claude: '  Install: npm i -g @anthropic-ai/claude-code',
  codex: '  Install: npm i -g @openai/codex',
  gemini: '  Install: npm i -g @google/gemini-cli',
  opencode: '  Install: see https://github.com/opencode-ai/opencode',
}

// Resume in the session's original working directory so the tool loads the
// right project. Fall back to the current directory if that path is unknown
// or no longer exists (e.g. the repo was moved or deleted).
function resolveLaunchCwd(cwd) {
  if (!cwd) return process.cwd()
  if (existsSync(cwd)) return cwd
  console.error(`\nNote: original session directory no longer exists:\n  ${cwd}\n  Launching in the current directory instead.`)
  return process.cwd()
}

// Resume a session in its own tool using that tool's native resume command
// (e.g. `claude --resume <id>`), in the session's original directory.
export function launchNative(tool, args = [], cwd) {
  const child = spawn(tool, args, {
    stdio: 'inherit',
    cwd: resolveLaunchCwd(cwd),
    shell: false,
  })

  child.on('error', (err) => {
    if (err.code === 'ENOENT') {
      console.error(`\nError: '${tool}' not found on PATH. Is it installed?`)
      console.error(INSTALL_HINTS[tool] || `  Install ${tool} and ensure it's on your PATH.`)
      process.exit(1)
    }
    throw err
  })

  child.on('exit', (code) => {
    process.exit(code ?? 0)
  })
}

export function launchWithHandoff(tool, handoff, cwd, passthroughArgs = []) {
  // opencode uses `opencode run <message>`, claude/codex accept prompt as bare arg
  const args = tool === 'opencode'
    ? ['run', ...passthroughArgs, handoff]
    : [...passthroughArgs, handoff]
  const opts = {
    stdio: 'inherit',
    cwd: resolveLaunchCwd(cwd),
    // Detach from our process so the tool gets a clean TTY
    shell: false,
  }

  const child = spawn(tool, args, opts)

  child.on('error', (err) => {
    if (err.code === 'ENOENT') {
      console.error(`\nError: '${tool}' not found on PATH. Is it installed?`)
      console.error(INSTALL_HINTS[tool] || `  Install ${tool} and ensure it's on your PATH.`)
      process.exit(1)
    }
    throw err
  })

  child.on('exit', (code) => {
    process.exit(code ?? 0)
  })
}
