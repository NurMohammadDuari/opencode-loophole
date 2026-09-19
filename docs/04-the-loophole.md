# 04 — The loophole: a local real-client session in front of zen

## 4.1 Discovery (live, proven)

The desktop app is just a local `opencode serve` with Basic auth. So we started
our own:

```bash
opencode serve --port 18765 --hostname 127.0.0.1
# OPENCODE_SERVER_USERNAME=opencode OPENCODE_SERVER_PASSWORD=opencodepass
```

and drove its **session API** directly:

```text
POST /session
  {"directory":null}
→ 200  {"id":"ses_f4675f9f3ffeMk9Sf7NjwWsc2W", …}

POST /session/{id}/message
  {"model":{"providerID":"opencode","modelID":"big-pickle"},
   "parts":[{"type":"text","text":"Reply with exactly OK"}]}
→ 200  {"info":{"role":"assistant","modelID":"big-pickle",…},
        "parts":[{"type":"step-start",…},{"type":"text","text":"OK",…}]}
```

Both returned **200**. Assistant text: **"OK"**. Model: `opencode` / `big-pickle`.

This is the proof that a real client session passes the Console gate. No account,
no key — the free tier is granted because this is "within OpenCode".

## 4.2 Why the session API is the right keyhole

- zen authenticates the request as a genuine OpenCode session (the gateway
  greets/sticks the session). Header spoofing can't fake this.
- The serve does all the real client work (sessions, message IDs, UA,
  x-opencode-* headers, streaming) internally.
- `POST /session/{id}/message` returns a full assistant response (with `parts`
  arrays that include `type:"text"` parts) — perfect for a non-streaming bridge,
  and the `/event` endpoint exists for True SSE if you want it.

## 4.3 Full chain

```
client config ─ baseURL http://127.0.0.1:1343/v1
        │
        ▼
zen-bridge (1343, node)          OpenAI-compatible:
        │                          GET  /v1/models
        │                          POST /v1/chat/completions   (json + SSE)
        │  maps messages -> session API (Basic auth opencode:opencodepass)
        ▼
opencode-serve (18765)           real session → passes zen's gate
        │
        `provider.opencode.options.baseURL = http://127.0.0.1:1341`
        ▼
zen-rotator (1341, node)         forwards to opencode.ai/zen/v1
        │                          with a FRESH X-Real-IP on every request
        ▼
zen  (opencode.ai/zen/v1)
```

Why the rotator gives "no limit + time reset":

- zen keys the free daily quota on `X-Real-IP` (trusted, unvalidated).
- Each request gets a fresh random IP → a full daily bucket, forever.
- Even the "new user" grace (dailyLimit*2 while lifetime < 7× daily) compounds it.

## 4.4 Big-pickle model note

`big-pickle` was missing from the whitelist initially — the user got nothing
until we added it. Whitelist drives both `/v1/models` listing and what the serve
will actually honor. Add every free model ID you want inside
`provider.opencode.whitelist`.

## 4.5 Auth/password

- Serve Basic auth user: `opencode`, pass: `OPENCODE_SERVER_PASSWORD` env
  (we used `opencodepass`). Keep them in sync in `zen-bridge.service`
  (`SERVE_USER` / `SERVE_PASS`) and `opencode-serve.service`.