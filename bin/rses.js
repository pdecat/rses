#!/usr/bin/env -S node --no-warnings=ExperimentalWarning

import { program } from 'commander'
import { resolve, basename } from 'path'
import { homedir } from 'os'
import { existsSync } from 'fs'

function expandPath(p) {
  if (!p) return p
  if (p.startsWith('~/') || p === '~') return p.replace('~', homedir())
  return resolve(p)
}
import {
  parseCodexSession, findCodexSessions, findCodexSessionById,
  getLastCodexSession, queryCodexSessions
} from '../src/parse-codex.js'
import { parseClaudeSession, findClaudeSessionById, getLastClaudeSession, findClaudeSessions } from '../src/parse-claude.js'
import {
  parseOpenCodeSession, findOpenCodeSessionById, getLastOpenCodeSession,
  queryOpenCodeSessions
} from '../src/parse-opencode.js'
import {
  parseGeminiSession, findGeminiSessions, findGeminiSessionById,
  getLastGeminiSession
} from '../src/parse-gemini.js'
import { buildHandoff } from '../src/build-handoff.js'
import { launchWithHandoff, launchNative } from '../src/launch.js'
import { lsSessions } from '../src/ls.js'
import { pick } from '../src/picker.js'
import { collectAllSessions } from '../src/all-sessions.js'

const VALID_TOOLS = new Set(['claude', 'codex', 'gemini', 'opencode'])
const TOOLS_LIST = "'claude', 'codex', 'gemini', or 'opencode'"
const TOOL_ORDER = ['claude', 'codex', 'gemini', 'opencode']
const TOOL_NAMES = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini', opencode: 'OpenCode' }
const ALIASES = {
  cc: 'claude', cl: 'claude', c: 'claude',
  cdx: 'codex', cx: 'codex', x: 'codex',
  gm: 'gemini', gem: 'gemini', g: 'gemini',
  oc: 'opencode', o: 'opencode',
  w: 'with',
}
function resolve_alias(s) { return ALIASES[s] || s }
const RESUME_HINTS = {
  claude: '  claude --resume',
  codex: '  codex resume',
  gemini: '  gemini --resume latest',
  opencode: '  opencode (select session from built-in picker)',
}
// Tools whose CLI can resume a specific session by id (used for the
// same-tool option in the unified picker). OpenCode/Gemini have no
// resume-by-id flag, so they're cross-resume-only.
const NATIVE_RESUME = {
  claude: (ref) => ['--resume', ref.id],
  codex: (ref) => ['resume', ref.id],
}

program
  .name('rses')
  .version('0.2.0')
  .description('Cross-resume between Claude Code, Codex CLI, Gemini CLI, and OpenCode sessions')

program
  .command('export <source> <id>')
  .description('Print handoff text from a session without launching anything')
  .option('--turns <n>', 'Number of recent turns to include', '6')
  .action((rawSource, id, opts) => {
    const source = resolve_alias(rawSource)
    if (!VALID_TOOLS.has(source)) {
      console.error(`Unknown source: ${source}. Use ${TOOLS_LIST}.`)
      process.exit(1)
    }
    const handoff = resolveAndBuild(source, id, { ...opts, last: false })
    if (handoff) console.log(handoff)
  })

program
  .command('ls [tool]')
  .description('List recent sessions (claude, codex, gemini, opencode, or all)')
  .option('--dir <path>', 'Filter by working directory')
  .action((rawTool, opts) => {
    const tool = rawTool ? resolve_alias(rawTool) : null
    const tools = tool ? [tool] : ['codex', 'claude', 'gemini', 'opencode']
    for (const t of tools) {
      if (!VALID_TOOLS.has(t)) {
        console.error(`Unknown tool: ${t}. Use ${TOOLS_LIST}.`)
        process.exit(1)
      }
      lsSessions(t, opts.dir ? expandPath(opts.dir) : null)
    }
  })

// ── Manual argv parsing ─────────────────────────────────────────────────────
const args = process.argv.slice(2).map(resolve_alias)
const withIdx = args.indexOf('with')

