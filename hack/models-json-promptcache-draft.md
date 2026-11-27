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

`short: 1800`, not 2000 and not the measured ~99-minute lifetime. Pi schedules the refresh at
`min(short × 0.9, short − 10s)` timed from the request that opened the run, and stops a run whose next refresh falls
past that request + 30 minutes (60 minutes while streaming). 2,000s is the largest value whose refresh (1,800s)
merely *touches* the 30-minute horizon, and any elapsed time since the request puts it past — so 2,000 nominally
arms and practically does not. 1,800 refreshes at 1,620s (27 minutes) with headroom.

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

`lib/cache-warm.ts`'s `maxIdleMs` is set to 1,620,000 ms — the same 27 minutes — deliberately. The idle bar and the
catalogue interval are one number read in two places; if the catalogue moves, `CACHE_WARM_MAX_IDLE_MS` moves with
it, or the gate starts refusing sessions that a refresh would still have covered.

## What applying it costs, and what it buys

With `promptCache` declared and the policy in its shipped `observe` mode, the fleet emits one log line per decision
and sends **zero** warm requests: `stop` sends nothing. The cost of the change in that state is the decision event
itself and a `GET /rooter/events` read per decision (bounded by `evidenceTimeoutMs` 1500 ms, with a 60-second
backoff after a failure). If any pod is ever flipped to `cacheWarmMode: "arm"`, the cost becomes one replay of that
session's last request per 27 minutes on that pod.

## Hold until both of these clear

1. **Rooter's post-restart lifetime number** (~21:45-22:00 AWST, 2026-11-27): a ~40k-token prefix, entry cap 12, SSD
   budget 8 GiB, box serving ordinary fleet traffic, restores attempted at +30/+50/+75 min. Rooter's own account of
   the earlier 99-minute figure is that it is a calm-conditions upper bound on a **3,325-token prefix with a hot
   entry cap of 4**, i.e. uncontested and small, and that 1,298 hot evictions against 10,340 hot restores shows
   entries being dropped for room rather than expiring by age. A `short` chosen from that number would be a guess
   about a regime we have not measured.
2. **The observe log showing a session that clears the gate.** Measured over 347 generations / 144 minutes / 24
   session keys (`hack/warm-counter.mjs`, rooter boot `d7f15035b14e`): **0 warmable**, Pi and non-Pi alike. The
   dense Pi sessions recompute 259-993 tokens against the 10,000 floor because their prefixes stay resident —
   rooter measures `restoreTokS` at 1.81M tok/s against `coldPrefillTokS` 2,178 on strata, an 833x gap — and every
   caller that did recompute 10k-51k tokens was one call followed by 100+ minutes of silence, which is the shape a
   warm must not pay for.

Declaring the lifetime before (2) is free in GPU terms and buys a log nobody has asked for; declaring it before (1)
means the interval was picked without knowing what it is racing. Both are cheap to satisfy, so this waits.
