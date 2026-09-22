# Changelog

All notable changes to this project will be documented in this file.

## 2026-09-22 — Development visibility: tool narration + agent protocol

- **No more black box.** Every tool call the hidden serve agent makes is
  narrated into the client conversation *while it runs*: commands
  (`⚙ bash: …`), file edits with path and diff preview
  (`✎ edit src/app.js (+12 −3)` + changed lines), completions with output
  (`✔ … → result`), failures with the error (`✖ …`).
- New shared `narrateToolPart()` helper in `zen-bridge.js` (module scope,
  used by both the Responses and chat stream paths): rich per-tool detail,
  160-char clipping, and **de-duplication** of serve's repeated status
  events (previously the same `⚙` line was sent 3×).
- **Layer 2 — agent protocol**: the `zen` agent prompt in the serve config
  now embeds the condensed visibility rules: INSPECT → PLAN → EDIT →
  SHOW RESULT → TEST → REPORT, `FILE:`/`MODIFIED:` markers with diffs,
  command results with exit codes, progress markers on long tasks, and
  "never claim fixed/passed without running the check — write UNVERIFIED".
- Documented as the project contract in `docs/11-visibility.md`.

## 2026-09-21k — Visible thinking: stream reasoning to clients ("only thinking" fix)

- Diagnosis: during long agent turns the model is NOT stuck — DB watch showed
  steps advancing (reasoning → tool → reasoning). The app just shows an
  opaque spinner because reasoning parts were hidden from the stream.
- **Responses path**: reasoning deltas now stream as official
  `response.reasoning_summary_text.delta` events (item added/done around
  them), so clients can show live thinking. Answer text still never mixes
  with reasoning.