// `rses` (or `rses --dir <path>` / `rses --turns <n>`) opens the unified,
// fuzzy-searchable picker over every tool's sessions.
const BROWSE_FLAGS = new Set(['--dir', '--turns'])
const isBrowse = args.length === 0 || BROWSE_FLAGS.has(args[0])

if (isBrowse) {
  const opts = { dir: null, turns: '6' }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir') opts.dir = args[++i]
    else if (args[i] === '--turns') opts.turns = args[++i]
  }
  runBrowse(opts).catch(e => { console.error(e.message); process.exit(1) })
} else if (withIdx === 1 && !['ls', 'export', '--help', '-h', '--version', '-V'].includes(args[0])) {
  const target = args[0]
  const source = args[withIdx + 1]
  const rest = args.slice(withIdx + 2)

  const opts = { last: false, dryRun: false, dir: null, turns: '6', passthrough: [] }
  let id = null

  // Known rses flags — everything else is forwarded to the target tool
  const RSES_FLAGS = new Set(['--last', '--dry-run', '--dir', '--turns'])

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === '--last') opts.last = true
    else if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--dir') { opts.dir = rest[++i] }
    else if (arg === '--turns') { opts.turns = rest[++i] }
    else if (!arg.startsWith('-')) id = arg
    else {
      // Unknown flag — pass through to the target tool
      // Handle --flag value (where value doesn't start with -)
      opts.passthrough.push(arg)
      // If the flag takes a value (next token exists and isn't a flag), consume it too
      if (rest[i + 1] !== undefined && !rest[i + 1].startsWith('-') && !RSES_FLAGS.has(arg)) {
        opts.passthrough.push(rest[++i])
      }
    }
  }

  if (!target || !source) {
    console.error('Usage: rses <target> with <source> [id] [--last] [--dry-run]')
    process.exit(1)
  }

  runHandoff(target, source, id, opts).catch(e => {
    console.error(e.message)
    process.exit(1)
  })
} else {
  program.parse()
}

// ── Session picker ──────────────────────────────────────────────────────────

async function pickSession(source, filterDir) {
  const home = process.env.HOME || ''
  const shorten = p => p ? p.replace(home, '~') : '—'

  // Fixed column widths — date(16) + gap(2) + cwd(26) + gap(2) + title(rest)
  // Total budget ≈ terminal width. Picker truncates to actual cols at render time.
  const DATE_W = 16
  const CWD_W = 26

  function padCol(s, w) {
    if (!s) s = '—'
    if (s.length > w) return s.slice(0, w - 1) + '…'
    return s.padEnd(w)
  }

  function makeDisplay(date, cwd, title) {
    return `${padCol(date, DATE_W)}  ${padCol(cwd, CWD_W)}  ${title || '(no title)'}`
  }

  if (source === 'codex') {
    const rows = queryCodexSessions({ limit: 30, filterDir }) || []

    if (!rows.length) {
      const files = findCodexSessions(filterDir)
      if (!files.length) return null
      const items = files.slice(0, 30).map(({ path, mtime }) => {
        const date = new Date(mtime).toISOString().slice(0, 16).replace('T', ' ')
        return { display: makeDisplay(date, shorten(path).slice(-CWD_W), basename(path)), value: path }
      })
      return pick(items, 'Select a Codex session:')
    }

    const items = rows.map(r => {
      const date = new Date(r.updatedAt * 1000).toISOString().slice(0, 16).replace('T', ' ')
      const cwd = shorten(r.cwd)
      return {
        display: makeDisplay(date, cwd, r.title),
        value: r,
      }
    })

    const selected = await pick(items, 'Select a Codex session:')
    if (!selected) return null
    if (selected.rolloutPath) return selected.rolloutPath
    return findCodexSessionById(selected.id)

  } else if (source === 'opencode') {
    const rows = queryOpenCodeSessions({ limit: 30, filterDir }) || []
    if (!rows.length) return null

    const items = rows.map(r => {
      const date = new Date(r.updatedAt).toISOString().slice(0, 16).replace('T', ' ')
      const cwd = shorten(r.cwd)
      return {
        display: makeDisplay(date, cwd, r.title),
        value: r.id,
      }
    })

    return pick(items, 'Select an OpenCode session:')

  } else if (source === 'gemini') {
    const files = findGeminiSessions(filterDir)
    if (!files.length) return null

    const items = files.slice(0, 30).map(({ path, mtime }) => {
      const date = new Date(mtime).toISOString().slice(0, 16).replace('T', ' ')
      let cwd = '—'
      let task = '(no task)'
      try {
        const p = parseGeminiSession(path)
        if (p.cwd) cwd = shorten(p.cwd)
        if (p.task) task = p.task
      } catch {}
      return { display: makeDisplay(date, cwd, task), value: path }
    })

    return pick(items, 'Select a Gemini session:')

  } else {
    const files = findClaudeSessions(filterDir)
    if (!files.length) return null

    const { readFileSync } = await import('fs')
    const items = files.slice(0, 30).map(({ path, mtime }) => {
      const date = new Date(mtime).toISOString().slice(0, 16).replace('T', ' ')
      let task = '(no task)'
      try {
        const line = readFileSync(path, 'utf8').split('\n').find(l => {
          try { return JSON.parse(l).type === 'user' } catch { return false }
        })
        if (line) {
          const o = JSON.parse(line)
          const c = o.content
          task = (typeof c === 'string' ? c : (Array.isArray(c) ? c.find(x => x.type === 'text')?.text || '' : ''))
        }
      } catch {}
      return { display: makeDisplay(date, '—', task), value: path }
    })

    return pick(items, 'Select a Claude session:')
  }
}

