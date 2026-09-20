# Changelog

All notable changes to this project will be documented in this file.

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