- **Chat SSE path**: reasoning mirrored as `delta.reasoning` chunks
  (OpenAI-style; unknown fields are ignored by clients that don't use it).
- Verified: reasoning visible from 6.7s, answer from 24.5s on the same turn;
  chat path emits `delta.reasoning` chunks. Disable with ZEN_STREAM_REASONING=0.

## 2026-09-21j — App+CLI test round: official variant mechanism wired end-to-end

- **CLI/app reject `-xhigh` model ids client-side** (`ProviderModelNotFoundError`)
  — confirmed by real `opencode run` tests; that suffix approach only worked
  via raw API calls. The official OpenCode mechanism is **model variants**.
- Client config now declares `variants` (xhigh/high/medium/low →
  reasoningEffort) for both muse-spark models; they appear in the TUI/app
  model picker under the base ids.
- **Bridge accepts the official wire format**: `reasoning_effort` (or
  `reasoning.effort`) in the request body now maps to serve's `variant`
  parameter on both /v1/chat/completions and /v1/responses paths. Verified:
  body effort=xhigh → variant logged, R 156 on a tiny prompt.
- CLI verified: persona OK ("My name is OpenCode."), 612/613/388-token
  streamed answers, 280-word history answer, TCP/UDP 250 words — all 200 via
  the bridge with reasoning tokens recorded.

## 2026-09-21i — THE 3-MINUTE KILLER: systemd unit forced ZEN_TIMEOUT_MS=180000

- **Root cause of "slow output then stops at ~3 min"**: the deployed
  `zen-bridge.service` carried `Environment=ZEN_TIMEOUT_MS=180000`, silently
  overriding the code's 900s default. Every long agent turn died at exactly
  180.0s (log proof: 180042/180025/180016ms, zero tokens counted because the
  kill raced the stream flush).
- Unit now sets `ZEN_TIMEOUT_MS=900000` and `STREAM_STALL_MS=300000` — the
  90s stall window previously finalized streams during silent tool runs
  (bash builds, scans) that produce no events for minutes.
- Live-verified: PID environment shows 900000/300000; streamed 1.3 turn:
  first token 5.9s, 479 words, clean finish.
- Lesson recorded: code defaults don't win over unit `Environment=` — both
  places are now kept in sync.

## 2026-09-21h — Extreme-detail dashboard: Now-Using hero, error forensics, variant/requested splits

- **"Now Using" hero panel** — shows the model your client config actually
  selects (with its source: cli vs app config) plus the last real completion
  (requested → served, variant badge, R tokens, status, duration, age).
  Diagnostic probes (Chain Test / curl / health checks) are excluded so the
  panel reflects *your* usage, not test traffic.
- **Errors & Recovery panel** — last 12 failures with requested/served model,
  variant, api path, status and error cause, so failures are explainable at a
  glance instead of hidden in a log wall.
- **Usage by Requested Model** — what you picked (incl. -xhigh ids) vs the
  existing served-model leaderboard; **Usage by Variant** — base vs xhigh with
  reasoning tokens and avg R per request; **API Split** — which code path
  (zen-responses / zen-stream / zen-live…) handled each request.
- Model leaderboard and daily-history tables now include reasoning-token
  columns; live-feed entries carry a [probe] tag for diagnostic traffic.
- Investigated "using 1.3 but dashboard shows 1.2 / kept failing": real cause
  was (a) diagnostic 1.2-xhigh probe traffic polluting the last-request panel
  and (b) 2 bogus 500 entries from the fixed logging ReferenceError. Verified
  live: muse-spark-1.3 & 1.3-xhigh serve correctly (R 1140 on xhigh).

## 2026-09-21g — Reasoning tokens in the dashboard + variant capture fix

- **BUG: the variant was silently dropped** — modelName() strips -xhigh
  before resolveZenModel could capture it, so xhigh requests ran at base
  effort. Capture now happens before stripping (tested: reasoning_tokens 495
  on an xhigh request, 0-ish on base).
- Bridge logs real reasoning tokens per completion (was hardcoded 0 in one
  path); usage exposes `reasoning_tokens` for clients.
- Dashboard: totals.reasoningTok + per-model reasoningTok aggregates,
  live-feed lines show `tok in→out (R N)`, last-detail card shows an
  R badge, Reasoning Tokens card added to the usage panel.
- Verified end-to-end: xhigh completion → bridge activity entry with
  reasoning=656/295 → dashboard totals.reasoningTok climbing.

## 2026-09-21f — Real xhigh support for muse-spark models

- The zen gateway REJECTS variant ids (`muse-spark-…-xhigh` → 401
  ModelError), which is why xhigh in the app broke while the CLI sometimes
  worked (the bridge's variant-suffix stripping made base requests succeed).
- The reasoning effort itself is real: serve accepts a `variant` parameter
  (verified: xhigh produces measurably more reasoning tokens than base).
- The bridge now splits variant from the id (resolveZenModel), keeps sending
  the base id to the gateway, and passes `variant: "xhigh"` to serve on all
  three request paths (sync, chat stream, responses stream).
- usage now includes `reasoning_tokens` so clients can see the effort level.
- Context limits added for the xhigh ids.
- Verified: base vs xhigh on the same prompt shows the effort difference
  (xhigh took 2.6x longer, more reasoning tokens); both muse models in xhigh
  stream 857-1145-word answers on the Responses path with clean completions.

## 2026-09-21e — App-path stability: reasoning-aware streaming, sane timeouts

Root causes found for "app starts, then stops outputting / blank replies"
(heavy models on the Responses path):

- **Hard timeout killed long agent turns mid-run** (180s): real agent work
  (reasoning → tools → tools → text) legitimately runs longer. Raised to 900s
  (tunable ZEN_TIMEOUT_MS). This caused the zen-stream-partial at 180s seen in
  the logs during a real reverse-engineering session.
- **Reasoning deltas leaked into answers / answer hidden**: OpenCode streams
  reasoning and answer as SEPARATE parts (reasoning first) but delta events
  only carry a partID. The bridge now classifies parts by type via
  message.part.updated (reasoning → hidden from output; text → answer) in both
  stream paths.
- **Idle detection counted only text**: a run that died or finished without
  streaming text hung until the hard timeout. Now ANY event (tool runs, part
  updates, reasoning deltas) counts as activity, and session.idle always
  finalizes — fetching the stored message text via sync when no deltas
  arrived (fixes blank output; text is in the DB, it just never streamed).
- **Stall window 45s → 90s** (tunable STREAM_STALL_MS): muse-spark pauses
  >45s between reasoning phases on big prompts.
- **SSE heartbeat every 10s** (`: keep-alive`) on the Responses path so
  proxies/clients don't kill idle connections during long thinking.
- **Recovery order flipped**: big-pickle is tried FIRST on empty-stream
  recovery (fastest, most reliable), then the original model with smaller
  bodies.

Verified: Responses-path tests on muse-spark-1.2 (478 / 346 / 1523 words,
all clean response.completed, no reasoning leak), CLI long answer OK.

## 2026-09-21d — Weekly auto-triage of all models

- `scripts/model-triage.py`: tests every whitelisted model id through the
  bridge (paced 2s apart), detects which models serve AS THEMSELVES, then
  rebuilds `zen_live_free` + `remap_to_zen_live` — keeping working manual
  targets, preferring same-family remaps (ling→ling, mimo→mimo, …), falling
  back to big-pickle/muse-spark. Aliases and context limits preserved.
- Safety rails: refuses to rewrite the catalog if the bridge is down or too
  few models are live (gateway outage), always keeps big-pickle as anchor.
- Deploys the fresh catalog to repo + all three runtime locations and
  restarts the bridge; writes a summary to
  `~/.local/share/opencode/model-triage-last.json`.
- `zen-model-triage.service` + `.timer`: systemd user timer, Sundays 04:17,
  Persistent=true (catches up if the machine was off), randomized ±20min.
  Enabled automatically by install.sh and update.sh.
- First live run: 31 tested, 7 self-served, 0 remap changes needed — catalog
  confirmed optimal without manual work.

## 2026-09-21c — Dashboard reflects the new fixes

- **Token History panel was empty**: the dashboard read
  `~/.local/share/opencode/token-history/` (created empty by the installer)
  while the bridge — running with HOME=servehome — writes the daily JSONL
  files inside the serve home. History dirs are now resolved dynamically
  (first dir that actually contains tokens-*.jsonl wins); today's row shows
  requests/ok/tokens/warnings again.
- **zen-proxy added to the services panel** (5th unit) with port, systemd
  state and controls; restart-all and per-service actions cover it too.
- Verified end-to-end: /api/status lists all 5 units running, /api/usage
  daily shows 2026-09-20 + 2026-09-21 with token totals, chain test returns
  ok:true with a real completion, SSE stream pushes live usage payload.

## 2026-09-21b — Real-CLI verification + missed Responses-path persona fix

- **Persona leak survived in the real opencode CLI/app** even after the first
  fix: the CLI uses the Responses streaming path, whose `prompt_async` call was
  the one call site still missing `agent: "zen"`. Fixed; all three serve-prompt
  call sites now drive the passthrough agent. Verified with the actual CLI:
  "What is your name?" → "I don't have a name." (was "My name is Muse Spark.")
- **Long output verified through the real CLI**: a 300-word request returned
  489 streamed words (the old 15s stall-killer chopped answers at ~100 words).
- Installer/update fixes: `zen-proxy.js` is now deployed (the unit runs it but
  fresh installs never copied it), and `config/models-catalog.json` synced with
  the live-corrected catalog so installs don't resurrect the stale model list.
- Security sweep: no secrets tracked in git, no tokens in any committed file,
  `auth.json` ignored (was previously tracked-but-ignored — confirmed absent
  from the index).

## 2026-09-21 — Persona fix, model triage, truncation fix, zen-proxy repair

- **"My name is Muse Spark." fixed** — the bridge now drives a custom
  passthrough `zen` agent (defined in the serve config) instead of OpenCode's
  built-in default agent, whose system prompt branded every reply. Client
  system prompts are honored again; a SYSTEM_TAG prefix plus an auto-injected
  lock part protect bare requests with no system message.
- **Only big-pickle / wrong-model output fixed** — live-tested all 31
  whitelisted model ids as pass-through (detecting which model actually
  serves): only 7 serve as themselves right now; dead ids now remap to
  verified-live models (deepseek-v4 → muse-spark, jev → big-pickle, etc.) so
  every model id returns a real answer in seconds instead of failing over.
- **Truncation fixed** ("stops at ~100 words") — mid-stream silence killer
  raised from a hardcoded 15s to STREAM_STALL_MS=45s (tunable); reasoning
  models that pause 30-60s mid-answer no longer get chopped. Verified with a
  926-word streamed answer ending in a clean finish_reason=stop.
- **zen-proxy crash-loop fixed** — removed a duplicated `function forward(`
  declaration (SyntaxError) introduced by a local edit; unit runs again.
- Catalog correctly deployed to the bridge's real load path inside servehome
  (previous deploys were silently ignored); serve restart required for new
  agent config to load.

## 2026-09-20f — One-command installer

- `scripts/install.sh`: single-command install — detects node/opencode (incl.
  nvm and ~/.opencode paths), deploys all files, generates systemd user units
  with machine-specific paths (no more hardcoded /home/mint), reuses an
  existing OpenCode auth.json, writes the client config if none exists,
  enables + starts all 4 services and verifies the bridge before reporting
  success. Idempotent — safe to re-run.
- `scripts/update.sh`: git pull + redeploy + restart without touching auth/logs
- `scripts/uninstall.sh`: clean removal; `--purge` also wipes servehome,
  activity logs and token history
- README rewritten around the installer; old manual steps kept in a collapsed
  <details> section with a note about the hardcoded unit paths
- Verified live end-to-end on the host: installer run → 4 units active →
  bridge completion 200 → dashboard reports all services listening

## 2026-09-20e — Persisted token history + context warnings

- Bridge persists every completion to daily JSONL files
  (`~/.local/share/opencode/.../token-history/tokens-YYYY-MM-DD.jsonl`) — token
  history now survives reboots; 90-day retention, prunable via TOKEN_HISTORY_DAYS
- Context limits per model added to models-catalog.json (context_limits, 128k
  default, big-pickle 190k, kimi-k2.5 256k)
- Bridge computes a context-usage estimate per request (larger of real tokens vs
  raw-char estimate) and logs it; level warning at 75% / critical at 90% of limit
  (CTX_WARN_PCT / CTX_CRIT_PCT); non-stream replies also carry
  x-context-warning / x-context-usage / x-context-limit headers
- Dashboard shows a warning banner for recent near-limit requests, ⚠ badges in
  the live stream and chain test, and a new per-day Token History table
  (requests, failures, tokens in/out/total, context warnings, avg time) with
  today highlighted
- Verified live: normal request → 2% no flag; 700k-char request → critical 92%
  surfaced in history, banner and today's warning count

## 2026-09-20d — Realtime usage dashboard + g4f fully removed

- Bridge now logs tokens (input/output/total/reasoning/cache) and context chars
  (in/out) for every completion, streamed and non-streamed
- Dashboard rebuilt as a realtime control center: usage cards, 30-minute activity
  chart, live completion stream with per-request token/context details, per-model
  usage leaderboard, service controls with journalctl logs, chain tester,
  sessions viewer (read-only opencode.db), and the rotator proof log
- One SSE channel feeds everything; efficient tail-follow reading replaces
  full-file re-reads; usage totals survive dashboard restarts via log replay
- Model-name normalization so `opencode/…` prefixes no longer split stats
- CSRF origin check on service-control endpoints
- Removed g4f entirely: service file deleted, dropped from dashboard, README
  and install steps; zen-only fallback (smaller body → big-pickle) documented
- Verified live end-to-end: JSON + SSE completions, token capture
  (e.g. in 6479 / out 3 / total 8274), service controls, proof viewer

## 2026-09-20c — Desktop blank output / endless "thinking" fixed at the root

Root cause: the bridge aborted healthy agent runs on fixed timers, then deleted the
serve session while the run was still active (SQLite FOREIGN KEY failures in serve).

- Activity-based deadlines: EMPTY_STREAM_GRACE_MS 25s → 90s (desktop builds spend
  20-30s on tool calls before the first text delta)
- Absolute ZEN_TIMEOUT_MS 90s → 180s; removed the 30s ZEN_REMAP_TIMEOUT_MS cap that
  killed long agent turns on remapped models
- Session DELETE now deferred 90s (SESSION_TTL_MS) so in-flight runs are never orphaned
  — no more UnknownError / blank output from FK constraint failures
- Idle after deltas now = clean DONE (no fetch, no recovery, no extra session churn)
- Recovery fan-out capped at 3 attempts (was 6 sequential 45s retries = 10-min hang)
- Removed stale g4f env vars from zen-bridge.service and duplicate scripts/
- Verified live: muse-spark sync + SSE + /v1/responses, big-pickle, remapped models
  (glm-5-free, kimi-k2.5-free, hy3-free), 31k-char and 700k-char desktop-style turns,
  3-turn agent session — all return real text, no blanks

## [Unreleased]
- Refactored UI to serve static assets.
- Updated README with new description and usage instructions.
- Added documentation files.

## [2026-09-20] - 2026-09-20
- Initial release of the opencode-zen-loophole project.

## 2026-09-20 — Desktop blank muse + unknown /v1/responses

- Accept `/responses`, `/v1/responses/`, and `/v1/v1/responses` (OpenCode desktop path variants)
- On stream idle-with-no-text: sync-recover same model, then big-pickle (fixes desktop "[zen: no response]")
- Remap non-live whitelist models (remap was previously skipped for whitelist ids)
- Remove g4f from client configs, dashboard services, and restart-all

## 2026-09-20b — Desktop 10min thinking / ContextOverflow

- Compact huge desktop agent histories before zen (MAX_PROMPT_CHARS)
- Recover empty streams with truncated then last-user-only bodies
- Strip -xhigh/-high model suffixes; empty-stream grace 25s (no 150s hang)
- Skip tool/image blobs that trigger muse invalid_request_error
