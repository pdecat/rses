import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'
import { DatabaseSync } from 'node:sqlite'

const AGY_DIR = join(homedir(), '.gemini', 'antigravity-cli')
const BRAIN_DIR = join(AGY_DIR, 'brain')
const CONVS_DIR = join(AGY_DIR, 'conversations')
const HISTORY_FILE = join(AGY_DIR, 'history.jsonl')

let _cwdMap = null
function loadAgyCwdMap() {
  if (_cwdMap) return _cwdMap
  const map = {}
  try {
    if (existsSync(HISTORY_FILE)) {
      const raw = readFileSync(HISTORY_FILE, 'utf8')
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try {
          const obj = JSON.parse(line)
          if (obj.conversationId && obj.workspace) {
            map[obj.conversationId] = obj.workspace
          }
        } catch {}
      }
    }
  } catch {}
  _cwdMap = map
  return map
}

function extractCwdFromBuffer(buf) {
  const str = buf.toString('utf8')
  const match = str.match(/file:\/\/([^\x00-\x1f"'\s]+)/)
  if (match) {
    return match[1]
  }
  return null
}

function getCwdFromDb(sessionId) {
  const dbPath = join(CONVS_DIR, `${sessionId}.db`)
  if (!existsSync(dbPath)) return null
  try {
    const db = new DatabaseSync(dbPath, { readonly: true })
    const row = db.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main'").get()
    db.close()
    if (row && row.data) {
      return extractCwdFromBuffer(Buffer.from(row.data))
    }
  } catch {}
  return null
}

function getCwdFromTranscript(lines) {
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const obj = JSON.parse(line)
      if (obj.tool_calls) {
        for (const tc of obj.tool_calls) {
          if (tc.args) {
            let tcCwd = tc.args.Cwd || tc.args.DirectoryPath
            if (tcCwd) {
              if (typeof tcCwd === 'string') {
                if (tcCwd.startsWith('"') && tcCwd.endsWith('"')) {
                  tcCwd = tcCwd.slice(1, -1)
                }
                return tcCwd
              }
            }
          }
        }
      }
    } catch {}
  }
  return null
}

export function peekAgySession(filePath) {
  const sessionId = basename(join(filePath, '..', '..', '..'))
  const cwdMap = loadAgyCwdMap()
  let cwd = cwdMap[sessionId] || getCwdFromDb(sessionId) || null
  let task = ''

  let raw
  try { raw = readFileSync(filePath, 'utf8') } catch { return { cwd, task } }
  const lines = raw.split('\n')

  if (!cwd) {
    cwd = getCwdFromTranscript(lines)
  }

  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const obj = JSON.parse(line)
      if (obj.type === 'USER_INPUT' && obj.content) {
        const userRequestMatch = obj.content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/)
        task = userRequestMatch ? userRequestMatch[1].trim() : obj.content.trim()
        break
      }
    } catch {}
  }

  return { cwd, task }
}

export function parseAgySession(filePath) {
  const sessionId = basename(join(filePath, '..', '..', '..'))
  const raw = readFileSync(filePath, 'utf8')
  const lines = raw.split('\n')

  const cwdMap = loadAgyCwdMap()
  let cwd = cwdMap[sessionId] || getCwdFromDb(sessionId) || getCwdFromTranscript(lines) || null
  const turns = []

  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const obj = JSON.parse(line)
      if (obj.type === 'USER_INPUT' && obj.content) {
        const userRequestMatch = obj.content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/)
        const text = userRequestMatch ? userRequestMatch[1].trim() : obj.content.trim()
        if (text) turns.push({ role: 'user', text })
      } else if (obj.type === 'PLANNER_RESPONSE' && obj.content) {
        const text = obj.content.trim()
        if (text) turns.push({ role: 'assistant', text })
      }
    } catch {}
  }

  const taskTurn = turns.find(t => t.role === 'user')
  const task = taskTurn?.text || ''

  return { sessionId, cwd, branch: null, startCommit: null, task, turns }
}

export function findAgySessions(filterDir = null) {
  const all = []
  let subdirs
  try { subdirs = readdirSync(BRAIN_DIR) } catch { return [] }

  for (const sub of subdirs) {
    const transcriptPath = join(BRAIN_DIR, sub, '.system_generated', 'logs', 'transcript.jsonl')
    if (existsSync(transcriptPath)) {
      let mtime = 0
      try { mtime = statSync(transcriptPath).mtimeMs } catch { continue }
      all.push({ path: transcriptPath, mtime })
    }
  }

  all.sort((a, b) => b.mtime - a.mtime)

  if (!filterDir) return all

  return all.filter(({ path }) => {
    const { cwd } = peekAgySession(path)
    return cwd && (cwd === filterDir || cwd.startsWith(filterDir + '/'))
  })
}

export function findAgySessionById(id) {
  if (!id) return null
  const normalized = id.toLowerCase()
  let subdirs
  try { subdirs = readdirSync(BRAIN_DIR) } catch { return null }

  for (const sub of subdirs) {
    const base = sub.toLowerCase()
    if (base === normalized || base.startsWith(normalized)) {
      const transcriptPath = join(BRAIN_DIR, sub, '.system_generated', 'logs', 'transcript.jsonl')
      if (existsSync(transcriptPath)) return transcriptPath
    }
  }
  return null
}

export function getLastAgySession(filterDir = null) {
  const sessions = findAgySessions(filterDir)
  return sessions[0]?.path || null
}