// ── Core logic ──────────────────────────────────────────────────────────────

async function resolveAndBuildAsync(source, id, opts) {
  const turns = parseInt(opts.turns || '3', 10)
  const filterDir = opts.dir ? expandPath(opts.dir) : null

  let filePath
  let parsed

  if (source === 'codex') {
    if (opts.last) {
      filePath = getLastCodexSession(filterDir)
      if (!filePath) {
        console.error('No Codex sessions found' + (filterDir ? ` in ${filterDir}` : '') + '.')
        process.exit(1)
      }
    } else if (id) {
      filePath = findCodexSessionById(id)
      if (!filePath) {
        console.error(`Codex session not found: ${id}`)
        console.error('Tip: run `rses ls codex` to list sessions.')
        process.exit(1)
      }
    } else {
      filePath = await pickSession('codex', filterDir)
      if (!filePath) { console.error('Cancelled.'); process.exit(0) }
    }

    try { parsed = parseCodexSession(filePath); parsed.filePath = filePath } catch (e) {
      console.error(`Failed to parse Codex session: ${e.message}`)
      process.exit(1)
    }

  } else if (source === 'claude') {
    if (opts.last) {
      filePath = getLastClaudeSession(filterDir)
      if (!filePath) { console.error('No Claude sessions found.'); process.exit(1) }
    } else if (id) {
      filePath = findClaudeSessionById(id)
      if (!filePath) {
        console.error(`Claude session not found: ${id}`)
        console.error('Tip: run `rses ls claude` to list sessions.')
        process.exit(1)
      }
    } else {
      filePath = await pickSession('claude', filterDir)
      if (!filePath) { console.error('Cancelled.'); process.exit(0) }
    }

    try { parsed = parseClaudeSession(filePath); parsed.filePath = filePath } catch (e) {
      console.error(`Failed to parse Claude session: ${e.message}`)
      process.exit(1)
    }

  } else if (source === 'opencode') {
    let sessionId
    if (opts.last) {
      sessionId = getLastOpenCodeSession(filterDir)
      if (!sessionId) {
        console.error('No OpenCode sessions found' + (filterDir ? ` in ${filterDir}` : '') + '.')
        process.exit(1)
      }
    } else if (id) {
      sessionId = findOpenCodeSessionById(id)
      if (!sessionId) {
        console.error(`OpenCode session not found: ${id}`)
        console.error('Tip: run `rses ls opencode` to list sessions.')
        process.exit(1)
      }
    } else {
      sessionId = await pickSession('opencode', filterDir)
      if (!sessionId) { console.error('Cancelled.'); process.exit(0) }
    }

    try { parsed = parseOpenCodeSession(sessionId) } catch (e) {
      console.error(`Failed to parse OpenCode session: ${e.message}`)
      process.exit(1)
    }

  } else if (source === 'gemini') {
    if (opts.last) {
      filePath = getLastGeminiSession(filterDir)
      if (!filePath) {
        console.error('No Gemini sessions found' + (filterDir ? ` in ${filterDir}` : '') + '.')
        process.exit(1)
      }
    } else if (id) {
      filePath = findGeminiSessionById(id)
      if (!filePath) {
        console.error(`Gemini session not found: ${id}`)
        console.error('Tip: run `rses ls gemini` to list sessions.')
        process.exit(1)
      }
    } else {
      filePath = await pickSession('gemini', filterDir)
      if (!filePath) { console.error('Cancelled.'); process.exit(0) }
    }

    try { parsed = parseGeminiSession(filePath); parsed.filePath = filePath } catch (e) {
      console.error(`Failed to parse Gemini session: ${e.message}`)
      process.exit(1)
    }

  } else {
    console.error(`Unknown source tool: ${source}. Use ${TOOLS_LIST}.`)
    process.exit(1)
  }

  parsed.turns = parsed.turns.slice(-turns * 2)
  return { handoff: buildHandoff(source, parsed), cwd: parsed.cwd || null }
}

