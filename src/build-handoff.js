import { getGitContext } from './git-context.js'

const TASK_MAX = 800
const TURN_MAX = 600
const LAST_ASSISTANT_MAX = 1200 // last assistant msg gets more room — it's the active work surface

function trunc(str, max) {
  if (!str) return ''
  str = str.trim()
  if (str.length <= max) return str
  return str.slice(0, max) + '…'
}

export function buildHandoff(source, parsed) {
  const { cwd, uuid, sessionId, startCommit, branch: parsedBranch, task, turns, filePath } = parsed
  const id = uuid || sessionId || 'unknown'
  const TOOL_NAMES = { codex: 'Codex', claude: 'Claude', gemini: 'Gemini', opencode: 'OpenCode', agy: 'Antigravity' }
  const toolName = TOOL_NAMES[source] || source

  const git = cwd ? getGitContext(cwd, startCommit) : null
  const branch = git?.branch || parsedBranch || null

  const lines = []

  // ── Directive first — models process top-down ──────────────────────────
  const article = /^[aeiou]/i.test(toolName) ? 'an' : 'a'
  lines.push(`Continue this work. You are picking up from ${article} ${toolName} session.`)
  if (cwd) lines.push(`Work in: ${cwd}`)
  if (branch) lines.push(`Branch: ${branch}`)
  lines.push('')

  // ── What was the goal ──────────────────────────────────────────────────
  lines.push('Task:')
  lines.push(`  ${trunc(task, TASK_MAX) || '(not found)'}`)

  // ── Git state — the ground truth of what's been done ───────────────────
  if (git) {
    if (git.log) {
      lines.push('')
      lines.push(startCommit ? 'Commits since session started:' : 'Recent commits:')
      git.log.split('\n').forEach(l => lines.push(`  ${l}`))
    }
    if (git.status) {
      lines.push('')
      lines.push('Uncommitted changes:')
      git.status.split('\n').forEach(l => lines.push(`  ${l}`))
    }
  }

  // ── Conversation context — last exchange is most valuable ──────────────
  if (turns.length) {
    lines.push('')
    lines.push(`Recent conversation (${turns.length} messages):`)
    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i]
      const label = turn.role === 'user' ? 'User' : toolName
      // Give the last assistant message more space — it's what was in-flight
      const isLastAssistant = turn.role === 'assistant' && i === turns.length - 1
      const max = isLastAssistant ? LAST_ASSISTANT_MAX : TURN_MAX
      lines.push(`  ${label}: ${trunc(turn.text, max)}`)
    }
  }

  // ── Session file pointer for deep context ──────────────────────────────
  if (filePath) {
    lines.push('')
    lines.push(`Full session transcript: ${filePath}`)
    lines.push(`Read this file if you need the complete conversation history.`)
  }

  return lines.join('\n')
}
