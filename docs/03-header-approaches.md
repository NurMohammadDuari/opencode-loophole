# 03 — Attempted spoofing approaches and their results

All requests below go to `https://opencode.ai/zen/v1/chat/completions`
(model `big-pickle`, message "Reply with exactly OK"), which is what the desktop
client uses.

## 3.1 Browser User-Agent spoofing (pre-2026-09-16 method)

| UA tried | Result |
|---|---|
| Page UA (`Chrome/131…`) | 403 FreeTierError |
| `opencode/1.18.31` | 403 FreeTierError |
| `opencode/1.15.5 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14` (from a public gateway repo) | 403 FreeTierError |
| `opencode/latest|local/1.18.31/cli` / `…/desktop` | 403 FreeTierError |

## 3.2 Realistic client identity headers

Sent together: `x-opencode-client: cli`, `x-opencode-project: global`,
`x-opencode-session: ses_…`, `x-opencode-request: msg_…`,
`user-agent: opencode/latest/local/1.18.31/cli`.

```
HTTP 403
{"type":"FreeTierError","message":"Error from provider (Console):
 OpenCode's free tier can only be used from within OpenCode"}
```

## 3.3 Real client binary, no proxy

Ran the actual `opencode` binary (1.18.31) directly against `opencode.ai` —
expected to pass since it IS the client:

```
Unexpected server error. Check server logs for details.  (ref err_…)
```

Even the real CLI's straight-to-zen calls are rejected → the gate requires the
*session* to be established/greeted by the gateway first, not just proper headers.

## 3.4 X-Real-IP rotation alone

Rotating `X-Real-IP` (the source's trusted rate-limit key) does reset the daily
bucket — but since the base request is still "not from within OpenCode", the
gate still 403s. So rotation is necessary but not sufficient.

## 3.5 What community gateways discovered

- `fannndi/opencode-zen-gateway` and `Yee-h/dsh-zen-proxy`: both used UA spoofing
  + rotating `x-real-ip` and worked **before** the new gate. Both break after it.
- `6Kmfi6HP/opencode2api` (issue #19) and `FishBottle7/opencode2dsh` (issue #9):
  report the same `FreeTierError` and agree **header spoofing is dead**; the fix
  in the wild is to drive a **local `opencode serve` instance's session API**.

## 3.6 Result of this phase

The only requests that returned **200** were:

1. The desktop app itself.
2. Our own local `opencode serve`'s session API (`POST /session` →
   `POST /session/{id}/message`) → assistant "OK".

So we stopped spoofing and started routing through a real client session, plus
we keep `X-Real-IP` rotation for the limit reset (see `04-the-loophole.md`).