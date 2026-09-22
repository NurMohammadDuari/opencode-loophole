# 11 — Visibility: no black-box development

## The rule

The OpenCode desktop app / CLI and the zen bridge may run servers,
workers and tools in the background — that is normal. What must never be
hidden is the **development process**: every file operation, code change,
command, diff, test, error and result has to be surfaced in the
conversation.

The user should be able to say:

> I can see what OpenCode is inspecting. I can see what it is changing.
> I can see the important code, the diffs, the commands, the test
> results, the errors, the fixes — I can see the project evolving.

## How it is implemented — two layers

### Layer 1 — bridge narration (mechanical, guaranteed)

`zen-bridge.js` taps serve tool events (`message.part.updated`,
`part.type === "tool"`) and narrates every tool call into the client's
**reasoning stream while the turn is still running**:

| Symbol | Meaning | Example line |
|---|---|---|
| `⚙` | tool started | `⚙ bash: npm test` |
| `✎` | file being created/changed | `✎ edit: src/app.js (+12 −3)` |
| `✔` | tool finished + result | `✔ bash echo hi → hi` |
| `│` | diff preview (edits) | `│ + const x = 1;` |
| `✖` | tool failed + error | `✖ bash failed → exit 1 …` |

Implementation facts:

- **Responses path** (app + modern clients): official
  `response.reasoning_summary_text.delta` events.
- **Chat path**: mirrored into the `delta.reasoning` field — clients that
  don't know the field ignore it safely.
- Reasoning **never mixes into answer text** — separate channel by design.
- **De-duplicated**: serve fires repeated `running` updates; each
  `partId:status:detail` line is emitted exactly once (this fixed the
  observed 3× duplicate `⚙` lines).
- Per-tool detail: `bash` → command (140 chars), `edit/patch` → file +
  `(+added −removed)` + up to 3 changed lines, `write` → file + line
  count, `read` → path, `grep/glob` → pattern + directory.
- Disable entirely with `ZEN_STREAM_REASONING=0` on the bridge unit.
- Hard caps: detail clipped to 160 chars, output preview to 120 chars,
  reasoning stream subject to the existing 900s timeout / 300s stall.

### Layer 2 — agent visibility protocol (semantic)

The `zen` agent `prompt` in `config/serve-opencode.json` (mirrored into
the live serve config at
`servehome/.config/opencode/opencode.json`) carries the condensed
protocol:

1. Flow: **INSPECT → PLAN → EDIT → SHOW RESULT → TEST → REPORT**
2. `FILE: <path>` + WHY before a change, `MODIFIED: <path>` + diff after
3. Commands reported with result / exit code; errors shown verbatim then cause then fix
4. Progress markers on long tasks: CURRENT PHASE / FILES CHANGED / NEXT ACTION
5. Never claim fixed/passed/complete without running the check — write **UNVERIFIED**
6. Show code/diffs as the changed region with file path, not a summary

## What you see in the app / CLI

1. Live thinking streams before the answer (reasoning channel).
2. Tool activity lines with file paths, commands and diff previews.
3. The model's own step-by-step narration following the protocol.
4. The dashboard (`:1395`) adds a **Live Agent Activity** panel — every
   narrated tool line (commands, edits, diff previews, results) as it
   happens, pushed over the same 2s SSE as the usage numbers — plus
   per-completion tokens, reasoning tokens, requested→served models and
   an Errors & Recovery panel. Works even when a client GUI renders
   nothing.

## Honest scope notes

- Narration is **verified at the protocol level** (raw SSE captured with
  `⚙` / `✔` lines present and deduped). Whether a given client GUI
  *renders* reasoning parts is the client's choice — OpenCode renders
  reasoning parts for reasoning-capable models, which is this channel.
- The dashboard shows per-tool events live (`event:"narration"` entries in
  `bridge-activity.jsonl`, ring of 300, last 40 in the payload) alongside
  per-completion telemetry.
- Tool events originate from the hidden serve session; narration is a
  faithful projection of those events, not a re-execution.
