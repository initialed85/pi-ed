# Draft: declaring a prompt-cache lifetime in the fleet catalogue

This is a **draft, not a change request**. Nothing here should be applied until the two gates at the bottom clear.
It exists because pi-bot asked for the diff to live somewhere Ed can apply it without re-deriving the arithmetic
(`home-ops` → `clusters/dev/applications/slopyphus/configmap-credentials.yaml`, the `models.json:` item of the
`agent-credentials` ConfigMap, projected by all 16 agent deployments — a ConfigMap edit plus a pod roll, no image
rebuild).

## What actually opens the door

Pi's warmer does not reach its pricing at all today. It opens a run by asking for the lifetime of the entry it would
refresh (`getPromptCacheTtlMs`, read from the model's `promptCache` tier), and no catalogue entry declares one:

```
rooter/auto:                             cost {input:0,output:0,cacheRead:0,cacheWrite:0}  promptCache undefined  -> stop("cache lifetime unavailable")
strata/qwen3.8-flash-next-iq3_xxs:       same
sushi/beamster/Qwen3.8-Flash-Next-Sushi: same
```

(read out of the live 1.6.1 `ModelRuntime` against `/root/.pi/agent/models.json`, 2026-11-27). Two consequences that
are easy to get backwards:

- **`promptCache` is the switch, not `cost`.** Declare a lifetime and Pi starts scheduling refreshes and emitting
  `cache_warming_decision`; that is the event `extensions/cache-warm-policy.ts` answers.
- **A missing `cost` block does not error.** The 1.6.1 config loader defaults it to all zeros, so
  `evaluateCacheWarming` returns `economicsAvailable: false`, `warmCost: 0`, `missCost: 0`, `action: "stop"` — a
  stop Pi reaches *while still asking extensions*. Do not invent dollar rates to satisfy it: Pi's bar needs
  ~$24.67/M input tokens to arm (`0.15 × missCost − warmCost ≥ $0.05` at this fleet's median 16,211-token prompt),
  which is fiction on boxes we own, and the extension overrides the action anyway. Warming here is justified by
  measured recompute seconds, never by that arithmetic.

## The stanza

`short: 1800` or `short: 1500` — **not 2000, and not the measured ~99-minute lifetime.** From Pi 1.7.0
(`@earendil-works/pi-ai`'s `cache-warming.js` and `core/cache-warmer.js`); the constant names in earlier versions
of this draft were 1.6.x names and they have since changed, so read this from the build the fleet runs.

| Fact | Value | What it constrains |
| --- | --- | --- |
| Refresh delay | `getCacheWarmingDelayMs(ttl) = min(ttl × 0.9, ttl − 10s)`; `ttl <= 10s` returns undefined | A declared lifetime is a re-arm interval, never a lifetime claim |
| Whose clock | `run.startedAt = Date.now()` in `cacheWarmer.start(request, …)`, called from `sdk.js` when the **user request** opens the run | Measured from the real request, not from the first warm. Scheduled refreshes cannot extend it |
| Idle ceiling | `CACHE_WARMING_MAX_IDLE_AGE_MS` = 30 min → stop "30-minute idle safety limit reached" | Idle phase |
| Streaming ceiling | `CACHE_WARMING_MAX_AGE_MS` = 60 min → stop "one-hour safety limit reached" | While the agent is still streaming |
| Dispatch margin | `refreshDeadlineAt = nextWarmAt + (ttl − delay) / 2`; past it, stop "cache refresh deadline missed" | 90s at `1800`, 75s at `1500`. Pi checks **dispatch**, not completion, so a queued request is not disqualified — but a refresh that lands that late is a full-price cache write, which is exactly what the source comment warns about |
| Savings floor | `CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS` = `$0.05` | Pi already refuses small prefixes: a 42k sushi prefix is $0.044 and Pi itself would not warm it |

**What that means for the value.** `1800` schedules the first refresh at +1,620s (27 min) with 180s of headroom;
`1500` schedules it at +1,350s (22.5 min) with 450s of headroom, which suits Ed's "idle the box ~20 minutes" plan
better. `2000` nominally arms and practically does not: its refresh (1,620s) merely *touches* the 30-minute ceiling,
and any elapsed time since the request puts it past. In either case an **idle run gets exactly one refresh** — the
second would fall past +1,800s and Pi stops the run before scheduling it — and a run that stays **streaming** gets
at most two. Warming one idle session costs **one prefix re-prefill**, roughly $0.044 on sushi and $0.005 on strata
at the 42,443-token prompt rooter measured for the session it warmed on 2026-11-27.

Inside each model object, at the existing 14-space indentation (shown against the `strata` entry, lines 21-32 of the
ConfigMap):

```json
            {
              "id": "qwen3.8-flash-next-iq3_xxs",
              "reasoning": true,
              "thinkingLevelMap": { ... unchanged ... },
              "contextWindow": 131072,
              "maxTokens": 32768,
              "promptCache": {
                "short": 1800
              },
              "input": [
                "text",
                "image"
              ]
            }
```

Apply it to every entry a session can actually run on — `strata`, `sushi`, and the `rooter` aliases (`auto`,
`qwen3.8-flash-next-iq3_xxs`, `beamster/Qwen3.8-Flash-Next-Sushi-2.6bpw`, `sushi`) — because Pi reads the tier off
*the model object of the request*, and an alias without the block behaves like today. `long` is not declared: no
request here uses `cacheRetention: "long"`, and declaring it would price refreshes against a tier nobody uses.

`lib/cache-warm.ts`'s `maxIdleMs` default is 1,620,000 ms — the same 27 minutes — deliberately: it is `1800 × 0.9`,
the interval a `1800` catalogue would schedule. The idle bar and the catalogue interval are one number read in two
places, so **if the catalogue picks 1500 the default becomes 1,350,000** (`1500 × 0.9`) and
`CACHE_WARM_MAX_IDLE_MS` moves with it, or the gate starts refusing sessions a refresh would still have covered.
That change belongs in the same commit as the catalogue decision, not after it.

## What applying it costs, and what it buys

**Read this first: the fleet is already armed.** `CACHE_WARM_MODE: "arm"` lives in the shared
`slopyphus/config` ConfigMap (home-ops `0cbefe7`, "turn on cache-warm for the fleet") and is wired into all 16
agent pods — verified live from a pod's environment and from `kubectl` on 2026-11-28. `observe` is the code
default, not the fleet's setting. Nothing warms today only because Pi never reaches its pricing without a declared
lifetime, so **this catalogue entry is the rollout switch**: applying it starts warm requests on 16 armed gates at
once, with no separate arming step. There is no "flip to arm later" step to plan for.

What the change costs once applied: for a session the gate arms, one replay of that session's last request per
scheduled interval (one re-prefill for an idle run, at most two for a streaming one), plus one `GET /rooter/events`
read per decision bounded by `evidenceTimeoutMs` 1500 ms with a 60-second backoff after a failure. Where the gate
vetoes — a session already reading from cache, a median recompute under 10,000 tokens, fewer than 2 arrivals per
hour, or a saving under 30 seconds — the cost is the decision and the evidence read only, and `stop` sends nothing.

Measure it from `.pi/cache-warm/log.jsonl`: one JSON line per decision, with `mode`, `phase` (`streaming` or
`idle`), `actionFromPi` against `action`, the median recompute the price came from, `evidenceSource` when rooter
could not be read, and the arrival rhythm.

## Hold until both of these clear

1. **Rooter's post-restart lifetime number** (~21:45-22:00 AWST, 2026-11-27): a ~40k-token prefix, entry cap 12, SSD
   budget 8 GiB, box serving ordinary fleet traffic, restores attempted at +30/+50/+75 min. Rooter's own account of
   the earlier 99-minute figure is that it is a calm-conditions upper bound on a **3,325-token prefix with a hot
   entry cap of 4**, i.e. uncontested and small, and that 1,298 hot evictions against 10,340 hot restores shows
   entries being dropped for room rather than expiring by age. A `short` chosen from that number would be a guess
   about a regime we have not measured.
2. **A log showing a session that clears the gate — and getting one now takes a per-pod edit, not a project file.**
   Measured over 347 generations / 144 minutes / 24 session keys (`hack/warm-counter.mjs`, rooter boot
   `d7f15035b14e`): **0 warmable**, Pi and non-Pi alike. The dense Pi sessions recompute 259-993 tokens against the
   10,000 floor because their prefixes stay resident — rooter measures `restoreTokS` at 1.81M tok/s against
   `coldPrefillTokS` 2,178 on strata, an 833x gap — and every caller that did recompute 10k-51k tokens was one call
   followed by 100+ minutes of silence, which is the shape a warm must not pay for. There is no observe-mode log to
   wait for, because the fleet is `arm` and `gateVerdict` only appears in observe mode. And the precedence is
   env > project file > default, so a `.pi/cache-warm.json` **cannot** hold one pod back from a fleet-wide env —
   the only per-pod hold is that pod's own deployment setting `CACHE_WARM_MODE` to a literal `observe` instead of
   referencing the ConfigMap. So the safe shape for a rollout is: pick one pod, give its `agent-<name>.yaml` a
   literal `observe`, apply the catalogue, read that pod's first hour of `log.jsonl` next to a second pod left on
   `arm`, and only then move the rest. If nobody wants to do that bookkeeping, the honest alternative is to leave
   the catalogue alone: the gate's evidence so far says nothing on this fleet needs a warm.

Declaring the lifetime before (2) is free in GPU terms and buys a log nobody has asked for; declaring it before (1)
means the interval was picked without knowing what it is racing. Both are cheap to satisfy, so this waits.
