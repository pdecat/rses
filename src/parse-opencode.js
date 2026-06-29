import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { DatabaseSync } from 'node:sqlite'

const DB_PATH = join(homedir(), '.local', 'share', 'opencode', 'opencode.db')

function getDb() {
  if (!existsSync(DB_PATH)) return null
  try {
    return new DatabaseSync(DB_PATH, { readonly: true })
  } catch {
    return null
  }
}

// ── Session listing ─────────────────────────────────────────────────────────

export function queryOpenCodeSessions({ limit = 30, filterDir = null } = {}) {
  const db = getDb()
  if (!db) return null

  try {
    let sql = `
      SELECT id, title, directory, time_created, time_updated
      FROM session
      WHERE time_archived IS NULL AND parent_id IS NULL
    `
    const params = []

    if (filterDir) {
      sql += ` AND (directory = ? OR directory LIKE ?)`
      params.push(filterDir, filterDir + '/%')
    }

    sql += ` ORDER BY time_updated DESC LIMIT ?`
    params.push(limit)

    const rows = db.prepare(sql).all(...params)
    db.close()
    return rows.map(r => ({
      id: r.id,
      title: r.title || '',
      cwd: r.directory || null,
      updatedAt: r.time_updated, // epoch millis
    }))
  } catch {
    try { db.close() } catch {}
    return null
  }
}

// Concatenated (capped) message text per session for content search, in one
// query instead of one parse per session. Returns Map(sessionId -> text).
export function queryOpenCodeContent(cap = 64 * 1024) {
  const db = getDb()
  if (!db) return new Map()
  try {
    const rows = db.prepare(`
      SELECT m.session_id AS sid, p.data AS data
      FROM message m
      JOIN part p ON p.message_id = m.id
      ORDER BY m.session_id, m.time_created ASC, p.time_created ASC
    `).all()
    db.close()
    const map = new Map()
    for (const r of rows) {
      const cur = map.get(r.sid) || ''
      if (cur.length >= cap) continue
      let text = ''
      try { const pd = JSON.parse(r.data); if (pd.type === 'text' && pd.text) text = pd.text } catch {}
      if (text) map.set(r.sid, cur + text + '\n')
    }
    return map
  } catch {
    try { db.close() } catch {}
    return new Map()
  }
}

// ── Session parsing ─────────────────────────────────────────────────────────

export function parseOpenCodeSession(sessionId) {
  const db = getDb()
  if (!db) throw new Error('OpenCode database not found')

  try {
    const session = db.prepare('SELECT * FROM session WHERE id = ? LIMIT 1').get(sessionId)
    if (!session) {
      db.close()
      throw new Error(`OpenCode session not found: ${sessionId}`)
    }

    // Single query: join messages + text parts to avoid N+1
    const rows = db.prepare(`
      SELECT m.id AS msg_id, m.data AS msg_data, p.data AS part_data
      FROM message m
      LEFT JOIN part p ON p.message_id = m.id
      WHERE m.session_id = ?
      ORDER BY m.time_created ASC, p.time_created ASC
    `).all(sessionId)

    // Group parts by message
    const msgMap = new Map()
    for (const row of rows) {
      if (!msgMap.has(row.msg_id)) {
        msgMap.set(row.msg_id, { data: row.msg_data, parts: [] })
      }
      if (row.part_data) msgMap.get(row.msg_id).parts.push(row.part_data)
    }

    const turns = []
    for (const [, msg] of msgMap) {
      let msgData
      try { msgData = JSON.parse(msg.data) } catch { continue }

      const role = msgData.role
      if (role !== 'user' && role !== 'assistant') continue

      const textParts = []
      for (const raw of msg.parts) {
        let partData
        try { partData = JSON.parse(raw) } catch { continue }
        if (partData.type === 'text' && partData.text) {
          textParts.push(partData.text)
        }
      }

      const text = textParts.join('\n').trim()
      if (text) turns.push({ role, text })
    }

    const cwd = session.directory || null
    const taskTurn = turns.find(t => t.role === 'user')
    const task = taskTurn?.text || ''

    db.close()
    return {
      sessionId: session.id,
      cwd,
      startCommit: null,
      task,
      turns,
    }
  } catch (e) {
    try { db.close() } catch {}
    throw e
  }
}

// ── Session lookup ──────────────────────────────────────────────────────────

export function findOpenCodeSessionById(id) {
  const db = getDb()
  if (!db) return null
  try {
    const row = db.prepare('SELECT id FROM session WHERE id = ? LIMIT 1').get(id)
    db.close()
    return row ? row.id : null
  } catch {
    try { db.close() } catch {}
    return null
  }
}

export function getLastOpenCodeSession(filterDir = null) {
  const sessions = queryOpenCodeSessions({ limit: 1, filterDir })
  return sessions?.[0]?.id || null
}

export function findOpenCodeSessions(filterDir = null) {
  return queryOpenCodeSessions({ limit: 30, filterDir }) || []
}
