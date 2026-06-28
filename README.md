# rses

**Cross-resume between Claude Code, Codex CLI, Gemini CLI, OpenCode, and Antigravity CLI.**
Pick up where one AI coding agent left off — in another.

```
rses
```

Run it with no arguments to browse **every tool's sessions in one searchable picker**. Type to filter across tool, directory, and task; pick a session, then pick where to continue it.

```
rses claude with codex --last
```

Or go straight to a handoff: Claude launches with full context from your last Codex session — the original task, git diff, conversation history, and a pointer to the session file for deep-dive.

Works in all 20 directions between Claude Code, Codex CLI, Gemini CLI, OpenCode, and Antigravity CLI.

## Install

```bash
npm i -g rses-cli
```

Node.js 22+ required (uses built-in SQLite).

## Quick start

```bash
# You were working in Codex. Now you want Claude to continue.
rses claude with codex --last

# Or the other way around.
rses codex with claude --last

# OpenCode and Gemini work too — any combination.
rses opencode with codex --last
rses claude with opencode --last
rses claude with gemini --last
rses gemini with codex --last
rses agy with claude --last
rses claude with agy --last
```

## What it does

1. Reads the source tool's session data (JSONL files or SQLite)
2. Extracts: original task, git log since session start, working tree status, last N conversation turns
3. Includes a pointer to the full session file so the receiving model can `Read` it for complete history
4. Launches the target tool with a structured handoff prompt as the first message

The receiving model is oriented on turn one. No re-explaining.

## Commands

### Browse all sessions (no arguments)

```bash
rses                  # unified, searchable picker across all four tools
rses --dir .          # only sessions from the current directory
```

- **Type** to filter the merged list — each space-separated term must appear as a substring of the tool name, directory, or task (terms are AND-ed).
- **↑/↓** (or Ctrl-P / Ctrl-N) to move, **Enter** to pick, **Esc** to clear the filter / cancel.
- After selecting a session, choose where to continue it: hand off to another tool, or resume natively in the same tool where the CLI supports it (Claude, Codex).

### Handoff (main command)

```bash
rses <target> with <source> [session-id] [flags]

# Examples
rses claude with codex --last                    # most recent Codex session
rses codex with claude ses_46f04b499ffe...       # specific Claude session
rses opencode with codex                         # interactive picker
rses claude with codex --last --dry-run           # print handoff, don't launch
```

### List sessions

```bash
rses ls                    # all tools
rses ls codex              # just Codex
rses ls claude             # just Claude
rses ls gemini             # just Gemini
rses ls opencode           # just OpenCode
rses ls agy                # just Antigravity
rses ls codex --dir .      # filter by working directory
```

### Export

```bash
rses export codex <id>           # print handoff to stdout
rses export claude <id> --turns 10
```

## Aliases

Power-user shorthand — type less, ship faster:

| Alias | Expands to |
|-------|-----------|
| `cc`, `cl`, `c` | `claude` |
| `cdx`, `cx`, `x` | `codex` |
| `gm`, `gem`, `g` | `gemini` |
| `oc`, `o` | `opencode` |
| `agy`, `ag`, `a` | `agy` |
| `w` | `with` |

```bash
rses cc w cdx --last          # same as: rses claude with codex --last
rses x w oc --last            # same as: rses codex with opencode --last
rses ls cx                    # same as: rses ls codex
```

## Flags

| Flag | Description |
|------|-------------|
| `--last` | Use most recent session (no picker, no ID needed) |
| `--dry-run` | Print the handoff text without launching |
| `--dir <path>` | Filter sessions by working directory |
| `--turns <n>` | Number of conversation turns to include (default: 6) |

**Everything else is passed through to the target tool:**

```bash
rses claude with codex --last --dangerously-skip-permissions --model opus
rses codex with claude --last --model o3-pro
rses opencode with claude --last --provider anthropic
```

## How sessions are read

| Tool | Source | Upgrade-safe |
|------|--------|-------------|
| Claude Code | `~/.claude/projects/<dir>/<uuid>.jsonl` (legacy `~/.claude/transcripts/ses_*.jsonl` fallback) | Reads only `user`/`assistant` types; pulls `cwd`/`gitBranch` from the transcript |
| Codex CLI | `~/.codex/state_*.sqlite` (auto-discovers version) + JSONL fallback | Handles both 2025 and 2026 schemas |
| Gemini CLI | `~/.gemini/tmp/<projectHash>/chats/session-*.jsonl` (legacy `.json` fallback) | Reads only `user`/`gemini` records; `$set` / `$rewindTo` honored |
| OpenCode | `~/.local/share/opencode/opencode.db` | Single JOIN query, reads stable columns only |
| Antigravity | `~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript.jsonl` | Reads only `USER_INPUT` and `PLANNER_RESPONSE` records; discovers CWD from history, sqlite DB, or tool calls |

All parsers are read-only and wrapped in try/catch — if a tool changes its format, rses degrades gracefully instead of crashing.

## Requirements

- **Node.js 22+** (for built-in `node:sqlite`)
- At least one of: [Claude Code](https://docs.anthropic-ai/en/docs/claude-code), [Codex CLI](https://github.com/openai/codex), [Gemini CLI](https://github.com/google-gemini/gemini-cli), [OpenCode](https://github.com/opencode-ai/opencode), [Antigravity CLI](https://github.com/google-antigravity/antigravity-cli) (closed source)
- macOS or Linux (Windows support planned)

## License

MIT
