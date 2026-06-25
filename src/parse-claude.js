import { readFileSync, readdirSync, statSync } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'

// Current Claude Code stores one JSONL per session under
//   ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
// Older builds used ~/.claude/transcripts/ses_*.jsonl with a flatter schema.
// We read both so rses works across versions.
const PROJECTS_DIR = join(homedir(), '.claude', 'projects')
const LEGACY_DIR = join(homedir(), '.claude', 'transcripts')

function extractContent(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(c => c && c.type === 'text')
      .map(c => c.text || '')
      .join('\n')
  }
  return ''
}

// A record is new-style (role/content nested under .message) or legacy (flat).
function recordContent(obj) {
  if (obj.message && obj.message.content !== undefined) return obj.message.content
  if (obj.content !== undefined) return obj.content
  return ''
}

// Skip injected/command/meta turns so the task + transcript stay clean.
function isNoise(obj) {
  if (obj.isMeta || obj.isSidechain) return true
  const c = recordContent(obj)
  if (typeof c === 'string' && /^\s*<(command-|local-command-)/.test(c)) return true
  return false
}

export function parseClaudeSession(filePath) {
  const raw = readFileSync(filePath, 'utf8')
  const lines = raw.split('\n')

  const turns = []
  let cwd = null
  let branch = null

  for (const line of lines) {
    if (!line.trim()) continue
    let obj
    try { obj = JSON.parse(line) } catch { continue }

    if (!cwd && obj.cwd) cwd = obj.cwd
    if (!branch && obj.gitBranch) branch = obj.gitBranch

    if (obj.type !== 'user' && obj.type !== 'assistant') continue
    if (isNoise(obj)) continue

    const text = extractContent(recordContent(obj))
    if (text) turns.push({ role: obj.type, text })
  }

  const sessionId = basename(filePath, '.jsonl').replace(/^ses_/, '')
  const taskTurn = turns.find(t => t.role === 'user')
  const task = taskTurn?.text || ''

  return { sessionId, cwd, branch, startCommit: null, task, turns }
}

// Cheap metadata read for listings/pickers — stops as soon as it has what it needs.
export function peekClaudeSession(filePath) {
  let cwd = null, branch = null, task = ''
  let raw
  try { raw = readFileSync(filePath, 'utf8') } catch { return { cwd, branch, task } }

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let obj
    try { obj = JSON.parse(line) } catch { continue }

    if (!cwd && obj.cwd) cwd = obj.cwd
    if (!branch && obj.gitBranch) branch = obj.gitBranch
    if (!task && obj.type === 'user' && !isNoise(obj)) {
      const t = extractContent(recordContent(obj))
      if (t) task = t
    }
    if (cwd && task) break
  }
  return { cwd, branch, task }
}

function walk(dir) {
  const out = []
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      out.push(...walk(full))
    } else if (e.name.endsWith('.jsonl')) {
      let mtime = 0
      try { mtime = statSync(full).mtimeMs } catch { continue }
      out.push({ path: full, mtime })
    }
  }
  return out
}

export function findClaudeSessions(filterDir = null) {
  const all = [...walk(PROJECTS_DIR), ...walk(LEGACY_DIR)]
  all.sort((a, b) => b.mtime - a.mtime)

  if (!filterDir) return all

  // Claude now records cwd in the transcript, so --dir filtering is supported.
  return all.filter(({ path }) => {
    const { cwd } = peekClaudeSession(path)
    return cwd && (cwd === filterDir || cwd.startsWith(filterDir + '/'))
  })
}

export function findClaudeSessionById(id) {
  const normalized = id.replace(/^ses_/, '')
  for (const { path } of [...walk(PROJECTS_DIR), ...walk(LEGACY_DIR)]) {
    const base = basename(path, '.jsonl').replace(/^ses_/, '')
    if (base === normalized || base.startsWith(normalized)) return path
  }
  return null
}

export function getLastClaudeSession(filterDir = null) {
  const sessions = findClaudeSessions(filterDir)
  return sessions[0]?.path || null
}
