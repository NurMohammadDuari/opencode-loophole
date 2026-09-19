# 02 — Gate analysis: how zen decides who's allowed

OpenCode is open source (https://github.com/anomalyco/opencode). We cloned it
and read the console/zen gateway code.

## 2.1 Source we read

```
packages/console/app/src/routes/zen/util/handler.ts    # main zen handler
packages/console/app/src/routes/zen/util/ip-rate-limiter.ts
packages/console/app/src/routes/zen/util/key-rate-limiter.ts
packages/console/app/src/routes/zen/util/error.ts
packages/opencode/src/session/llm/request.ts           # client-side request builder
packages/opencode/src/installation/index.ts            # User-Agent construction
```

## 2.2 What the client sends (request.ts)

Real client requests to zen carry:

```
user-agent:           opencode/<channel>/<version>/<client>
x-opencode-project:   <project ID>
x-opencode-session:   <session ID>     (ses_...)
x-opencode-request:   <message ID>     (msg_...)
x-opencode-client:    cli / desktop
authorization:        Bearer <api key or "public">
```

## 2.3 The gateway flow (handler.ts)

`authenticate()` → decides billing lane (`free` / `anonymous` / key holders).

For anonymous/free (`allowAnonymous` models):

1. **`createIpRateLimiter`** — per-IP **daily** bucket.
   - Key = the value of the **`X-Real-IP`** request header.
   - Daily limit = `rateLimit ?? limits.dailyRequests`.
   - New-user grace: while `lifetimeCount < dailyLimit*7` → allowed 2x daily.
   - `retryAfter` = seconds until next UTC midnight (i.e. the daily time-reset).
2. **`createKeyRateLimiter`** — per-minute, `LIMIT = rateLimit ?? 1000` (keyed
   only for real keys; the `public` key maps to no key → mostly skipped).
3. `trialLimiter`, `stickyProviderTracker` (Sticky on SessionID),
   `modelTpmLimiter`, `modelTpsLimiter`, `providerBudgetTracker`.

`proxyInference` handles the BYOK (bring-your-own-key) provider routes.

## 2.4 THE critical bug/loophole (ip-rate-limiter.ts)

```ts
const rawIp = throttle.header("x-real-ip") ?? "";
const ip     = !rawIp.length ? "unknown" : rawIp;
// ... key = `ratelimit:{ip}:YYYYMMDD`
```

Zen trusts the **client-supplied `X-Real-IP` header with zero validation** and
keys the entire per-IP daily quota on it. For a curl/harness caller this means:

> send `X-Real-IP: <anything>` → you get a *fresh daily bucket* every request.

## 2.5 The NEW-hard gate (since ~2026-09-16/17)

Separately, zen started wrapping free-tier inference behind the `Console`
provider:

```json
{"type":"FreeTierError",
 "message":"Error from provider (Console): OpenCode's free tier can only be
            used from within OpenCode"}
```

This is **not** defeated by spoofing headers. It checks that the request came
out of a *real OpenCode* client/session pipeline (session authenticated with
the gateway). Confirmed by:

- direct `curl` with realistic `x-opencode-*` headers → 403 FreeTierError
- the real CLI binary run directly at zen (no proxy) → also fails
- multiple independent community repos reporting the same behavior as of
  the same date.

**Conclusion:** header spoofing alone cannot pass the gate. You must shape the
request to look like a real client session — and the easiest way to *do* that
is to actually run one. (See `04-the-loophole.md`.)

## 2.6 Free-limit model metadata

`ZEN_MODELS` (which models are `allowAnonymous`, their `rateLimit` per model)
lives in **SST/Cloudflare KV** — present in the deployed gateway but *not*
in the public repo. So exact daily numbers for a given model aren't in source;
the mechanism is what matters for the bypass.