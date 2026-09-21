# Changelog

All notable changes to this project will be documented in this file.

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
