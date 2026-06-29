import { basename } from 'path'
import { queryCodexSessions, findCodexSessions, parseCodexSession } from './parse-codex.js'
import { findClaudeSessions, indexClaudeSession } from './parse-claude.js'
import { queryOpenCodeSessions, queryOpenCodeContent } from './parse-opencode.js'
import { findGeminiSessions, parseGeminiSession } from './parse-gemini.js'
import { findAgySessions, parseAgySession } from './parse-agy.js'

// Cap on searchable conversation text per session. Keeps the in-memory index
// small (~tens of MB worst case) while still covering deep content.
const MAX_CONTENT = 64 * 1024

function turnsText(turns, cap = MAX_CONTENT) {
  let s = ''
  for (const t of turns) {
    if (s.length >= cap) break
    s += t.text + '\n'
  }
  return s.slice(0, cap)
}

function dateStr(ms) {
  return ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : ''
}

// Lowercased blob the picker filters against: metadata + conversation text, so a
// session is findable by anything said in it — not just its first message.
function makeSearch(tool, ms, cwd, task, content) {
  return [tool, dateStr(ms), cwd || '', task || '', content || ''].join('\n').toLowerCase()
}

// Returns a recency-sorted, cross-tool list of EVERY session (no per-tool cap),
// each carrying a `ref` to re-open it and a `search` blob for content filtering.
export function collectAllSessions({ filterDir = null } = {}) {
  const items = []

  // ── Codex (SQLite index, with filesystem fallback) ──────────────────────
  try {
    const rows = queryCodexSessions({ limit: 100000, filterDir })
    if (rows && rows.length) {
      for (const r of rows) {
        const dateMs = (r.updatedAt || 0) * 1000
        items.push({
          tool: 'codex', id: r.id, cwd: r.cwd, task: r.title, dateMs,
          ref: { tool: 'codex', id: r.id, rolloutPath: r.rolloutPath, cwd: r.cwd },
          search: makeSearch('codex', dateMs, r.cwd, r.title, r.firstMessage),
        })
      }
    } else {
      for (const { path, mtime } of findCodexSessions(filterDir)) {
        let cwd = null, task = basename(path), content = ''
        try { const p = parseCodexSession(path); cwd = p.cwd; task = p.task || task; content = turnsText(p.turns) } catch {}
        items.push({
          tool: 'codex', id: basename(path, '.jsonl'), cwd, task, dateMs: mtime,
          ref: { tool: 'codex', filePath: path, cwd },
          search: makeSearch('codex', mtime, cwd, task, content),
        })
      }
    }
  } catch {}

  // ── Claude (one JSONL per session under ~/.claude/projects) ──────────────
  try {
    for (const { path, mtime } of findClaudeSessions(filterDir)) {
      const { cwd, task, content } = indexClaudeSession(path, MAX_CONTENT)
      items.push({
        tool: 'claude', id: basename(path, '.jsonl'), cwd, task, dateMs: mtime,
        ref: { tool: 'claude', filePath: path, id: basename(path, '.jsonl'), cwd },
        search: makeSearch('claude', mtime, cwd, task, content),
      })
    }
  } catch {}

  // ── Gemini (JSONL chat logs under ~/.gemini/tmp) ─────────────────────────
  try {
    for (const { path, mtime } of findGeminiSessions(filterDir)) {
      let cwd = null, task = '', content = ''
      try { const p = parseGeminiSession(path); cwd = p.cwd; task = p.task; content = turnsText(p.turns) } catch {}
      items.push({
        tool: 'gemini', id: basename(path).replace(/\.(jsonl|json)$/, ''), cwd, task, dateMs: mtime,
        ref: { tool: 'gemini', filePath: path, cwd },
        search: makeSearch('gemini', mtime, cwd, task, content),
      })
    }
  } catch {}

  // ── Antigravity (JSONL transcripts under ~/.gemini/antigravity-cli/brain) ──
  try {
    for (const { path, mtime } of findAgySessions(filterDir)) {
      let cwd = null, task = '', content = ''
      try { const p = parseAgySession(path); cwd = p.cwd; task = p.task; content = turnsText(p.turns) } catch {}
      const parts = path.split('/')
      const id = parts[parts.length - 4]
      items.push({
        tool: 'agy', id, cwd, task, dateMs: mtime,
        ref: { tool: 'agy', filePath: path, id, cwd },
        search: makeSearch('agy', mtime, cwd, task, content),
      })
    }
  } catch {}

  // ── OpenCode (SQLite) ────────────────────────────────────────────────────
  try {
    const rows = queryOpenCodeSessions({ limit: 100000, filterDir })
    if (rows) {
      const contentMap = queryOpenCodeContent(MAX_CONTENT)
      for (const r of rows) {
        items.push({
          tool: 'opencode', id: r.id, cwd: r.cwd, task: r.title, dateMs: r.updatedAt || 0,
          ref: { tool: 'opencode', sessionId: r.id, cwd: r.cwd },
          search: makeSearch('opencode', r.updatedAt || 0, r.cwd, r.title, contentMap.get(r.id)),
        })
      }
    }
  } catch {}

  items.sort((a, b) => b.dateMs - a.dateMs)
  return items
}
