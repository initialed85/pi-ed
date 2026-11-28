# Draft: declaring a prompt-cache lifetime in the fleet catalogue

**Status, 2026-11-28 ~05:20Z: applied, and the section below "What opens the door" is now history.** Ed said "turn on
the idle compaction / warming thing" at 11:53 AWST; pi-bot put `"promptCache": {"short": 1800}` on `rooter/auto`
(home-ops `0cbefe7`) and Argo rolled all 16 agent pods at 03:58:34Z. What is left in this file is the arithmetic for
the *remaining* decisions — `1800` vs `1500`, and whether the other catalogue entries need the stanza — plus the
measurement that says why nothing has warmed yet.

It exists because pi-bot asked for the diff to live somewhere Ed can apply it without re-deriving the arithmetic
(`home-ops` → `clusters/dev/applications/slopyphus/configmap-credentials.yaml`, the `models.json:` item of the
`agent-credentials` ConfigMap, projected by all 16 agent deployments — a ConfigMap edit plus a pod roll, no image
rebuild).

## What opens the door

Pi's warmer opens a run by asking for the lifetime of the entry it would refresh (`getPromptCacheTtlMs`, read from the
model's `promptCache` tier), and no catalogue entry used to declare one:

```
rooter/auto:                             cost {input:0,output:0,cacheRead:0,cacheWrite:0}  promptCache undefined  -> stop("cache lifetime unavailable")
strata/qwen3.8-flash-next-iq3_xxs:       same
sushi/beamster/Qwen3.8-Flash-Next-Sushi: same
```

(read out of the live 1.6.1 `ModelRuntime` against `/root/.pi/agent/models.json`, 2026-11-27). Two consequences that
are easy to get backwards, and I got the second one backwards in the room on 2026-11-28 before reading 1.7.0's
`start()`/`refresh()` end to end, so they are written here in full:

- **`promptCache` is the switch, not `cost`.** Declare a lifetime and Pi starts scheduling refreshes and emitting
  `cache_warming_decision`; that is the event `extensions/cache-warm-policy.ts` answers. `start()` gates on three
  things only — mode not `off`, request replayable, `ttlMs` defined — and **never looks at `cost`**.
- **A missing `cost` block does not error, and does not disable warming.** The config loader defaults `cost` to all
  zeros, so when the timer fires, `evaluateCacheWarming` returns `economicsAvailable: false`, `warmCost: 0`,
  `missCost: 0`, `action: "stop"` — and `refresh()` then calls `decide()` with that stop anyway:

  ```
  action = await this.decide({ type: "cache_warming_decision", warmCost, missCost, continuationProbability, action });
  if (action === "stop") { ... }
  ```

  `economicsAvailable` only changes the *status string* and the default label. So on this fleet **every** decision
  arrives at the gate pre-labelled `stop`, and the gate is the only thing that can arm it: `actionFromPi: "stop"`
  with `override: true` on a warm row is the expected shape, not an anomaly. Do not invent dollar rates to satisfy
  Pi's floor either: it needs ~$24.67/M input tokens to arm (`0.15 × missCost − warmCost ≥ $0.05` at this fleet's
  median 16,211-token prompt), which is fiction on boxes we own, and it buys nothing because the override path is
  already open. Warming here is justified by measured recompute seconds, never by that arithmetic.

## The stanza

`short: 1800` (deployed) or `short: 1500` (rooter's tier argument, below) — **not 2000, and not the ~99-minute figure
that this file used to quote as a lifetime; that claim is retired below.** From Pi 1.7.0
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
at the 42,443-token prompt rooter measured for the session it warmed on 2026-11-27 — expressed in GPU seconds rather
than dollars, since the true USD price on our own boxes is zero and the catalogue declares zero.

**The 27-minute quiet window is why the armed fleet has sent nothing (measured 2026-11-28 05:24Z).** A decision needs
an open, *current* run that then goes quiet for `delayMs`. Over the 210 rooter rows since the 03:58:34Z roll, by
Pi session key: max inter-arrival 8.6 min (pi-ed), 10.4 (pi-bot), 21.6 (djangolang), and one 58.6 min gap on a
session with only 2 calls. No active session has had a 27-minute quiet window yet, so: zero
`cache_warming_decision`, zero verdict lines, zero single-token calls (`finish_reason: length` with
`completion_tokens ≤ 4` and `prompt_tokens > 5000`: **0** in the window). The absence of
`.pi/cache-warm/log.jsonl` fleet-wide is therefore *not* a missing writer — `009d3cb` contains `logDecision` and
`LOG_FILE` (the writer landed in `4191a81`; `91cc31b`, which it predates, is README-only) — it is a log with nothing
to record.

**So the fleet is not inert, it is waiting for the first long quiet stretch.** Tonight, when the pods stop getting
turns, each one's last run becomes eligible ~27 minutes later and makes its first armed decision with nobody looking
at it. That is the behaviour Ed asked for; the window for reviewing evidence *before* the first send was that
afternoon, and it closes per pod on its own.

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

**The fleet is armed.** `CACHE_WARM_MODE: "arm"` lives in the shared `slopyphus/config` ConfigMap (home-ops
`0cbefe7`, "turn on cache-warm for the fleet"), wired into all 16 agent pods, and the `promptCache` stanza landed on
`rooter/auto` at 11:53 AWST — so the rollout switch has already been thrown, and the per-pod `observe` rehearsal this
section used to recommend is now history rather than an option. What the stanza does **not** yet cover: the other
three `rooter` aliases and the `strata`/`sushi` entries have no `promptCache` block, so a session running on a
concrete model id still stops at "cache lifetime unavailable". In practice every pod runs `MODEL=rooter/auto`, so
this is a consistency gap, not a hole.

What one armed warm costs: one replay of that session's last request per scheduled interval (one re-prefill for an
idle run, at most two for a streaming one), plus one `GET /rooter/events` read per decision bounded by
`evidenceTimeoutMs` 1500 ms with a 60-second backoff after a failure. Where the gate vetoes — a session already
reading from cache, a median recompute under 10,000 tokens, fewer than 2 arrivals per hour, or a saving under 30
seconds — the cost is the decision and the evidence read only, and `stop` sends nothing.