function resolveAndBuild(source, id, opts) {
  // Sync path for export command
  const turns = parseInt(opts.turns || '3', 10)
  const filterDir = opts.dir ? expandPath(opts.dir) : null
  let filePath, parsed

  if (source === 'codex') {
    if (!id && !opts.last) { console.error('export requires a session ID.'); process.exit(1) }
    filePath = opts.last ? getLastCodexSession(filterDir) : findCodexSessionById(id)
    if (!filePath) { console.error(`Codex session not found: ${id}`); process.exit(1) }
    parsed = parseCodexSession(filePath); parsed.filePath = filePath
  } else if (source === 'claude') {
    if (!id && !opts.last) { console.error('export requires a session ID.'); process.exit(1) }
    filePath = opts.last ? getLastClaudeSession() : findClaudeSessionById(id)
    if (!filePath) { console.error(`Claude session not found: ${id}`); process.exit(1) }
    parsed = parseClaudeSession(filePath); parsed.filePath = filePath
  } else if (source === 'opencode') {
    if (!id && !opts.last) { console.error('export requires a session ID.'); process.exit(1) }
    const sessionId = opts.last ? getLastOpenCodeSession(filterDir) : findOpenCodeSessionById(id)
    if (!sessionId) { console.error(`OpenCode session not found: ${id}`); process.exit(1) }
    parsed = parseOpenCodeSession(sessionId)
  } else if (source === 'gemini') {
    if (!id && !opts.last) { console.error('export requires a session ID.'); process.exit(1) }
    filePath = opts.last ? getLastGeminiSession(filterDir) : findGeminiSessionById(id)
    if (!filePath) { console.error(`Gemini session not found: ${id}`); process.exit(1) }
    parsed = parseGeminiSession(filePath); parsed.filePath = filePath
  } else {
    console.error(`Unknown source: ${source}. Use ${TOOLS_LIST}.`)
    process.exit(1)
  }

  parsed.turns = parsed.turns.slice(-turns * 2)
  return buildHandoff(source, parsed)
}

async function runHandoff(target, source, id, opts) {
  if (!VALID_TOOLS.has(target)) {
    console.error(`Unknown target: ${target}. Use ${TOOLS_LIST}.`); process.exit(1)
  }
  if (!VALID_TOOLS.has(source)) {
    console.error(`Unknown source: ${source}. Use ${TOOLS_LIST}.`); process.exit(1)
  }
  if (target === source) {
    console.error(`Same source and target (${target}). Use the native resume:`)
    console.error(RESUME_HINTS[target] || `  ${target} --resume`)
    process.exit(1)
  }

  const { handoff, cwd } = await resolveAndBuildAsync(source, id, opts)
  if (!handoff) return

  if (opts.dryRun) {
    console.log(handoff)
    return
  }

  printLaunchSummary(handoff, target)
  launchWithHandoff(target, handoff, cwd, opts.passthrough || [])
}

// ── Unified picker (`rses` with no target/source) ────────────────────────────

