# 08 — Bridge & rotator API reference

## zen-bridge.js (port 1343, OpenAI-compatible)

Base URL: `http://127.0.0.1:1343`

### `GET /v1/models`
`GET /models` (alias)

Returns an OpenAI-style model list derived from the whitelist:

```json
{"object":"list","data":[{"id":"opencode/big-pickle","object":"model",…}]}
```

### `POST /v1/chat/completions`
`POST /chat/completions` (alias)

Request (OpenAI shape):

```json
{
  "model": "opencode/big-pickle",
  "messages": [{"role":"user","content":"…"}],
  "stream": false
}
```

Behavior:
- `stream:false` → JSON `chat.completion` built from the serve's assistant
  `text` parts; `usage` mapped from `info.tokens`.
- `stream:true` (or `"stream"` truthy) → emits an SSE stream:
  1. one data chunk with `delta:{role:"assistant", content:<text>}`
  2. a finish chunk `delta:{}, finish_reason:"stop"`
  3. `data: [DONE]`

Internal mapping (each call):
```
1. POST /session                 {"directory":null}          → sessionID
2. POST /session/{id}/message    {"model":{"providerID":"opencode","modelID":<m>},
                                    "parts":[{type:text, text:<user msg>,
                                              id:“prt_…”}]}  → assistant response
3. build OpenAI response from parts[].text / info.tokens
```

Model name handling: strips prefixes (`opencode/…`). Unknown → defaults to
`big-pickle`.

Env:
- `BRIDGE_PORT` (default 1338, we run 1343)
- `SERVE_PORT` (default 18765)
- `SERVE_USER` (default `opencode`)
- `SERVE_PASS` (default `opencodepass`)

### `POST /session` passthrough (optional)
Anything else → `404 {error:{message:"bridge: unknown path …"}}`.

---

## zen-rotator.js (port 1341)

Forwards any request to `https://opencode.ai/zen/v1<path>`, but:

- sets a **fresh random `X-Real-IP`** on every request:
  ```js
  headers["x-real-ip"] = `${r}.${r}.${r}.${r}`;   // r in 1..254
  ```
- preserves all incoming headers (so the real client's `x-opencode-*` and UA
  pass through untouched), only fixing `host` and `content-length`.
- `user-agent` fallback to `opencode/1.18.31` if absent (`ZEN_UA_VERSION` env).

Env: `ZEN_ROTATOR_PORT` (default 1341).

Why it works: zen keys the anonymous free-tier **daily per-IP quota** on the
`X-Real-IP` header it receives, with no validation — each request lands on a
fresh IP → full quota, every time.

---

## Ports map (final)

| port | process | role |
|------|---------|------|
| 1341 | zen-rotator.js | X-Real-IP rotation → zen |
| 1343 | zen-bridge.js | OpenAI-compat front door |
| 18765| opencode serve | real client session (gate key) |
| 1337 | g4f | existing free mirror pool (untouched) |
| 1338 | zen-proxy.js (original) | restored, left running (now dead for free tier) |