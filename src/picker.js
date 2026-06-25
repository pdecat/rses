// Minimal raw-mode terminal picker with type-to-filter substring search — zero npm deps
const ESC = '\x1b'
const UP = '\x1b[A'
const DOWN = '\x1b[B'
const ENTER = '\r'
const CTRL_C = '\x03'
const CTRL_P = '\x10'
const CTRL_N = '\x0e'
const CTRL_U = '\x15'
const BACKSPACE = '\x7f'
const BACKSPACE2 = '\x08'

const ANSI = /\x1b\[[0-9;]*m/g
const stripAnsi = s => s.replace(ANSI, '')
const visibleLen = s => stripAnsi(s).length

// Truncate a string to maxLen visible chars, appending … if cut
function truncate(s, maxLen) {
  const clean = stripAnsi(s)
  if (clean.length <= maxLen) return s
  return s.slice(0, maxLen - 1) + '…'
}

// How many terminal rows does a string take given terminal width?
function lineCount(s, cols) {
  return Math.max(1, Math.ceil(visibleLen(s) / cols))
}

function cols() {
  return (process.stdout.columns || 120) - 2 // leave 2-char margin
}

function clearLines(count) {
  for (let i = 0; i < count; i++) {
    process.stdout.write('\x1b[2K\x1b[1A')
  }
  process.stdout.write('\x1b[2K')
}

// ── Matching ────────────────────────────────────────────────────────────────
// A token must appear as a contiguous (case-insensitive) substring — not just
// as scattered characters — so filtering stays tight and predictable. The best
// occurrence is scored, favouring the start of the line and word boundaries so
// the most relevant rows sort first. Returns -1 when the token isn't present.
const BOUNDARY = /[\s/_\-.:]/
function tokenScore(token, text) {
  let best = -1
  for (let idx = text.indexOf(token); idx !== -1; idx = text.indexOf(token, idx + 1)) {
    let s = 10 // base for a substring hit
    if (idx === 0) s += 8 // start of line (e.g. the tool column)
    else if (BOUNDARY.test(text[idx - 1])) s += 5 // word boundary
    s += Math.max(0, 5 - Math.floor(idx / 10)) // earlier in the row is slightly better
    if (s > best) best = s
  }
  return best
}

// Whitespace-separated tokens are AND-ed and order-independent, so
// "claude rses" matches a row regardless of which column each word is in.
export function matchScore(query, text) {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!tokens.length) return 0
  const t = text.toLowerCase()
  let total = 0
  for (const tok of tokens) {
    const s = tokenScore(tok, t)
    if (s < 0) return -1
    total += s
  }
  return total
}

export function filterItems(items, query) {
  if (!query.trim()) return items.slice()
  const scored = []
  for (let i = 0; i < items.length; i++) {
    const s = matchScore(query, stripAnsi(items[i].display))
    if (s >= 0) scored.push({ item: items[i], i, s })
  }
  scored.sort((a, b) => b.s - a.s || a.i - b.i) // best score, ties keep original (recency) order
  return scored.map(x => x.item)
}

function render(filtered, cursor, maxVisible, query, total) {
  const termCols = cols()
  const out = []
  let totalLines = 0

  if (!filtered.length) {
    out.push('\x1b[2m  (no matches)\x1b[0m')
    totalLines += 1
  } else {
    const visible = Math.min(maxVisible, filtered.length)
    const start = Math.max(0, Math.min(cursor - Math.floor(visible / 2), filtered.length - visible))
    const end = Math.min(start + visible, filtered.length)

    for (let i = start; i < end; i++) {
      const selected = i === cursor
      const prefix = selected ? '▶ ' : '  '
      const raw = truncate(filtered[i].display, termCols - 4)
      const line = `${prefix}${raw}`
      out.push(selected ? `\x1b[1;36m${line}\x1b[0m` : `\x1b[2m${line}\x1b[0m`)
      totalLines += lineCount(line, termCols)
    }
  }

  const count = filtered.length === total ? `${total}` : `${filtered.length}/${total}`
  const pos = filtered.length ? `${cursor + 1}·` : ''
  out.push(`\x1b[2m  ${pos}${count}  type to filter · ↑↓ · Enter · Esc\x1b[0m`)
  totalLines += 1
  out.push(`\x1b[1m❯ \x1b[0m${query}\x1b[7m \x1b[0m`) // search input with block cursor
  totalLines += 1

  process.stdout.write(out.join('\n'))
  return totalLines
}

export function pick(items, header) {
  return new Promise((resolve) => {
    if (!items.length) { resolve(null); return }

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      resolve(null); return
    }

    const termRows = process.stdout.rows || 24
    const maxVisible = Math.max(3, Math.min(items.length, termRows - 6))
    let query = ''
    let filtered = items.slice()
    let cursor = 0
    let linesWritten = 0
    let headerLines = 0

    if (header) {
      process.stdout.write(`\n\x1b[1m${header}\x1b[0m\n`)
      headerLines = 2 // blank line before + header line
    }

    linesWritten = render(filtered, cursor, maxVisible, query, items.length)

    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')

    function redraw() {
      clearLines(linesWritten)
      linesWritten = render(filtered, cursor, maxVisible, query, items.length)
    }

    function refilter() {
      filtered = filterItems(items, query)
      cursor = 0
    }

    function cleanup(result) {
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdin.removeListener('data', onData)
      clearLines(linesWritten)
      if (headerLines) clearLines(headerLines)
      process.stdout.write('\n')
      resolve(result)
    }

    function onData(key) {
      if (key === CTRL_C) {
        cleanup(null)
      } else if (key === ESC && key.length === 1) {
        // Esc clears an active query first, then cancels.
        if (query) { query = ''; refilter(); redraw() } else cleanup(null)
      } else if (key === UP || key === CTRL_P) {
        cursor = Math.max(0, cursor - 1)
        redraw()
      } else if (key === DOWN || key === CTRL_N) {
        cursor = Math.min(filtered.length - 1, cursor + 1)
        redraw()
      } else if (key === ENTER) {
        if (filtered.length) cleanup(filtered[cursor].value)
      } else if (key === BACKSPACE || key === BACKSPACE2) {
        if (query) { query = query.slice(0, -1); refilter(); redraw() }
      } else if (key === CTRL_U) {
        if (query) { query = ''; refilter(); redraw() }
      } else if (/^[\x20-\x7e]+$/.test(key)) {
        // Printable input (single keystroke or a paste) becomes the query.
        query += key
        refilter()
        redraw()
      }
    }

    process.stdin.on('data', onData)
  })
}
