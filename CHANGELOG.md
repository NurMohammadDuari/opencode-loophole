# Changelog

All notable changes to this project will be documented in this file.

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
