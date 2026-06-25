import { findCodexSessions, queryCodexSessions } from './parse-codex.js'
import { findClaudeSessions, peekClaudeSession } from './parse-claude.js'
import { queryOpenCodeSessions } from './parse-opencode.js'
import { findGeminiSessions, parseGeminiSession } from './parse-gemini.js'
import { readFileSync } from 'fs'
import { basename } from 'path'

function extractFirstTask(path, tool) {
  try {
    const raw = readFileSync(path, 'utf8')
    const lines = raw.split('\n').filter(l => l.trim())

    if (tool === 'codex') {
      // Try both schemas
      for (const line of lines) {
        let obj
        try { obj = JSON.parse(line) } catch { continue }

        // Schema A: event_msg user_message
        if (obj.type === 'event_msg' && obj.payload?.type === 'user_message') {
          return (obj.payload.message || '').slice(0, 70)
        }
        // Schema B: message role user with input_text
        if (obj.type === 'message' && obj.role === 'user') {
          const content = obj.content || []
          const text = Array.isArray(content)
            ? content.find(c => c.type === 'input_text')?.text || ''
            : ''
          // Skip environment context lines
          const cleaned = text.replace(/<environment_context>[\s\S]*?<\/environment_context>\s*/g, '').trim()
          if (cleaned) return cleaned.slice(0, 70)
        }
      }
    } else {
      for (const line of lines) {
        let obj
        try { obj = JSON.parse(line) } catch { continue }
        if (obj.type === 'user') {
          const c = obj.content
          const text = typeof c === 'string' ? c : (Array.isArray(c) ? c.find(x => x.type === 'text')?.text || '' : '')
          if (text) return text.slice(0, 70)
        }
      }
    }
  } catch {}
  return '(unreadable)'
}

function extractCwd(path, tool) {
  try {
    const raw = readFileSync(path, 'utf8')
    const lines = raw.split('\n').filter(l => l.trim())
    if (tool !== 'codex') return null

    for (const line of lines.slice(0, 10)) {
      let obj
      try { obj = JSON.parse(line) } catch { continue }
      // Schema A
      if (obj.payload?.cwd) return obj.payload.cwd
      // Schema B — CWD in environment_context inside user message
      if (obj.type === 'message' && obj.role === 'user') {
        const content = obj.content || []
        const text = Array.isArray(content) ? content.map(c => c.text || '').join('') : ''
        const m = text.match(/<cwd>(.*?)<\/cwd>/)
        if (m) return m[1]
      }
    }
  } catch {}
  return null
}

function formatDate(mtime) {
  const d = new Date(mtime)
  return d.toISOString().slice(0, 16).replace('T', ' ')
}

function padEnd(str, len) {
  if (!str) return ' '.repeat(len)
  return str.length >= len ? str.slice(0, len) : str + ' '.repeat(len - str.length)
}

export function lsSessions(tool, filterDir = null) {
  let rows

  if (tool === 'codex') {
    // Try SQLite first — same source as native picker, has clean titles
    const dbRows = queryCodexSessions({ limit: 20, filterDir })
    if (dbRows) {
      rows = dbRows.map(r => ({
        id: r.id,
        date: formatDate(r.updatedAt * 1000),
        cwd: r.cwd || '—',
        task: (r.title || '(no title)').slice(0, 70),
      }))
    }
  }

  if (tool === 'opencode') {
    const dbRows = queryOpenCodeSessions({ limit: 20, filterDir })
    if (dbRows?.length) {
      rows = dbRows.map(r => ({
        id: r.id,
        date: formatDate(r.updatedAt),
        cwd: r.cwd || '—',
        task: (r.title || '(no title)').slice(0, 70),
      }))
    }
  }

  if (!rows) {
    if (tool === 'opencode') {
      console.log('No opencode sessions found.')
      return
    }

    if (tool === 'gemini') {
      const sessions = findGeminiSessions(filterDir)
      if (!sessions.length) {
        console.log(`No ${tool} sessions found.`)
        return
      }
      rows = sessions.slice(0, 20).map(({ path, mtime }) => {
        const base = basename(path).replace(/\.(jsonl|json)$/, '')
        let id = base.split('-').pop()
        let cwd = '—', task = '(no task)'
        try {
          const p = parseGeminiSession(path)
          if (p.sessionId) id = p.sessionId
          if (p.cwd) cwd = p.cwd
          if (p.task) task = p.task.slice(0, 70)
        } catch {}
        return { id, date: formatDate(mtime), cwd, task }
      })
    } else if (tool === 'claude') {
      const sessions = findClaudeSessions(filterDir)
      if (!sessions.length) {
        console.log(`No ${tool} sessions found.`)
        return
      }
      rows = sessions.slice(0, 20).map(({ path, mtime }) => {
        const { cwd, task } = peekClaudeSession(path)
        return {
          id: basename(path, '.jsonl').replace(/^ses_/, ''),
          date: formatDate(mtime),
          cwd: cwd || '—',
          task: (task || '(no task)').slice(0, 70),
        }
      })
    } else {
      // Filesystem fallback (Codex without SQLite)
      const sessions = findCodexSessions(filterDir)

      if (!sessions.length) {
        console.log(`No ${tool} sessions found.`)
        return
      }

      rows = sessions.slice(0, 20).map(({ path, mtime }) => {
        const name = basename(path, '.jsonl')
        const id = name.split('-').slice(-5).join('-')
        const date = formatDate(mtime)
        const cwd = extractCwd(path, tool) || '—'
        const task = extractFirstTask(path, tool)
        return { id, date, cwd, task }
      })
    }
  }

  if (!rows.length) {
    console.log(`No ${tool} sessions found.`)
    return
  }

  const idLen = Math.min(38, Math.max(4, ...rows.map(r => r.id.length)))
  const cwdLen = Math.min(30, Math.max(3, ...rows.map(r => r.cwd.length)))

  console.log(`\n${tool.toUpperCase()} sessions (newest first):\n`)
  console.log(`  ${padEnd('ID', idLen)}  ${padEnd('DATE', 16)}  ${padEnd('CWD', cwdLen)}  TASK`)
  console.log(`  ${'-'.repeat(idLen)}  ${'-'.repeat(16)}  ${'-'.repeat(cwdLen)}  ${'-'.repeat(40)}`)

  for (const r of rows) {
    console.log(`  ${padEnd(r.id, idLen)}  ${padEnd(r.date, 16)}  ${padEnd(r.cwd.replace(process.env.HOME || '', '~'), cwdLen)}  ${r.task}`)
  }
  console.log()
}