Measure it from `.pi/cache-warm/log.jsonl`: one JSON line per decision, with `mode`, `phase` (`streaming` or `idle`),
`actionFromPi` against `action`, the median recompute the price came from, `evidenceSource` when rooter could not be
read, and the arrival rhythm. The pairing that proves a send is a `warm` line followed ~0 s later by a
`finish_reason: length` single-token call under that session's key on rooter (`/rooter/events?key=h:<first 10 of the
session id>` — the prefix is required; a bare id is expanded on `/rooter/forget`, not on `/rooter/events`).

## The lifetime number, now measured

Rooter ran a 33,761-token byte-identical prefix against sushi (entry cap 12, SSD budget 8 GiB) serving ordinary fleet
traffic — 226 queries, 95% request-level hit rate — measuring age **from the last write**:

| age | result | cached | prompt_ms | tier |
| --- | --- | --- | --- | --- |
| 12.4 min | hit | 33,730 | 585 | hot + ssd (promoted) |
| 30.4 min | hit | 33,730 | 576 | hot |
| 44.7 min | hit | 33,730 | 672 | hot |
| **56.7 min** | **hit** | 33,730 | 871 | **ssd** |
| **77.0 min** | **MISS** | 0 | **80,544** (419.2 tok/s) | none |
| 24.2 min after the rewrite | hit | 33,730 | 899 | ssd |

**Measured survival 57 minutes, first observed failure 77.** Both candidate intervals sit far inside it, so the
choice between them is not a miss-risk choice; it is a *tier* choice. Rooter demotes hot → SSD inside ~24 minutes
under load, so a 30-minute refresh reliably reads back off SSD while a 25-minute one often still finds hot. That is
the argument for **`short: 1500`**, and it is rooter's, not mine; `1800` is what is deployed. The earlier 99-minute
figure is retired as a lifetime claim: the hit at 101.2 min from the original cold write was an entry 24.2 minutes
old at its last write, because the 77-minute miss re-prefilled and re-cached it. Write-recency explains every point;
age-from-first-write explains none of them.

One provenance warning, because a number of mine travelled through the room mis-attributed: a "21:45-22:00 AWST
measurement window" I quoted was **not** a measurement — the string came from a queued task in my own session, and
the only 21:45 AWST event rooter can find is pi-bot's `kubectl rollout restart deployment/rooter`, which is the
team-room router, not the proxy and not sushi. Do not cite that window as evidence of anything until someone says
whose it is.

## Still open

1. **`1800` or `1500`.** Deployed value is `1800`, and `lib/cache-warm.ts`'s `maxIdleMs` default of 1,620,000 ms is
   `1800 × 0.9`, so the pair is consistent today. If Ed takes `1500`, the ConfigMap value and the default move in
   the *same* commit with one roll (pi-bot's constraint, and the right one): `short: 1500` → `maxIdleMs` 1,350,000 →
   `CACHE_WARM_MAX_IDLE_MS` with it, or the gate starts refusing sessions a refresh would still have covered.
2. **The unmeasured point rooter could not reach**: 45 minutes *from a rewrite* (their +120 min probe died with its
   extension process at 13:50Z on 2026-11-27). It is the one number that would separate "refresh keeps it in hot"
   from "refresh only keeps it alive on SSD", and it is worth taking once strata is back — with strata down
   (refusing connections since ~04:21Z) any trial today is single-box evidence on the 236 tok/s box, and the gate's
   price table (sushi 236, strata 2147) has been quoting sushi all day.
