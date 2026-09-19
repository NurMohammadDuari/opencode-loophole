# Evidence — raw outputs (real runs)

Each file is verbatim output captured during the session.

| file | source | meaning |
|------|--------|---------|
| `e2e.txt` | bridge :1343 non-streaming | first success; content "OK", HTTP via curl was 200 |
| `final.txt` | bridge :1343 non-streaming | after bridge fix + prt_ ids; content "OK", usage 8274 |
| `stream.txt` | bridge :1343 streaming | SSE chunks → "OK" → finish_reason:stop → [DONE] |
| `reboot.txt` | bridge :1343 after service restart | persisted after config moved to servehome; content "OK" |
| `proxy_test.txt` | old zen-proxy :1338, model `opencode/big-pickle` | `401 ModelError` (path/model mismatch through old proxy) |
| `proxy_test2.txt` | old zen-proxy :1338, model `big-pickle` | `403 FreeTierError` — confirms 1338 direct-to-zen is dead |
| `proxy_hdrs.txt` | old zen-proxy :1338 with realistic x-opencode-* headers | `403 FreeTierError` — headers alone can't pass the gate |

Key files inline (abridged):

`final.txt`:
```json
{"id":"chatcmpl-msg_0b98b13bd001Ght2wNXxlofZ5I","object":"chat.completion",
 "created":1789819297,"model":"big-pickle",
 "choices":[{"index":0,"message":{"role":"assistant","content":"OK"},
             "finish_reason":"stop"}],
 "usage":{"total_tokens":8274},
 "system_fingerprint":"ses_f4674f265ffeMFs372headQ2w5"}
```

`stream.txt`:
```
data: {"id":"chatcmpl-msg_0b99cdd43001nZEfTXP06XMNpg","object":"chat.completion.chunk",
       "created":1789820464,"model":"big-pickle",
       "choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},
                   "finish_reason":null}]}

data: {"id":"chatcmpl-msg_0b99cdd43001nZEfTXP06XMNpg","object":"chat.completion.chunk",
       "created":1789820464,"model":"big-pickle",
       "choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

`proxy_test2.txt` (the failure that proved 1338→zen is dead):
```json
{"type":"error","error":{"type":"FreeTierError",
 "message":"Error from provider (Console): OpenCode's free tier can only be used from within OpenCode"}}
```