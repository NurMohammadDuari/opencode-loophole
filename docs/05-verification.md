# 05 — Verification (live transcripts)

Curl + the bridge's own session API were used throughout. Every number below is
from a real run.

## 5.1 Serve session API (the core proof)

```
POST http://127.0.0.1:18765/session        (Basic opencode:opencodepass)
  body: {"directory":null}
→ 200 {"id":"ses_f4675f9f3ffeMk9Sf7NjwWsc2W", "projectID":"global", …}

POST http://127.0.0.1:18765/session/ses_f4675f9f3ffeMk9Sf7NjwWsc2W/message
  body: {"model":{"providerID":"opencode","modelID":"big-pickle"},
         "parts":[{"type":"text","text":"Reply with exactly OK"}]}
→ 200  assistant: "OK",  model: opencode / big-pickle
```

## 5.2 Full chain via the bridge (non-streaming)

```
POST http://127.0.0.1:1343/v1/chat/completions
  {"model":"opencode/big-pickle",
   "messages":[{"role":"user","content":"Reply with exactly OK"}],
   "stream":false}

HTTP 200  time=4.42s
{"id":"chatcmpl-msg_0b98b13bd001Ght2wNXxlofZ5I",
 "object":"chat.completion",
 "model":"big-pickle",
 "choices":[{"index":0,
   "message":{"role":"assistant","content":"OK"},
   "finish_reason":"stop"}],
 "usage":{"total_tokens":8274},
 "system_fingerprint":"ses_f4674f265ffeMFs372headQ2w5"}
```

## 5.3 Full chain via the bridge (streaming)

```
POST http://127.0.0.1:1343/v1/chat/completions   stream:true

HTTP 200  time=4.57s
data: {"object":"chat.completion.chunk","choices":[
        {"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}
data: {"object":"chat.completion.chunk","choices":[
        {"delta":{},"finish_reason":"stop"}]}
data: [DONE]
```

## 5.4 Reboot/service-restart resilience

- Copied the serve config OUT of /tmp to `~/.local/share/opencode/servehome`
  so the serve survives reboots.
- Restarted `opencode-serve.service` → session API still 200.
- Re-ran the full bridge test after restart → **HTTP 200** again.

## 5.5 Systemd state at the end

```
$ systemctl --user is-enabled zen-rotator opencode-serve zen-bridge
enabled
enabled
enabled

$ ss -tlnp
127.0.0.1:18765  opencode     (serve)
0.0.0.0:1337     g4f          (unrelated)
127.0.0.1:1341   node         (rotator)
127.0.0.1:1343   node         (bridge)
127.0.0.1:1338   node         (original proxy, restored)
```

## 5.6 Error cases learned

- `prt_…` vs `msg_…`: the session `/message` parts need ids prefixed
  `prt_`, not `msg_` (bridge now uses `prt_`).
- Serve is HTTP, not HTTPS — the first bridge attempt used `https.request`
  and died with `wrong version number`; fixed to `http.request`.
- `ECONNREFUSED 127.0.0.1:1338` happened when the original proxy was briefly
  stopped; it was restored and is left untouched.