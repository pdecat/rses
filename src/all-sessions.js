import { basename } from 'path'
import { queryCodexSessions, findCodexSessions } from './parse-codex.js'
import { findClaudeSessions, peekClaudeSession } from './parse-claude.js'
import { queryOpenCodeSessions } from './parse-opencode.js'
import { findGeminiSessions, parseGeminiSession } from './parse-gemini.js'

// How many sessions to pull per tool before merging. The picker's fuzzy search
// filters the merged list, so this just bounds startup cost.
const PER_TOOL = 50

// Returns a recency-sorted, cross-tool list of sessions. Each item carries a
// `ref` describing how to re-open it (file path or session id) so the caller
// can build a handoff or resume natively without re-discovering the session.
export function collectAllSessions({ filterDir = null } = {}) {
  const items = []

  // ── Codex (SQLite index, with filesystem fallback) ──────────────────────
  try {
    const rows = queryCodexSessions({ limit: PER_TOOL, filterDir })
    if (rows && rows.length) {
      for (const r of rows) {
        items.push({
          tool: 'codex',
          id: r.id,
          cwd: r.cwd,
          task: r.title,
          dateMs: (r.updatedAt || 0) * 1000,
          ref: { tool: 'codex', id: r.id, rolloutPath: r.rolloutPath },
        })
      }
    } else {
      for (const { path, mtime } of findCodexSessions(filterDir).slice(0, PER_TOOL)) {
        items.push({
          tool: 'codex',
          id: basename(path, '.jsonl'),
          cwd: null,
          task: basename(path),
          dateMs: mtime,
          ref: { tool: 'codex', filePath: path },
        })
      }
    }
  } catch {}

  // ── Claude (one JSONL per session under ~/.claude/projects) ──────────────
  try {
    for (const { path, mtime } of findClaudeSessions(filterDir).slice(0, PER_TOOL)) {
      const { cwd, task } = peekClaudeSession(path)
      items.push({
        tool: 'claude',
        id: basename(path, '.jsonl'),
        cwd,
        task,
        dateMs: mtime,
        ref: { tool: 'claude', filePath: path, id: basename(path, '.jsonl'), cwd },
      })
    }
  } catch {}

  // ── Gemini (JSONL chat logs under ~/.gemini/tmp) ─────────────────────────
  try {
    for (const { path, mtime } of findGeminiSessions(filterDir).slice(0, PER_TOOL)) {
      let cwd = null, task = ''
      try {
        const p = parseGeminiSession(path)
        cwd = p.cwd
        task = p.task
      } catch {}
      items.push({
        tool: 'gemini',
        id: basename(path).replace(/\.(jsonl|json)$/, ''),
        cwd,
        task,
        dateMs: mtime,
        ref: { tool: 'gemini', filePath: path, cwd },
      })
    }
  } catch {}

  // ── OpenCode (SQLite) ────────────────────────────────────────────────────
  try {
    const rows = queryOpenCodeSessions({ limit: PER_TOOL, filterDir })
    if (rows) {
      for (const r of rows) {
        items.push({
          tool: 'opencode',
          id: r.id,
          cwd: r.cwd,
          task: r.title,
          dateMs: r.updatedAt || 0,
          ref: { tool: 'opencode', sessionId: r.id, cwd: r.cwd },
        })
      }
    }
  } catch {}

  items.sort((a, b) => b.dateMs - a.dateMs)
  return items
}
