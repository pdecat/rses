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

// Attachment types that are injected harness state, not user/work content — the
// deferred-tool list, skill/agent/mcp catalogs, task reminders, permission lists,
// output style, hook output, repeated project memory. Indexing these floods
// search (e.g. "EnterWorktree" in deferred_tools_delta matched ~half of sessions).
const INJECTED_ATTACHMENT_TYPES = new Set([
  'deferred_tools_delta', 'mcp_instructions_delta', 'agent_listing_delta',
  'command_permissions', 'output_style', 'task_reminder', 'date_change',
  'skill_listing', 'plan_mode', 'plan_mode_exit', 'diagnostics',
  'hook_success', 'hook_non_blocking_error', 'nested_memory',
])
// Human-readable fields on the remaining attachment types (file/edited_text_file/
// queued_command/plan_file_reference/…) — i.e. the content you actually pasted,
// attached, or queued.
const ATTACHMENT_TEXT_FIELDS = ['content', 'snippet', 'prompt', 'planContent', 'text', 'filename', 'displayPath']

function attachmentText(a) {
  if (!a || typeof a !== 'object' || INJECTED_ATTACHMENT_TYPES.has(a.type)) return ''
  let out = ''
  for (const f of ATTACHMENT_TEXT_FIELDS) {
    if (typeof a[f] === 'string' && a[f]) out += a[f] + '\n'
  }
  return out
}

// Strip harness-injected blocks (system reminders, command wrappers) from a
// message so search indexes what was actually said — not, e.g., the deferred-tool
// list that would make every session match "worktree".
function stripInjected(text) {
  if (!text) return ''
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
    .replace(/<command-[a-z-]*>[\s\S]*?<\/command-[a-z-]*>/gi, ' ')
    .replace(/<local-command-[a-z-]*>[\s\S]*?<\/local-command-[a-z-]*>/gi, ' ')
    .trim()
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

    const text = stripInjected(extractContent(recordContent(obj)))
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
      const t = stripInjected(extractContent(recordContent(obj)))
      if (t) task = t
    }
    if (cwd && task) break
  }
  return { cwd, branch, task }
}

// Read a session's metadata AND a (capped) blob of its conversation text for
// content search — including attachment payloads, where pasted snippets, file
// references, and command output live (so e.g. "worktree" mentioned mid-session
// is findable even when it isn't the first message). One pass, one file read.
export function indexClaudeSession(filePath, cap = 64 * 1024) {
  let cwd = null, branch = null, task = '', content = ''
  let raw
  try { raw = readFileSync(filePath, 'utf8') } catch { return { cwd, branch, task, content } }

  for (const line of raw.split('\n')) {
    if (!line.trim() || line.length > 1000000) continue // skip blanks + huge snapshot/image lines
    if (!/"type":"(user|assistant|attachment)"/.test(line)) continue
    let obj
    try { obj = JSON.parse(line) } catch { continue }

    if (!cwd && obj.cwd) cwd = obj.cwd
    if (!branch && obj.gitBranch) branch = obj.gitBranch
    if (content.length >= cap) continue

    if (obj.type === 'attachment') {
      // Pasted/attached/queued content — minus injected harness state.
      const t = stripInjected(attachmentText(obj.attachment))
      if (t) content += t + '\n'
      continue
    }

    if (isNoise(obj)) continue
    const text = stripInjected(extractContent(recordContent(obj)))
    if (text) {
      if (!task && obj.type === 'user') task = text
      content += text + '\n'
    }
  }

  return { cwd, branch, task, content: content.slice(0, cap) }
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