function printLaunchSummary(handoff, target) {
  const lines = handoff.split('\n')
  const cwdLine = lines.find(l => l.startsWith('Work in:'))
  const taskIdx = lines.findIndex(l => l === 'Task:')
  console.log()
  if (cwdLine) console.log(`  ${cwdLine}`)
  if (taskIdx >= 0 && lines[taskIdx + 1]) {
    console.log(`  Task: "${lines[taskIdx + 1].trim().slice(0, 80)}"`)
  }
  console.log()
  console.log(`  Launching ${TOOL_NAMES[target] || target}...\n`)
}

// Build a handoff from an already-resolved session reference (no re-discovery).
function buildFromRef(source, ref, turns) {
  let parsed
  try {
    if (source === 'codex') {
      const fp = ref.filePath
        || (ref.rolloutPath && existsSync(ref.rolloutPath) ? ref.rolloutPath : findCodexSessionById(ref.id))
      if (!fp) throw new Error('session file not found')
      parsed = parseCodexSession(fp); parsed.filePath = fp
    } else if (source === 'claude') {
      parsed = parseClaudeSession(ref.filePath); parsed.filePath = ref.filePath
    } else if (source === 'gemini') {
      parsed = parseGeminiSession(ref.filePath); parsed.filePath = ref.filePath
    } else if (source === 'opencode') {
      parsed = parseOpenCodeSession(ref.sessionId)
    } else {
      throw new Error(`unknown source ${source}`)
    }
  } catch (e) {
    console.error(`Failed to parse ${TOOL_NAMES[source] || source} session: ${e.message}`)
    process.exit(1)
  }
  parsed.turns = parsed.turns.slice(-turns * 2)
  return buildHandoff(source, parsed)
}

async function runBrowse(opts) {
  const filterDir = opts.dir ? expandPath(opts.dir) : null
  const turns = parseInt(opts.turns || '6', 10)
  const home = process.env.HOME || ''
  const shorten = p => p ? p.replace(home, '~') : '—'

  const sessions = collectAllSessions({ filterDir })
  if (!sessions.length) {
    console.error('No sessions found' + (filterDir ? ` in ${filterDir}` : '') + '.')
    process.exit(1)
  }

  const TOOL_W = 8, DATE_W = 16, CWD_W = 28
  const padCol = (s, w) => {
    s = (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim() || '—'
    return s.length > w ? s.slice(0, w - 1) + '…' : s.padEnd(w)
  }

  const items = sessions.map(s => {
    const date = s.dateMs ? new Date(s.dateMs).toISOString().slice(0, 16).replace('T', ' ') : '—'
    const display = `${padCol(TOOL_NAMES[s.tool] || s.tool, TOOL_W)}  ${padCol(date, DATE_W)}  ${padCol(shorten(s.cwd), CWD_W)}  ${s.task || '(no title)'}`
    return { display, value: s }
  })

  const selected = await pick(items, 'All sessions — type to filter · ↑↓ move · Enter select:')
  if (!selected) { console.error('Cancelled.'); process.exit(0) }

  // Choose where to continue: cross-resume into another tool, or (where the
  // CLI supports it) resume natively in the tool the session came from.
  const source = selected.tool
  const targetItems = []
  for (const t of TOOL_ORDER) {
    if (t === source) continue
    targetItems.push({ display: `→  Continue in ${TOOL_NAMES[t]}`, value: { kind: 'handoff', tool: t } })
  }
  if (NATIVE_RESUME[source]) {
    targetItems.push({ display: `↻  Resume natively in ${TOOL_NAMES[source]}`, value: { kind: 'native', tool: source } })
  }

  const choice = await pick(targetItems, `Continue this ${TOOL_NAMES[source]} session in:`)
  if (!choice) { console.error('Cancelled.'); process.exit(0) }

  if (choice.kind === 'native') {
    launchNative(choice.tool, NATIVE_RESUME[source](selected.ref), selected.cwd || selected.ref.cwd || null)
    return
  }

  const handoff = buildFromRef(source, selected.ref, turns)
  if (!handoff) { console.error('Could not build handoff.'); process.exit(1) }
  printLaunchSummary(handoff, choice.tool)
  launchWithHandoff(choice.tool, handoff, selected.cwd || selected.ref.cwd || null, [])
}
