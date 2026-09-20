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
