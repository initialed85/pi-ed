# pi-ed

The [Pi](https://github.com/earendil-works/pi) extensions I wrote to stop my agents doing the things
that were wasting my time, plus the tests that keep them honest.

They live in `~/.pi/agent/extensions/` on my machines. This repository is the source of truth: the
installed files are symlinks into a clone of it, so there is exactly one copy of each to edit. Pi's
discovery accepts symlinked extension files (`loader.js`: `entry.isFile() || entry.isSymbolicLink()`),
and `/reload` follows them.

```
extensions/   the extensions
test/         vitest suite, no Pi runtime and no network needed
hack/         check-package-shape.mjs (the CI gate on the package manifest), ci-status.sh (ask Woodpecker
              what it did with a commit), pty-panel.py (press keys in a real `pi` under a pty and read the
              screen), plan-influence-check.sh (ask a real model what a plan line changes about its next
              action), plan-wording-probe.sh (compare candidate block sentences against each other),
              idle-drain-read.mjs (what the idle gate actually did across the fleet, priced),
              post-compaction-return.mjs (who pays a compaction's re-read, and the cached share by idle-gap
              band), cache-prefix-audit.mjs (one session's cache behaviour, section by section)
.woodpecker/  CI: workflow lint + typecheck + tests
```

## Background jobs

### `background.ts` — slow work without blocking the conversation

The `background` tool starts a shell command and returns immediately. The child keeps running while the agent continues
the session; when it exits, the extension writes a durable result under `.pi/background/<session-id>/` and injects a
follow-up user message containing its exit state and capped output. Use `action: "list"` to inspect jobs or
`action: "cancel"` with the returned id to request `SIGTERM`; `/jobs` is the human-readable list.

This is intentionally not a prompt section: job state and output never enter `systemPromptOptions.sections`, so starting,
finishing, or listing a job cannot churn the provider's cached system-prompt prefix. The command has Pi's shell
permissions, so it is an agent tool rather than a sandbox. Results are capped to 12,000 characters and persisted before
the wake-up is sent.

## Install

Clone it where Pi discovers packages — a directory under `~/.pi/agent/extensions/` with a
`package.json` carrying a `pi.extensions` field is one of the documented layouts:

```bash
git clone https://github.com/initialed85/pi-ed ~/.pi/agent/extensions/pi-ed
cd ~/.pi/agent/extensions/pi-ed && npm install
```

Or let Pi install it: `pi install git:github.com/initialed85/pi-ed`.

`/reload` inside a running session picks the files up.

Pi provides `@earendil-works/pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui` and `typebox` to
extensions itself, so they are `peerDependencies` here and only `devDependencies` for the test
run. They are deliberately **not** in `dependencies`: a bundled copy gives extensions duplicate
class registries.

## The extensions

Fifteen of them live in `extensions/` and are what `pi install git:github.com/initialed85/pi-ed` loads. One more,
`memory.ts`, is in **`parked/`**: compiled, tested and swept against the live store, but outside the directory Pi
discovers, so no session is given its tools. Ed turned Postgres memory off on 2026-11-10 to make a graph memory door
the fleet's only memory; `parked/README.md` keeps the measurements taken while that call was being made, and how to
bring it back.

`turn-stats.ts`, `tags.ts`, `searxng.ts`, `session-commands.ts`, `session-markers.ts` and `queue-reload.ts` are
documented in their own file headers rather than below: each one is small, and the header is where the measurement that
justifies it sits.

### `autopilot.ts` — the model writes the next prompt from your shoes

When the agent is about to settle, a side call asks it to write the prompt *you* would send next, appends
that as a user message, and keeps going. Everything happens in one agent run, append-only, so the main
prompt prefix stays warm and cached.

The side call is deliberately cache-hostile (`cacheRetention: "none"`, fresh sessionId, reasoning off,
few-hundred-token brief): it never writes a provider cache entry, so the session keeps exactly one
growing cached prefix. That was measured, not hoped — side calls report `cacheRead=0 cacheWrite=0`.

Anti-drift: the brief always shows *the request you actually made*, and the human-voice has to measure
every candidate against it. It refuses prompts already sent, stops on shape similarity (it is repeating
itself), and stops when context usage passes 85%.

| | |
| --- | --- |
| Commands | `/autopilot [goal]` arm · `/autopilot stop` · `/autopilot status` · `/autopilot max <n>` · `/autopilot goal <text>` |
| Flags | `--autopilot`, `--autopilot-max <n>`, `--autopilot-goal <text>` |
| Env | `AUTOPILOT_DEBUG=<logfile>` to trace the loop |
| Knobs | `DEFAULT_MAX_HOPS` (128), `MAX_HOPS_CEILING` (1024, the one ceiling for `/autopilot max <n>` and `--autopilot-max`), `SIDE_CALL_MAX_TOKENS` (600), `CONTEXT_STOP_PERCENT` (85), `SHAPE_STOP` (0.7) |

### `loop-guard.ts` — catches a failing agent doing the same failing thing again

Watches tool calls and assistant text. When a *failing* action repeats — same command shape, same
failure — it blocks the repetition and tells the model to change approach. Repetition that is working is
left alone: a `git status` loop that is making progress is not a bug, and a guard that blocks it is.

Command shapes are normalised before comparison (`7.txt` and `8.txt` fold to the same token, `sleep 3`
and `sleep 30` fold to `sleep`, `| head -20` and `| tail -5` are stripped) so that an agent nudging a
timeout by ten seconds is still recognisably the same mistake. Text is compared by word-set similarity
above a threshold, with a minimum length so short confirmations never match each other.

| | |
| --- | --- |
| Knobs | `HISTORY_LIMIT` (32), `MAX_CYCLE_LENGTH` (4), `TEXT_SIMILARITY_THRESHOLD` (0.84), `MIN_TEXT_WORDS` (16), `FAILURE_MARKER` (the regex that decides what counts as a failure) |

### `compaction-summary-guard.ts` — auto-compaction stops failing on the token cap

The failure this fixes: `Auto-compaction failed: Summarization failed: generation hit the token cap and
the summary is incomplete`, repeating every turn, with context pinned at the ceiling.

The cause is local reasoning models. Pi caps the summarization response at `min(0.8 * reserveTokens,
model.maxTokens)` (~13k tokens), summarizes at the *session* thinking level — where `high` maps to
`xhigh`, an unbounded reasoning budget — and reasoning eats 1k–9k of those tokens. Each compaction merges
the previous summary forward, so summaries grew until every attempt hit the cap.

It keeps Pi's own `compact()` (same structured format, previous-summary merge, split-turn handling, cut
point) and only changes the summarization request: bounded response cap, reasoning off, a hard length
budget in the prompt, validation of the actual output, and up to two compressed retries when a summary
still comes back oversized. Worth ~1–2 minutes per compaction on a local model, purely because the budget
goes into the summary instead of into thinking.

What it does when it still cannot get under budget: **uses the summary anyway.** A summary 30% over is
accepted on the spot rather than costing two more model calls; if all three attempts come back big, the
smallest one is kept (trimmed to budget at a line boundary if it is more than 2× over). Falling back to
Pi's default compaction is now the last resort, reached only when there is no usable summary at all —
because the default path is the thing that was failing, so it was never a safer option than a real
summary that happened to be a bit long.

| | |
| --- | --- |
| Knobs | `SUMMARY_OUTPUT_TOKENS` (8192), `SUMMARY_TARGET_TOKENS` (4000, so 16000 characters), `SOFT_OVERLIMIT_RATIO` (1.3, accept without retrying), `TRIM_OVERLIMIT_RATIO` (2, trim rather than pass through), `RETRY_POLICY` (`maxRetries: 2`, `baseDelayMs: 2000`, `maxAgentDelayMs: 15000`) |

### `idle-compaction.ts` — the housekeeping runs while nobody is waiting for it

The complaint this answers: a compaction sits in the middle of a run and takes about five minutes, so the session
feels slow even though the model was never the problem.

Measured out of 102 compactions across this repository's own session logs, and then out of Pi's source:

| measured | |
| --- | --- |
| where Pi compacts | `tokensBefore` median 114688, p10 111031, p90 115577 — a 3.4k spread against a 131072 window, because Pi compacts at `contextWindow − reserveTokens`, which is 87.5% |
| how long it takes | median 71 s, p90 226 s, p99 337 s, max 399 s — but r² ≤ 0.09 against the summarised span, the summary size and the token counts, so the wait is not the transcript's fault |
| what it costs | 3.12M of 353.7M tokens in a 56-compaction session: 0.9% |
| when it happens | every one I could attribute landed inside a run, while 92% of the wall time of those sessions sat in gaps longer than five minutes |
| what a clean attempt costs locally | 52 s (strata) and 77 s (sushi) at 31k input tokens; an output sweep of 600 / 1500 / 3000 / 4500 tokens took 27 / 48 / 70 / 69 s |

So the tokens were never the issue, and the transcript length does not explain the latency. What explains a *median of
five minutes* on a shared GPU is a retry ladder — which is what this repository's own guard does when a summary comes
back oversized: three attempts on a contended backend is a 100–400 s spread, and that is exactly the spread above. The
idle path asks for **one** attempt (`lib/compaction.ts` puts `pi-ed:compaction-single-attempt` in the instructions and
the guard honours it with one summarisation call and no ladder), and aborts it if it runs long.

It arms a quiet window when a run settles — two minutes by default, twenty seconds above 80% of the window, because
above that the next prompt pays the cost anyway — and cancels it for anything that means a turn is happening or about
to happen. At session start it arms the same quiet window rather than a shorter one: a session resumed near the
ceiling is worth compacting before the next exchange, but a person who has just sat down is about to type, and Pi
refuses a prompt while a compaction is in flight. What the summary must
keep is named in the instructions, and this session's plan is quoted verbatim out of `.pi/plan/<session-id>.json`
rather than reconstructed from a summary of a summary.

The deadline is not politeness. Pi's `prompt()` throws `"Cannot submit a prompt while compaction is in progress.
Wait for compaction to finish and retry."`, and no extension event runs before that check, so a 226 s compaction is a
window where the next thing typed fails. At its ceiling this extension calls `ctx.abort()`, which reaches Pi's
`abortCompaction()` and cancels the in-flight summarisation; an aborted compaction writes nothing, so the session
keeps everything it had. It is 240 s and not 120 s because the fleet's own history says a compaction at Pi's trigger
point takes median 71 s and p90 226 s: a deadline under the p90 is a machine that cancels its own work.

It then queues for a **fleet gate**, because every model here is served by two backends and nine sessions asking at
once is a different problem from one session asking. The gate is a lease file at
`/workspace/.pi/idle-compaction/lease.json` — the parent of `/workspace/<repo>` for every checkout on the shared
volume, which is exactly the scope the contention happens at — plus a spacing stamp recording when the last attempt
let go. A session may start only when no live lease exists and the last one let go at least `spreadMs` ago; otherwise
it re-checks on a bounded poll (30 s) and gives up after `gateMaxWaitMs`. The gap is measured from the hand-back and
not from the start on purpose: a 107 s attempt would eat a 90 s start-to-start gap entirely and the fleet would go
back-to-back. The cost of that is stated rather than hidden — an attempt that dies at its 240 s deadline paces the
fleet for another 90 s after it fails, so the worst case is about 330 s in which nobody summarises, which is the right
failure posture when the thing that just failed was a summarisation. The stamp now says `who`, `when` and `why`
(`compacted`, `aborted at deadline`, `error`, `could not start`, `Pi threshold completion`, `Pi overflow completion`,
`Pi manual completion`, `Pi threshold aborted`, `Pi hold expired`, `session shutdown`) and keeps the last 12 of them
in `prior`, because on 2026-11-26 three agents reconstructed "who claimed when" from four pods' logs and the newest
stamp alone could not show the pair.

**Pi's own compaction path is gated as a hold, not a refusal.** Of the 21 summarisations this volume completed on
2026-11-26, **12 arrived through `trigger:"pi:threshold"`** at 114803–119360 tokens — the biggest jobs the fleet runs
— and none of them left a lease or a stamp, so a gated idle attempt beside them queued for nobody and starved. Pi
fires that path at 87.5% of the window, and again on overflow, where Pi will summarise *any* session that reached
131072 input tokens no matter how short the history is. Cancelling it is available from `session_before_compact` and
is deliberately never used: a session that has already spent its window pays for a refused summarisation at the next
prompt, and every measured harm here came from starved attempts, never from a summarisation that was refused. So
`session_before_compact` takes the lease on Pi's behalf, renews it while the summarisation is in flight (Pi's path has
no `deadlineMs`, and the fleet has never measured one — all 12 came back with no duration because the builds that ran
them stamped no start), and `session_compact` or `session_compact_failed` hands it back naming which path ran. Idle
attempts on other pods queue behind it. On the session being compacted the idle attempt stands aside outright — turn
ends, Pi schedules a summarisation, `agent_settled` arms a quiet timer that fires 120 s later — because calling
`compact()` behind Pi would log a `compact` line for a summarisation that never appears; `session_compact`,
`session_compact_failed` and the hold's renewal bound all clear the stand-aside, so it cannot outlive the thing it is
waiting for. What still cannot be prevented is an attempt already in flight when Pi's path
fires; that collision is logged as `Pi compacting while the gate is held elsewhere` rather than smoothed over.

The gate is cooperative, and that is its other limit: a pod defers only to peers that
claim the lease, so a pod running a build without the gate is invisible. Field proof: at 21:08:59Z home-ops, still on
`ce1e789`, started a 71940-token summarisation 74 s into pi-bot's held lease and died at its own 120 s ceiling. A
partial rollout protects nobody, which is the argument for moving every pod at once. A lease carries its holder's
session id, repo, start time and expiry, so a pod killed mid-compaction leaves something the next session takes over
instead of a fleet permanently blocked by a corpse.

**Then it asks whether either box can take the job.** The gate serialises this fleet; it says nothing about the two
machines behind rooter, and rooter's 2026-11-27 measurements put the aborts there. Cold summarisation-shaped prompts
prefill at 2,512 / 2,481 / 2,486 tok/s on strata (46,857 / 83,335 / 114,772 tokens, flat with size) and
470 / 466 / 463 tok/s on sushi, decoding at 47–63 tok/s against sushi's 8.5 — so an 82.7k summarisation costs ~214 s
on one box and ~45 s on the other, and `auto` chooses. Worse, the queue in front of a box is invisible from this
side: three concurrent cold prompts held per-call prefill at ~2,475 tok/s while ttft went 18.9 → 52.7 → 161.5 s and
rooter's own `wait_ms` stayed 0.000, because the queue forms after the proxy hands off. That is the only explanation
for three 45k–77k summarisations that ran their full 240 s on provably idle sessions: 45k costs ~132 s, so the rest
was waiting.

So before claiming the lease, an attempt reads `GET /rooter/backends` (803 bytes, 1–3 ms, using the key this session
already holds for its provider) and defers when **every** healthy box reports `busy == concurrency` — the pessimistic
rule, because a request is only certain to queue at that point. It retries every `boxRetryMs` on the same cancellable
timer the gate wait uses, gives up after `boxMaxDefers` looks with a reason, runs no read at all when a person asked
now or the provider is not rooter, and fails open on any error: a proxy that will not answer is not a box that is
full. It is a look and not a reservation — a peer can take the slot in the hundred milliseconds between — and the
real queue depths (`live.queued`, `sushi:num_requests_waiting`) sit behind rooter's backend key, which no pi pod
holds. Each attempt records the snapshot it saw as `boxes: ["strata=1/4", "sushi=4/4"]`, which is the field that
was missing when the fleet's aborts had to be argued about instead of counted.

It also counts stale tool output at `agent_before_settle` — tool results are 3.40M of the 5.00M characters of
transcript in that session, 68% — and dropping them is the one context reduction that needs no model call and keeps
the reasoning verbatim. **By default it only counts them.** Set `prune: "on"` to replace stale, text-only, non-recent
results with a one-line stub through a `context_edit` *replacement* (never an omission, so the tool call keeps a result
and the pairing survives). That is the mode to watch before trusting it.

While a compaction is in flight it answers `cache_warming_decision` with `stop`, because Pi pays a cache write to keep
a warm prefix alive that the compaction is about to throw away. Every model in this fleet declares no cache lifetime,
so that is insurance rather than a saving today.

Tested at the contract boundary rather than inside Pi's loop: 42 cases over fake timers with the shipped defaults
(arm, cancel, re-check on fire, cooldown, deadline, the plan pin, the prune protections), plus a contract test that
fails if the scheduler's marker and the guard's marker stop agreeing, plus 14 cases for the gate — the nine-sessions
-in-one-second layout, one-in-flight, a stale lease taken over, a person asking now not queued, a returning person
cancelling the wait, a shutdown releasing the lease and recording itself, the ceiling's own spacing stamp, the queue
cap, Pi's threshold path held and handed back with the path named, that hold renewed past its own expiry, that hold
released when the summarisation never reports back, a Pi-path compaction that dies releasing the fleet early, a
recorded collision when Pi forces a summarisation while a peer holds, and the ungated mode — plus three for the
eligibility bars themselves: a session over its declared window compacting inside its own cooldown (logged
`overWindow`), the percent bar being unable to refuse what the token bars cleared, and an idle attempt standing aside
while Pi compacts that same session — plus nine for the box pre-flight: a saturated fleet deferring without taking
the lease, headroom starting the attempt and stamping `boxes` on it, a deferral retrying and taking the box that
frees, boxes that stay full ending in one skip with a reason, the read failing open and announcing itself once, the
key resolved through the model registry (which is the shape a real pi model has), `slotsFree` beating the arithmetic
both ways, a non-rooter provider and a person asking now issuing no call at all, and the switch-off.

**The field result that changed the defaults.** A deploy stamp restarted every pod in the fleet inside the same
second, so every session's quiet window opened at the same instant, and nine of them issued a summarisation request
between 17:09:42Z and 17:09:50Z against `rooter` and `retainer`, which serve every model here. Every one was aborted
at the then-120 s deadline, each having spent the whole call and freed nothing. The session that fired forty-five
seconds later died the same way:

| session | fired at | tokens summarised | freed |
| --- | --- | --- | --- |
| rooter · camry | 17:09:42Z | 88190 · 84917 | 0 |
| memebrary · macgrubernetes | 17:09:44Z | 74039 · 90599 | 0 |
| pi-team-room · macker | 17:09:45Z | 186420 · 71229 | 0 |
| home-ops · pi-bot | 17:09:48Z | 86748 · 58877 | 0 |
| maclet | 17:09:50Z | 63058 | 0 |
| pi-ed (settled trigger, not startup) | 17:10:37Z | 86318 | 0 |

The two attempts in those same logs that fired outside the burst show what a solo call costs this feature: slopyphus
summarised 57181 tokens in **59.2 s** and pi-bot summarised 103142 in **107.2 s**. Same backend, same sizes, 59-107 s
instead of never finishing. Concurrency was the whole difference, so the fix is the gate and the spacing — a longer
timeout alone would only have moved the failure from "aborted" to "everyone waits". One session per pod also stops
the doubling: with a resumed session and a new one in the same checkout, only the holder's window can issue the
request.

It has now run for real. A scratch checkout under `pi --mode rpc` on pi 1.6.1 with this extension and the guard loaded,
against strata: the run settled at **96791 context tokens (73.8% of a 131072 window)**, the window armed **exactly
120 s after `agent_settled`**, the compaction wrote **one summary of 3801 characters in 55.2 s**, and the context went
from 96791 tokens to **6706** — **90085 tokens freed**, one `compaction` entry in the session file, and the 120 s
deadline never approached. The prune pass reported 4 stale results, about 50875 tokens, and replaced nothing, because
`report` is the default. `/idle-compact status` reported all of it over RPC as it happened, and the decision log holds
one line per decision: the arm refusal at session start, the prune report, the compaction, the result.

Two things that measurement settled. First, a single-attempt summarisation of a ~97k-token context on this fleet's
local backend costs about a minute **when it is the only one running**, which is what the gate is for; the 120 s
deadline that nine sessions hit simultaneously was not a slow model, it was contention. Second, no
`session_before_compact` guard is needed here and there is none: in 1.6.1 `compact()` sets `_compactionAbortController`,
`prompt()` refuses while a compaction is in flight, and `_checkCompaction()` only runs at turn boundaries — so an
automatic compaction cannot race an idle one. What a Pi-started compaction does get is the same cooldown, because
`session_compact` records it: a human `/compact` during an armed window is not followed by a second compaction two
minutes later.

**Starting at a turn boundary is not finishing at one.** `_checkCompaction()` runs at turn boundaries, but the
summarisation it starts runs 60–150 s. So "run ends → Pi starts a compaction → `agent_settled` arms → the quiet timer
fires 120 s later" is a race for the same summarisation after all, and the idle attempt now stands aside whenever
`session_before_compact` has fired on its own session without reporting back. Without that, the log carries a
`compact` line for a summarisation that never wrote an entry — the false success pi-bot was told to stop writing on
2026-11-26, where `home-ops · pi-bot` had the Pi threshold path fire at 21:05:21Z inside a turn the provider had
already refused, and its own compaction landing on 31480 tokens only to be refilled to 135735 minutes later.

**The window constant is not the window the model ran.** Pi carries a `contextWindow` per alias, and the fleet has two
measurements showing it is not the number the provider served. `pi-team-room · macker` answered a genuine 186420-token
prompt (185898 of it `cacheRead`, 457 output, 126 reasoning) under a 131072 constant, which is the 142.23% the status
line reported — real tokens, wrong denominator, no double-count. And `home-ops · pi-bot` was refused by the provider at
135735 tokens (103.55%) after refilling from a 31480-token landing 17 minutes earlier, the refusal reading: "This
endpoint's maximum context length is 131072 tokens. However, you requested about 135838 tokens." Two rules
follow. The percent bar became advisory — it may arm a session early, which is only waste, but it may not refuse one
the token bars cleared, because refusing on a wrong denominator skips a legitimate candidate silently. And a session
at or over its declared window bypasses the cooldown, recording `overWindow` in the log: a cooldown is a brake on
self-churn, and a refill that outruns it is a session left out of room on purpose.

**What `idle-compact prune` is for, and what it counts.** Compaction needs a model call; dropping stale tool output
needs an edit entry. Across 305 sessions the transcript is 5.00M characters and **3.40M of it (68%) is tool output**,
100% of it from `bash`, `read` and `edit`. It is not uniformly reclaimable: 103,297 of 123,377 results are under the
2000-character floor, 84%, and replacing one costs an entry — that is why the floor exists. The pool that matters is
the 20,081 results above it, 2.45M characters, and 94% of that sits in 100 of the 305 sessions. On the 41 that have
already been compacted once, keeping the ten newest results whole names 124,454 reclaimable characters (108,854
estimated tokens) and 12,997 of them belong to the 21 oldest: **89% of the value is in the first twenty**, which is
what makes a per-boundary cap safe. `report` (the default) counts and touches nothing; `on` replaces the oldest ones
with a ~150-token stub naming the tool, the size and how to get the output back; `off` skips the pass.

**It counts what Pi would send, not what the session file holds.** The scan runs over `sessionManager.buildContextEntries()`,
Pi's compaction-aware view: the newest compaction entry, everything from its `firstKeptEntryId` to that boundary, and
everything after it. A tool result behind that boundary is already out of the request, so counting it invents a saving.
The field proved it: a pod logged `{"kind":"prune-report","candidates":405,"tokens":409532}` on a session whose live
context was 83,819 tokens — that was the file, and a reader sizing a reclaim against it would have expected five times
what the window can give back. The log line now carries `contextEntries` and `sessionEntries` beside the count, and the
readout says *in the context Pi would send now*. The 108,854-token figure above is a whole-file measurement of a
305-session corpus: the right way to ask where stale output lives, the wrong way to ask what one session reclaims.

**What a completion actually costs, and why the minimum moved to 30000.** A summarisation is not free and it is not
the expensive part. After one, every kept token re-reads at 0.1x and the prefix is re-created at 1.25x, so a completed
idle compaction costs about **0.84 × max(tokensBefore, tokensAfter) in uncached prompt tokens** — measured on this
fleet (90666 prompt tokens with 55810 cached = 34856 written, against a gain of 20513). `hack/idle-drain-read.mjs`
now prices every completion in the window: 12 idle-path completions freed 9474-49305 tokens against 37328-63746
re-sent, a fleet return of **0.62**, and none of them paid for themselves inside one call. That is not a reason to
stop compacting — Pi compacts at 87.5% whether this extension acts or not, and doing it idle and early is the cheap
place (a 75000-token context re-sends about 63000 tokens, a 126444-token one about 106000) — but it is a reason the
bar is a *yield* bar and not a percent bar: at `minFreeTokens` 20000 the fleet ran three completions that freed 15000,
9474 and 19099 tokens, each of which has to re-send its whole prompt two and a half times before the saving shows up.
For scale, a system-prompt rewrite (what a plan mutation costs) is 1794 uncached tokens measured: anything that frees
less than that is worth less than leaving the plan section alone.

**Three numbers the fleet could not previously check.** `compact` lines now carry `deadlineMs`, so an abort proves
which ceiling it hit — one pod wrote `deadlineMs: 600000` into its config mid-session, watched an attempt abort at the
default, and could only prove afterwards, by reading the source, that the file had never been re-read. `/idle-compact
status` now names the config file, says when it was read, and says in words when the file has been written since and
*those values are not applied to this session*. And Pi's own compactions, whose completion event carries no duration,
are timed from `session_before_compact` to `session_compact` and logged as `tailMs` with `tailMsSource`: the fleet's two
largest compactions, 116325 and 119360 tokens, had contributed no duration data at all. `tailMs` is deliberately not
`ms`. `compaction-summary-guard.ts` loads before this extension and does the summarising inside its own handler, so
what is left when this handler's stamp is taken is the tail — measured 40-92 ms on 2026-11-27, against the idle path's
132-239 s. Pi's completion event also carries no landing size, so these lines now carry `tokensAfter` labelled
`getContextUsage at session_compact`, which is this session's own estimate rather than a number from Pi.

**Every pod can now say what it is running.** Every record carries `build`, the sha of the git checkout the extension
was loaded from, and a session opens its log with a `start` line giving that build, the numbers actually in force
(`cfg`), where they came from (`cfgFrom`: the config file, or `defaults`), and any `IDLE_COMPACTION_*` overrides.
Until this existed, a pod's build was inferred from which fields its lines happened to carry — `deadlineMs` meant
f3df978 or later, `tokensAfter` meant d5edf91 or later — and that inference is how one pod spent an hour proving that
the commit its own `git` reported was not the code it was executing. `hack/idle-drain-read.mjs` reads the marker
first and falls back to the field-shape table only for records written before it.

**Two sections the price question added.** `== what each completion cost to re-send ==` prices every idle-path
completion at 0.84 x max(tokensBefore, tokensAfter) uncached prompt tokens and prints the fleet return (freed ÷
re-sent); for 2026-11-27T00:00-05:10Z that is 385371 freed against 621130 re-sent, a return of 0.62, with no
completion paying for itself inside a call. `== how long a completion takes to pay back, per pod ==` then turns that
into the only question that decides whether to do one at all: a completion gives back 0.1 x freed on each *later*
call, so it needs price ÷ (0.1 x freed) calls - 15 to 20 here - and that many calls is a wall-clock figure taken from
the pod's own arm lines, which are turn endings. slopyphus pays back in 7.8 h of its own use, pi-bot in 15.7 h,
pi-team-room in 36.8 h, longhorn-storage-gateway in 37.7 h. Three of the four pods with completions do not see the
saving inside a working day, which is the case for moving the arm bar nearer the threshold a session is actually
heading for rather than leaving it where the token bars happen to land.

**Who pays a compaction's re-read - and why the tempting fix for it is not built.** The re-send price invites an
obvious trick: after a compaction, run one deliberately trivial completion against the new prefix so the expensive
uncached read happens in the idle path instead of on the human's next turn. `hack/post-compaction-return.mjs` measures
the two things that decide it, by joining the gate log's completions to each pod's session timeline. Pi already records
both halves: every assistant call carries `usage`, and every prefix rewrite is a system-role record carrying `sections`
and `toolsAdded` / `toolsRemoved` - and since Pi rebuilds the live tool list per call from those records
(`getCurrentTools(messages)`), a tool appearing or disappearing is a rewrite of the cached prefix like any section
change. Measured, 2026-11-27, 1678 calls across 14 pods:

| idle gap since the previous call | calls | median cached share | 25th percentile | calls still above 50% |
|---|---|---|---|---|
| 1-30 s | 974 | 99% | 99% | 974 |
| 30-60 s | 431 | 99% | 98% | 430 |
| 60-120 s | 158 | 99% | 97% | 153 |
| 120-300 s | 62 | 97% | 93% | 47 |
| 300-900 s | 41 | 96% | 0% | 22 |
| 900-3600 s | 9 | 0% | 0% | 1 |
| over 3600 s | 3 | 0% | 0% | 1 |

So the cache survives a five-minute gap untouched and is usually gone past fifteen minutes - **a gap is not what makes a
call cold**. Of the 57 calls in the window that re-read more than half their prefix, 50 had no rewrite recorded between
them and the previous call, and **none of them happened at a gap under 30 s**: the cold population is a compaction and
reload artifact, not a per-turn leak. The size of the bill is visible per session too: `hack/cache-prefix-audit.mjs`
reports that my own session's file carries 79 compactions whose first following call re-sent a median **29671 uncached
tokens each, 2,310,889 tokens in all**, at a median cached share of 12.6%.

**Who is charged, split by path (27 completions).** Every compaction pays one full uncached re-send, and the path
decides who pays it. **16 paid at the completion itself**: every `pi:threshold` completion, because Pi compacts in
`prepareNextTurn` and re-issues the request that triggered it against the compacted prefix - charged 27803-40612
uncached at 0-19% share, and the following call is warm again at 93-100%. **5 deferred**: every idle-path
`agent_settled` completion, because nothing is mid-turn, so the charge lands on whoever next calls - 31416-39716
uncached, 21 s to 3466 s later. **6 charged nothing inside the window**: five `session_start:startup` completions and one
settled completion on a pod nobody returned to, 216010 tokens freed with no re-send recorded.

That last group is not free and should not be read as a win. The summarisation call was paid either way, and the
benefit of a compaction only ever arrives on *later* calls - so a completion with no later call inside the window has a
cost on the record and a benefit outside it, in both directions. It is the group this measurement cannot judge, it is
the group where a warming completion would be a certain waste, and it is why the startup path is the hardest of the
three to price: a resumed session that stays quiet has not yet told us whether it was worth compacting.

Given that, warming is a latency transfer and never a saving: the new prefix is evaluated once by whichever call
reaches it first, and on the Pi path it is already evaluated by the turn that asked for the compaction. So the only
completions a warm could apply to are the deferred idle-path ones - **6 in this window, of which 1 was in the band
where a warm would have arrived first** (the 299 s return), 1 was beaten by a call 21 s later, 3 returned long after
the cache had decayed, and 1 never came back. It is not built, and this is the measurement that says why; shipping it
would need a predictor for the 200-400 s return band, which the idle path by definition cannot see - it fires because
the session is quiet.

**How to check a build without rolling one.** Pods load extensions from Pi's extension clone
(`/root/.pi/agent/git/github.com/initialed85/pi-ed`), not from a workspace checkout, so "which build is this pod
running" is answered by `git -C /root/.pi/agent/git/github.com/initialed85/pi-ed rev-parse HEAD` — and, on `9561806`
or later, by the `build` field in that pod's own log. To exercise a *specific* checkout headlessly you have to turn
discovery off: `pi --mode rpc -ne -e <path>`. Loading one extension with `-e` while Pi also discovers the installed
clone makes Pi refuse to start with `Flag "--idle-compaction-off" conflicts with …` plus a hint to start without
extensions; that reads like a broken extension and is not one — two copies of the same file cannot both register the
same flag (pi-bot hit it at 04:05Z while verifying the marker, and it is the reason every headless verification in
this fleet is `-ne -e`). A scratch `--mode rpc` session with empty stdin spends no model tokens and still writes the
`start` line, which is how a build marker gets proven before anything is rolled.

| | |
| --- | --- |
| Commands | `/idle-compact status` · `on` · `off` · `dry-run` · `run [--force]` · `prune <off\|report\|on>` |
| Flags | `--idle-compaction-off` |
| Config | `.pi/idle-compaction.json`, with `IDLE_COMPACTION_*` overrides |
| Knobs | `quietMs` (120000) · `urgentPercent` (80) / `urgentQuietMs` (20000) · `softPercent` (**65**, raised from 25 on 2026-11-27 with Ed's approval so the idle path nominally arms at 85197 tokens against Pi's 87.5% threshold at 114688 — and **inert as a gate**: `clearsMargin` arms any session at or above `keptFloorTokens + minFreeTokens` = **54000 tokens** whatever its percent says and refuses any session below it whatever its percent says, so this number changes the wording of refusals and nothing else. Percent is also computed from whatever `contextWindow` Pi carries for the alias, not the window the model ran — a genuine 186420-token prompt once read as 142.23% of 131072 — so it may arm a session early but may not refuse one the token bars cleared. `hack/cliff-counter.mjs` is the test that judges the bar either way.) · `minFreeTokens` (**30000** — what a completion has to free before it is worth its own re-send: 12 idle-path completions measured 9474-49305 tokens freed against 37328-63746 tokens re-sent, a fleet return of 0.62, so a 20000 minimum was asking for the 3 sessions that freed 15000, 9474 and 19099 to pay ~2.5x their gain) / `keptFloorTokens` (24000, Pi's 20000 keep-recent plus the measured 2565-token median summary) · `deadlineMs` (240000, the **floor**: above the fleet p90 of 226 s) scaled up per attempt by `rateTokensPerSecond` (300, the poor end of the measured 255-816 tok/s band) to at most `maxDeadlineMs` (900000) — a flat ceiling is what killed two 2026-11-27 attempts at 480 s on 90599 and 82704 token contexts for 3151 tokens between them, and scaling is bounded by a ceiling rather than by a guess · `cooldownMs` (600000) / `retryCooldownMs` (1800000, how long a session waits before re-attempting one that did not finish; not bypassed by `overWindow`, because the attempt that just burned its ceiling is the one not to re-buy, and Pi's own 87.5% auto-compaction serves an out-of-room session meanwhile, per-session in-memory state: a reload, `/new` or a pod restart erases it, so after a fleet roll the only ordering left is `spreadMs` and the lease — it is a self-churn brake, never a fleet limiter, and **a session at or over its declared window bypasses it**, with `overWindow` recorded in the log so nobody reads it as a missed check) · `spreadMs` (90000, the gap between fleet compactions) / `gateMaxWaitMs` (5400000, long enough to drain a fleet restarted in one breath: `spreadMs + duration` per session, and durations measured 52.7-151.9 s) · `prune` (`report`) · `pruneKeepRecentResults` (12) · `pruneMinChars` (2000) · `boxCheckMs` (1500, the budget for `GET /rooter/backends` before an attempt is issued; `0` ships every attempt blind) / `boxRetryMs` (15000) / `boxMaxDefers` (20) |
| Gate | `/workspace/.pi/idle-compaction/{lease.json,spacing.json}` — derived from the parent of the checkout, overridable with `IDLE_COMPACTION_GATE_DIR`, disabled with `IDLE_COMPACTION_GATE=off` |
| Evidence | `.pi/idle-compaction/log.jsonl`, one JSON line per compaction decision, plus an arm refusal written once per reason (a session that never compacts still leaves evidence, and the same line is not repeated on every settle), a `gate` line for every wait, takeover and forced run, one `start` line per session naming the build and the config it resolved, `boxes` on every attempt that asked the
boxes first, and `build` on every line |

### `cache-warm-policy.ts` — should a prompt cache be kept alive on purpose? It says no, and shows the work

Pi ships a prompt-cache warmer: it re-sends the last real request with a one-token output cap at 90% of the
declared cache lifetime, refuses to replay a request it cannot replay identically, prices the decision, and asks
extensions before acting. Until 2026-11-28 it had never warmed anything here, for a reason that was in the catalogue
rather than in the arithmetic: it opens a warming run by reading the lifetime of the entry it would refresh
(`getPromptCacheTtlMs`, from the model's `promptCache` tier), no entry in `/root/.pi/agent/models.json` declared one,
so the warmer stopped at `start()` with `{action: "stop", reason: "cache lifetime unavailable"}` and there was never a
decision to policy on. A missing `cost` block fails differently and is *not* a door: the config loader defaults it to
zeros, so `evaluateCacheWarming` answers `economicsAvailable: false` with `warmCost` and `missCost` both 0 and action
`stop` - a stop Pi reaches *while still asking extensions*, which is the hole this policy stands in.

**The catalogue door has since been opened, and then deliberately left ajar.** `rooter/auto` declares
`promptCache: {"short": 1800}` (Ed said turn it on - home-ops `0cbefe7`, rolled across all 16 agent pods at 03:58Z on
2026-11-28), and three hours later the fleet went back to `mode: observe` (home-ops `9eac941`) on Ed's ruling in Chat:
"i dont think i need anything that keeps the pi agent sessions fresher than others, just rely on idle compaction and
warming based on session busyness in general". The mechanism agrees with him in a way none of us had said out loud:
the refresh is scheduled `delayMs` after the request that **opened** the run, so the only sessions warmer-eligible at
all are ones that have gone quiet for 27 minutes. Warming cannot keep the session you are typing in fresher than any
other - the cache your real request just wrote already does that - so what it can buy here is a cheaper return for
sessions that have already stopped, and nothing else. This extension is what decides whether that is worth a GPU
second, and it decides in GPU units.

It has sent nothing, and there are now two independent reasons: the fleet is in observe, and a decision needs an open
run that then goes quiet for `delayMs` (1,620 s at `short: 1800`) - across 210 rooter rows since the roll the longest
inter-arrival on any Pi session was 21.6 minutes. In observe the ask still arrives on each pod's first long quiet
window and still writes its row; only the spend is withheld, which is exactly what re-arming is a decision about.

The policy is in `pi-coding-agent/dist/core/cache-warmer.js` on 1.5.0 and, from 1.6.0, split between that file
(which owns scheduling) and `pi-ai/dist/cache-warming.js` (which owns the numbers); the constants are the same in
both, and so is the stop string quoted above, which is why nothing about this depends on which Pi a pod runs.

The gate lives in `lib/cache-warm.ts` as pure functions over three things the session already has: rooter's per-call
rows for this session (`GET /rooter/events?key=h:<first 10 chars of the Pi session id>`, whose
`prompt_tokens_computed` is the work a refresh would have avoided, and whose `prefill_ms` prices it), the session's
own arrival rhythm off the branch, and the **catalyst** of the newest entry that opened a request. It arms only when
the catalyst is human-shaped, nothing has been idle past `maxIdleMs`, median recompute clears
`minRecomputeTokens`, `humanArrivalsPerHour` clears `minArrivalsPerHour` (1/h), and the last call was not already a
cache read. Three corrections are carried in the code, from review and from measurement:

- a *high* cache hit rate is not a precondition, it is a **veto**. A session reading 99% of its prompt from cache is
  a session a refresh cannot help, and it is the fleet's normal state: this session's 148 calls in 139 minutes
  recomputed a median of **285 tokens**.
- gating on the gap between turns against the measured prefix lifetime discriminates nothing (pi-bot's objection,
  and it was right): with a ~99-minute lifetime almost every session clears it. The idle bar is kept, but against
  the interval a refresh would run on, as a veto — not as the reason to warm.
- **arrival rhythm cannot tell a person from a peer, and the reason is structural.** Ed's goal, in Chat on
  2026-11-28: idle compaction makes headroom when he sits down, warming makes sure that headroom is backed by a
  cached prefix "as long as sessions are hot enough" - and a session woken for a one-off team-room question is worth
  compacting but not worth warming, "because that session will go back to being dormant for some time". Measured on
  this session's own transcript over its last 24 hours of activity: **45 machine turns against 1 human arrival**
  (22 `pi-team-room-pulse`, 17 `pi-team-room-wake`, 5 `auto-resume-prompt`, 3 `schedule-run`). They persist as
  `custom_message` entries rather than user-role messages, so `sessionRhythm` already ignores them - which makes the
  confound the mirror image of the one it was described as: a session hammered by peers reads as *quiet* here, while
  the prefix a refresh would protect still ends at one of those turns, because a warm replays the last request
  whatever opened it. So the gate names the catalyst (`chat`, `terminal`, `peer`, `unknown`) from the entry type and,
  where a turn arrives as text, from its markers (`[pi-chat:` is a person; `[Team inbox` and a first-line `[owns:` are
  a peer; `[background job complete]` and `(auto-resume)` are the harness). Only `chat` and `terminal` may turn a stop
  into a warm. It is a precondition on the **override** and runs after every evidence rule, so a vetoed decision still
  records what the evidence said, and `catalystVetoed: true` on a row is exactly the count of how often this rule
  alone would have stopped a spend. Finding this out also renamed a field and moved a default: the rhythm row is
  `humanArrivalsPerHour`, because `arrivalsPerHour` reads like all traffic to anyone who has not been through this,
  and the floor went 2 → **1**, because at 2/h the bar whose job was to permit Ed's pattern (sit down, send one
  message, compaction makes headroom, warming follows) was the bar refusing it. It is a code default and not a
  ConfigMap value, so one roll carries the rule and the threshold together. What the floor is once it sits at 1 is
  worth saying plainly: a **presence test** ("a human spoke inside the window"), not a rate - one call in a
  60-minute window reads as exactly 1.0/h - so the discriminating is left to `minRecomputeTokens`, `minSavedSeconds`
  and the cache-read veto, and on the first read after this change those three were what stopped both Pi sessions
  (99% cache read, 983-token median recompute). pi-bot is not rolling for it today:
  the fleet is in observe, so `f1896ab` buys nothing until the arm decision, and the next roll is Sunday 08:30 AWST
  bundled with whatever a day of observe evidence says (`arm` + this build if sessions genuinely clear the bars,
  `off` + no new build if none do).

What the fleet measured against that gate (`hack/warm-counter.mjs`, rooter boot `d7f15035b14e`, 347 generations,
144 minutes, 24 session keys): **0 of the 5 Pi sessions warmable**, and 0 warmable among the 19 `p:`-keyed callers
that ever recomputed 10,000-51,000 tokens — every one of those was a single call followed by 100+ minutes of
silence, which is precisely the shape a warm must not pay for. The fleet's whole cold-prefill spend in that window
was 30 calls, 934,953 tokens and 1,568 seconds of box time; arming everything at a 2,000-second cadence would have
added 15 refreshes costing ~1 second if the prefixes were resident and ~1,425 seconds if they were not. The
prefixes were resident: rooter measures `restoreTokS` at 1.81M tok/s on strata against `coldPrefillTokS` 2,178,
a 830x gap that is the whole argument for why Pi sessions do not need help staying hot.

The same run corrected the rates this code used. Sushi was assumed at 460-470 tok/s cold from pi-ed's own probes and
measures **236.7 tok/s** at the router, which prices a 42,000-token cold refresh at 178 seconds rather than 91.
Those seconds are **box work, not wall time**, and the gap is the queue: rooter measured a warm restore of a
33,761-token prefix at 0.585 s of work that took **97 s** on the wire, arriving to a box at `running=2 waiting=1`
and finishing at `running=7`. A gate that trades in capacity should price the work; a promise about response time
may not be made from this number, and deadline arithmetic (idle-compaction) sizes against rooter's queue bound
instead.
Pi's own bar, for reference: an idle refresh arms only when `0.15 × missCost − warmCost ≥ $0.05`, and with
self-hosted rates `warmCost` is ~0, so it needs a cold re-prefill priced at **$0.3333** - **$7.85 per MTok of
recompute**. Against the measured rates that means valuing strata at **$62/GPU-hour** (0.455 ms/tok, so 19 s for the
fleet's 42,443-token prefix) or sushi at **$6.2/GPU-hour** (4.535 ms/tok, so 192 s). Neither is a number we can
honestly write, so the `cost` block stays out of the catalogue and the gate decides in seconds: the electricity in a
192-second re-prefill on a ~0.3 kW box is about one cent, which puts the honest expected saving near **$0.0014**
against a $0.05 floor. On boxes we own, warming is a latency transfer and never a saving.
| | |
| --- | --- |
| Commands | `/cache-warm` (mode, last decision, its catalyst, and the rhythm it was judged from) |
| Config | `.pi/cache-warm.json`, with `CACHE_WARM_MODE` / `CACHE_WARM_MIN_RECOMPUTE_TOKENS` / `CACHE_WARM_MIN_ARRIVALS_PER_HOUR` / `CACHE_WARM_VETO_CACHE_HIT_RATE` / `CACHE_WARM_MAX_IDLE_MS` / `CACHE_WARM_EVIDENCE_CALLS` overrides |
| Knobs | `mode` (**observe** in code — the gate runs, its verdict is logged as `gateVerdict`, and the action is `stop`, which sends no request at all: measuring what the gate would have armed is free, so arming is a decision made after reading the log, not before. **This is not what the fleet runs.** Ed turned it on the night of 2026-11-27 in home-ops `0cbefe7` ("turn on cache-warm for the fleet"), which put `CACHE_WARM_MODE: "arm"` in the shared `slopyphus/config` ConfigMap across all 16 agent pods; **the fleet is back in observe as of home-ops `9eac941` (13:41 AWST / 05:41Z 2026-11-28)**, on Ed's Chat ruling that he does not want pi sessions kept fresher than others - and the mechanism supports that, since a refresh is scheduled from the request that *opened* the run, so only a session already quiet for 27 minutes is ever eligible. Observe keeps the evidence without the spend, and re-arming is one line in that ConfigMap. Precedence is env > project file > default, so a single agent can be held back with a `.pi/cache-warm.json` and no redeploy. What makes the fleet quiet in practice is not the mode, it is that a decision needs 27 minutes of silence in one session, and **`promptCache` in the catalogue is the switch that opens the door**: `rooter/auto` declares `short: 1800`, so the ask lands on each pod's first long quiet window whether or not it is answered with a spend) · `minRecomputeTokens` (10000) · `minArrivalsPerHour` (**1** — human turns only, and the knob counts *user-role* arrivals: a peer wake or a scheduled run does not raise it, because those persist as `custom_message`. It was 2 until 2026-11-28, when naming what the bar actually selects showed 2/h refused the exact case it was written for (Ed sits down, sends **one** message, compaction makes headroom, warming should follow). Held at the override path's name so `CACHE_WARM_MIN_ARRIVALS_PER_HOUR` and `.pi/cache-warm.json` keep working unchanged; the row field it gates is now `humanArrivalsPerHour`) · `minSavedSeconds` (**30** — the gate's own version of Pi's `$0.05` minimum expected savings, in the currency we trade in: a refresh replays the session's whole prompt, and it earns nothing to avoid 14 seconds on strata. This bar was written by a mistake: at 12:07Z rooter restarted with a short event buffer, one call read as 2.55 arrivals/h over the compressed window, and two sessions armed to save 7s and 17s) · `vetoCacheHitRate` (0.99) · `maxIdleMs` (**1620000** = 27 minutes, the interval a `promptCache.short: 1800` catalogue would actually schedule, so this bar and that value move together) · `evidenceCalls` (8) · `evidenceWindowMs` (3600000) · `evidenceTimeoutMs` (1500, and a 60-second backoff after a rooter read fails) · `logTimeoutMs` (**2000** — how long a decision may wait for its own log line) / `logRetryMs` (120000, how long a stalled log stays shut) |
| Ceilings | Pi's own, which decide what a catalogue may ever say: a refresh is scheduled at `min(short × 0.9, short − 10s)` measured from the request that opened the run, and Pi stops a run whose next refresh falls past 30 minutes after that (60 while it streams). 2,000s is therefore the largest `short` whose refresh (1,800s) merely *touches* the horizon, and any elapsed time pushes it past, so a declared value is a **re-arm interval** — `1800` schedules 27 minutes out with headroom — and never a claim about how long a prefix lives. What the prefix actually does is measured: rooter's probe held a 33,761-token prefix on sushi to **56.7 min** (read off SSD) and missed at **77.0 min**, counting age from the **last write**, so both 1800 and 1500 sit well inside real survival and the choice between them is which tier the refresh reads back from (hot demotes to SSD within ~24 min under load, which is rooter's argument for 1500) |
| Ownership | Also answers `cache_warming_decision` from the summarisation side (`idle-compaction.ts`), and Pi merges that event by taking the last handler that answered in load order. This extension watches `session_before_compact` / `session_compact` / `session_compact_failed` and holds the veto itself, so a warm never depends on which of the two Pi loaded first |
| Evidence | `.pi/cache-warm/log.jsonl`, one JSON line per decision: Pi's own `warmCost` / `missCost` / `continuationProbability`, what this extension answered, `gateVerdict` when observing, `catalyst` and `catalystBasis` (never the turn's text), `catalystVetoed` when that rule alone stopped a spend, the median recompute it priced from, whether that price was observed or table-derived, the rhythm, and `evidenceSource` when rooter could not be read |
| Log failure | A log is a diagnostic and must never be a cost. Every decision races its own write against `logTimeoutMs` — `appendFile` has no signal to cancel, so the ceiling is a `Promise.race`, not a timeout handed to the call — and a write that blows the ceiling shuts the log for `logRetryMs` rather than buying another wedged write on the next decision (one blocked worker is an incident; a decision per turn each wedging one ends with the thread pool exhausted and every decision paying the full ceiling). Both kinds of failure, fast and wedged, are reported by `/cache-warm` as `log problem: N write(s) failed (…) and M decision(s) were not written…`, because an unwritable log is the state in which a tool that says nothing looks healthy. The decision is unchanged either way and still answers Pi |

**What this extension's tests are not allowed to do** (they broke this once, and it cost three red pipelines):
they may not reach the network, and they may not read their expectations from the ambient environment. Pipelines
167-170 failed as a 30-second timeout in one test, with no assertion failure: it passed `cwd:
"/proc/definitely-not-writable"` intending an unwritable log, took no position on `fetch`, and so asked the real
rooter — in a Woodpecker step pod the OS resolver's own ~30s timeout is what elapses, and a fetch abort does not
interrupt it. A CI container also runs as root, so `/proc` was not unwritable there and the expected error never
arrived. The suite now stubs `fetch` in `beforeEach`, deletes every `CACHE_WARM_*` from the environment for the
same reason (the fleet sets `CACHE_WARM_MODE=arm`, so a test named "in observe mode" was asserting against a mode
it never chose), and proves the two log cases with fixtures that fail the same way for any uid: a directory sitting
where the log file belongs (always `EISDIR`) and a FIFO with no reader (a write that genuinely never returns).
Proof, not intention: `unshare -rn npm run test` — 714 passed with no network at all.

### `plan.ts` — `/goal`, `/direction` and `/todo`: the aim, the route to it, and the steps

An intent is the first thing a long session loses. It is stated at the top, it survives the first twenty turns by
being obvious, and then it is buried under everything the session did about it - and the summary that replaces it is
written by a model preserving *events*, which is the wrong shape for a purpose. `/goal` puts the aim somewhere that
does not depend on the transcript still containing the sentence where it was first said. `/todo` is the same problem
one level down: a session that has done nine things and plans four more has nowhere to say so, and saying it in prose
every turn is a paragraph nobody re-reads.

The record lives in `lib/plan.ts` (pure: no clock of its own, no UI, no tools, nothing Pi-specific beyond
`CONFIG_DIR_NAME`) as one file per session id, and all three doors - aim, route, steps - read and write that one
record, which is why this is `plan.ts` rather than `goal.ts`: one reader of the record, one writer, one paint.
`/direction` is the middle one, and the reason it is not just a second goal: an aim is what the session is *for* and
it does not change mid-session, whereas the line of attack does - "ship the panel before the retrieval rewrite" - and
when a plan turns out to be the wrong shape you want that on the record rather than implied by a deleted todo. It is
kept one deep for the same reason.

| `/goal` | `/goal <text>` sets it, overwriting; the replaced line is kept one deep, so a change of aim is visible. `/goal` alone reports the goal and where it is stored. `/goal clear` clears it — matched against the whole argument, so a goal may contain the word |
| `/direction` | the same three behaviours on the route field: `/direction <text>` sets it (replaced line kept one deep), bare `/direction` reports it *and which aim it belongs to*, `/direction clear` clears it. Same cap, same whole-argument rule, and a session that has a route but no aim is drawn as `↳` rather than `🎯` so the two cannot be confused by reading |
| `/todo` | `/todo` reads the list (counts first, then items with their ids). `/todo <text>` adds, `/todo start\|done <id>` moves, `/todo drop <id> <why>` retires, `/todo note <id> <text>` and `/todo edit <id> <text>` correct, `/todo show\|hide` controls the panel. A duplicate open text is refused by the substrate, and the refusal is the message |
| State | `.pi/plan/<session-id>.json`, written temp-then-rename in the same directory (a cross-filesystem `rename` is `EXDEV`, and `/workspace` is NFS). `.pi/plan/.gitignore` (`*`, `!.gitignore`) is created on demand, because this repository is public, `/workspace` is mounted into every agent pod at once, and `git add -A` has committed a session artifact before (`cdfbaa5`) |
| Inheritance | keyed by session id, which is the rule for free: `pi -c` continues the same id, so it continues the goal and says `goal restored · set <date>`; a fresh `pi` or `/clear` gets a new id and starts blank. No name matching, and therefore no route by which a stale aim walks into an unrelated session |
| To the model | as a named prompt **section**, rendered as `<plan>`. Pi diffs the sections against what the model already has and patches only the one that changed, so a goal that does not change costs one section and then nothing - not one message per turn. The block is capped at 2600 chars (~650 tokens) and says `+N more in .pi/plan/<id>.json` when it trims |
| Does the model use the route? | measured, because the labels alone lost. With `DIRECTION acquire paperclips` and `[ ] t1 write the changelog` both present and nothing else in the block, the model named the step: "Write the changelog (plan task t1)". A checklist reads as assigned work and a bare noun phrase reads as a caption, so the block now states the arbitration in one line - and the line was chosen by A/B rather than by taste, using `hack/plan-wording-probe.sh` against the same conflicting plan and the same aligned plan: the wording shipped surfaces a real disagreement ("Question t1; DIRECTION conflicts with TODO t1") and reports no conflict when there is none, where an earlier candidate ("aim and route are the human's") took the step silently twice and *invented* a conflict on the aligned plan. Both probes run with a fresh session id per call: the provider here caches on session id, and before that was noticed three "different" runs returned one identical answer about a step that appeared in none of the plans |
| Whose plan is this | a real one, and not a hypothetical: a fresh session in an empty sandbox ran `find .pi -type f`, cat-ed a **finished** session's plan, and began working through that session's paperclip todos. The keying by session id was never the protection, because the files are plain JSON in a predictable directory and a curious model will list it. So the block names the session it belongs to, and `session_shutdown` stamps the record with `ended_at` (stamped, never deleted - a quit is not a licence to erase the human's record), which a reader sees before it sees the list. `pi -c` clears the stamp, because a session that came back is not an ended one |
| Not coupled to compaction | deliberately. `compaction-summary-guard` has three separate `return { compaction: result }` paths, and both its `overBudget` check and `trimToBudget` act on `result.summary.length` - so a block appended to the summary either inflates the guard's own accounting or gets trimmed by it. The section route needs no hook in there, and a plan reappears by itself after a compaction or a context replay |
| Authority | the aim and the route are human-set only: no tool writes either, and the model reading them is not the model deciding them. The list is the opposite case, so `todos` is a model-facing tool — the work on a list is done by the agent, and a list nobody can move reports `[ ]` about things that are finished. Its one action that retires something a human wrote, `supersede`, cannot happen without a reason, which is what lets the human overrule it later. A test pins the split: the tool's schema contains no `goal` or `direction`, and both `action: "set_goal"` and `action: "set_direction"` come back refused without writing a file |
| Names | `/autopilot goal <text>` is not this — that is the goal of an autopilot run and lives in memory for the length of it; `/goal` is the aim of the session and lives in the file |
| The panel | its style and its mechanism are lifted from the pulse panel in [`initialed85/pi-team-room`](https://github.com/initialed85/pi-team-room): a `▌`-railed box on the theme's message background, `◆`/`↳`/`●`/`○`/`✓`/`✗` marks instead of prose, one compact line under the editor (`▌ Plan: ◆ operationalize pi-ed's memory · 1 in progress`) and `shift+down` to raise the detail as a non-capturing overlay that rises from that line, so it cannot cover the editor or the autocomplete below it. `… N more` gets a row of its own even when everything else fit: a panel that silently stops at eight steps leaves a reader believing eight was the whole list. Off by default, and per-activation: the record, not the panel, is the state. Two differences from the team room — the key (`shift+up` is theirs, and both panels are on one screen), and the compact line appears only when there is something on it, because "no goal" is not a fact worth a row. The *opened* panel, though, always opens: an empty session draws `◆ goal /goal <text> sets it` and `no steps yet`, because a key that appears to do nothing reads as a broken binding, and a session three minutes old is exactly when being told what to type is worth a row. And if the overlay itself cannot mount, that is said out loud rather than swallowed - same reason. Opening and closing it otherwise says nothing: the panel is the feedback |
| A damaged plan is reported, never repaired | unreadable, non-JSON, or an unknown schema version means `readPlan` returns a problem, `/goal` refuses to save over it, and the bytes stay on disk for a human. The only writer able to "fix" a corrupt plan is one that no longer has its contents |
| Tests | `test/plan.test.ts` — the substrate: session ids validated before they reach `path.join`, atomic writes with no temp left behind, a supersede that cannot happen without a reason, the block cap and its token estimate. `test/plan-extension.test.ts` — the wiring, 60 of them: replaced goals keep their predecessor, print mode stays silent and still loads the goal, the section is byte-identical turn to turn so the diff sends it once, a corrupt file is refused rather than overwritten by either door, a refused verb writes no file at all, the tool cannot reach the aim, the pointer line the model arbitrates on is asserted, a quit stamps and a resume unstamps, and the panel's layout is asserted rather than hoped for — the overlay's last row is the compact line's row, its padding trim keeps a short render from becoming 24 blank scrollback rows, and a shrink redraw is still possible with the panel mounted |
| Measured live | in a real terminal, with `hack/pty-panel.py` driving `pi` under a pty (no model call): `/goal`, `/direction` and `/todo` in sequence, then `shift+down`, drew `▌ ◆ goal operationalize pi-ed memory` / `▌ ↳ direction panel before retrieval` / `▌ ○ t1 lift the compositor patch`. That script exists because the same assertion through a fake UI had already passed on a build whose panel would not open at all - a widget factory Pi never calls, and a status that only ever got what it asked for.
| Measured live (model) | with all tools disabled (`pi -ne -e extensions/plan.ts -nt`), a model quoted `GOAL      the section route is the one that ships` back verbatim across a process restart — so the section is on the wire, not a lucky retrieval from history. With tools on, the same file drove a real `todos` session: two steps added with their whys, one marked done, and the model replying `🎯 1 open · 0 in progress · 1 done · 0 retired` from the list it had just written, with `t1`/`t2`, `state`, `why` and `done_at` correct on disk |

The runtime workarounds come along with the lift, because they are properties of Pi rather than of the team room: in
scrollback mode a short render is padded to the full terminal height before overlays composite, which otherwise
leaves blank rows behind, and an above-editor widget cannot uncover lines that have already scrolled off the top — so
the expanded detail goes into an overlay instead, and the compositor's padding is trimmed while it is mounted. RPC
and print mode have no overlay surface, so there the widget carries plain lines and the same content. Nothing about
the record depends on any of it: the panel is a view, and `/todo` reads the list even in a terminal that cannot draw
one.

### `schedule.ts` — `/at`, `/every`, `/cron`: a prompt that arrives at a wall time

A Pi session that stays open is a scheduler nobody is using. This lets a long-lived session be told, in
advance, what to do and when: `/at 2am perth pull the checkout`, `/every day at 2am perth …`,
`/cron "*/30 4-17 * * mon-fri" …`. When the time comes the prompt is injected as a user-level message
that starts a turn, with the job's note attached so the agent knows which runbook to read.

**Schedules are wall times, not instants.** Cron is a promise about a *local* clock, and a repository that
lives in Perth (UTC+8, no DST anywhere in its year) should not have its 02:00 job drift an hour every
summer the way an instant-based schedule does. Occurrences are computed by civil-date arithmetic in the
job's own zone, and each one is keyed by its wall time — `w2026-11-06T0200`. That is what makes the two
DST cases behave: on a fall-back morning, local 02:00 happens twice and is still **one** run (both instants
carry the same key); on a spring-forward night, 02:30 does not exist and the occurrence is **skipped**
rather than slid an hour sideways into the user's morning.

**Three layers decide who runs an occurrence**, because several Pis can sit in the same checkout, on one
machine or on several nodes:

1. **Ownership.** A job carries an `owner` session-name pattern (`home-ops`, `home-*`). A session that does
   not match never fires it and never claims anything for it. `SCHEDULE_REQUIRE_OWNER=1` (or
   `defaults.requireOwner`) turns "any Pi in this directory may run it" into a refusal, so a shared repo
   cannot end up with a prompt that every agent will run.
2. **A file lease per occurrence.** `.pi/schedule/locks/<job>/<occurrence>.lock` is created with `O_CREAT|O_EXCL`:
   one winner by construction, everyone else sees `EEXIST` and stands down. This is mutual exclusion for
   every Pi that shares the filesystem, not a cooperative protocol.
3. **A cross-node election, when pi-team-room is installed.** The room's `sessions[]` are read, peers that
   are connected, recent and in the same repository are kept, and the lowest live session id runs the
   occurrence. Two nodes with no shared disk cannot race on a lock file, so the election is the layer that
   covers them; losing one never leaves a lease behind that would block the winner.

**Two sources, one of them reviewable.** `.pi/schedule.json` is committed: a schedule that belongs in a
diff, re-read when the file changes, so a nightly `git pull` can add tomorrow's job without restarting
anything. Slash commands and the tool **refuse to edit it** — a committed file is changed in a diff, not
from a running session. Jobs created in-session go to `.pi/schedule/jobs.jsonl` as operations
(add/pause/resume/remove), replayed from scratch on each read.

**Catch-up is about downtime, not polling.** An occurrence is fired if it is no older than the job's
window, and the window never falls below two ticks — so a live session notices a run that came due while
its tick was mid-flight, while a cluster that was down for a week does not run a week-old maintenance job
at boot. `--catchup <duration>`, `--catchup none`, `--catchup always`.

**What a fired job looks like.** `pi.sendMessage` with `customType: "schedule-run"`, `display: false` and
`triggerTurn: true` — `triggerTurn` is the whole reason a 02:00 run happens in an idle session at all.
`--deliver followUp|steer|nextTurn` chooses what happens when the session is *not* idle; `nextTurn`
deliberately does not trigger, for a job that should attach to the next real turn. `--skip-if-busy` drops
an occurrence instead of queueing it. The injected message carries the job id and the occurrence key, so
the agent can say which schedule it is acting on, and every fire and every skip also lands in
`.pi/schedule/events.jsonl` plus a transcript entry the model never sees. `/schedule history` answers
"did the 2am job run, and which session ran it?" without archaeology.

`pi -p` and `--mode json` neither fire nor claim anything: a throwaway instance that claimed tonight's
lease would cost the session that was supposed to run it.

```bash
/at in 20m refresh the checkout          # one shot, away from now
/at 2am perth pull home-ops              # the next 02:00 Perth, once
/at 2026-11-06T02:00 --tz Australia/Perth run the drill
every day at 2am perth pull home-ops     # a committed wall-clock promise
/every 6h check the fleet                # an interval, anchored at creation
/cron "*/30 4-17 * * mon-fri" --tz Australia/Brisbane tail the audit log
/schedule list · show <id> · history [id] · next · who
/schedule pause|resume|remove <id> · run <id> · off | on
```

Flags are per-session: `--schedules-off`, `--schedule-name <identity>` (when the session name is not what
owns the repository), `--schedule-tz <IANA>`, `--schedule-tick <ms>`. Environment mirrors:
`SCHEDULE_OFF`, `SCHEDULE_NAME`, `SCHEDULE_TZ`, `SCHEDULE_TICK_MS`, `SCHEDULE_REQUIRE_OWNER`,
`SCHEDULE_STATE_DIR`, `NODE_NAME`. A bare `2am` is one run and `2am perth` is one run *in Perth* — the
zone is what the prompt was timed against, and `Etc` offsets keep their POSIX sign inversion, because
`Etc/GMT-8` is the one spelling Intl accepts for Perth's own UTC+8.

```bash
jq -r 'select(.customType=="schedule")
       | [.timestamp, .data.op, .data.id, .data.key, .data.wall // "", .data.reason // ""] | @tsv' \
  ~/.pi/agent/sessions/*/*.jsonl
# the same audit, outside the session tree:
jq -r '[(.at / 1000 | todate), .op, .id, .key, .session, .node] | @tsv' .pi/schedule/events.jsonl
```

| | |
| --- | --- |
| Commands | `/at <when> <prompt>` · `/every <recurrence> <prompt>` · `/cron <expr> <prompt>` · `/schedule <verb>` |
| Tool | `schedule_jobs` — `list · show · add · pause · resume · remove · run · next`; `add` writes local jobs only, and accepts the per-job flags below as parameters (`deliverAs`, `catchup`, `repo`, `announce`, `owner`, `note`, `tz`, `skipIfBusy`) so the tool is not a subset of the CLI |
| Flags | `--schedules-off` · `--schedule-name <name>` · `--schedule-tz <IANA>` · `--schedule-tick <ms>` |
| Env | `SCHEDULE_OFF` · `SCHEDULE_NAME` · `SCHEDULE_TZ` · `SCHEDULE_TICK_MS` · `SCHEDULE_REQUIRE_OWNER` · `SCHEDULE_STATE_DIR` · `PI_TEAM_ROOM_STATE` · `NODE_NAME` |
| Per job | `--tz` · `--owner <pattern>` · `--note <text>` · `--id <name>` · `--deliver followUp\|steer\|nextTurn` · `--catchup <dur>\|none\|always` · `--skip-if-busy` · `--quiet` · `--repo <path>` |
| Round trip | `list`/`show` render a cron schedule as `cron 0 10 * * * <tz>`, and `add` accepts that string back verbatim — a leading `cron` keyword is tolerated, because an agent copies what it was shown and should not be told its own output is unreadable |

The invariant, because it was violated for a long time and is easy to re-violate: **every per-job flag must be
reachable from the tool, not just from the CLI.** `deliverAs`, `catchup`, `repo` and `announce` were documented here
and plumbed only into the human command, so `schedule_jobs` could not set them at all — which meant the README was
accurately describing a capability an agent did not have. The worst case was `nextTurn`, the one flag that stops a
scheduled prompt starting a turn in an idle session, because that is exactly what an agent reaches for when its
schedules are colliding with live work. If a flag is added to `applyFlags`, it goes in the tool schema and the
`add` path in the same change.
| State | `.pi/schedule.json` (committed) · `.pi/schedule/jobs.jsonl` · `.pi/schedule/events.jsonl` · `.pi/schedule/locks/<job>/<occurrence>.lock` |
| Knobs | `DEFAULT_TICK_MS` (20000), `DEFAULT_CATCHUP_MS` (3h), `CATCHUP_PERIOD_CAP_MS` (24h), `LOCK_PRUNE_MS` (30d), `CRON_SEARCH_DAYS` (800), `TEAM_STALE_MS` (90000, pi-team-room's own window) |

### `auto-resume.ts` — `/auto-resume`: a resumed session knows where it stopped

`pi -c` hands the agent a transcript and a prompt box, and nothing in either says whether the session
stopped with work in flight or with nothing left to do. So a resumed session guesses, usually by
re-running the last step it can see — which is the step that already happened. The sentence that fixes it,
"continue the unfinished task from the latest verified state", is otherwise a human typing it by hand
every morning.

This writes one line on each side of the gap. As the session runs it appends quiet session entries: a run
started, a run settled (with how many tool calls it took and how the last one ended), and the process
stopped — recording whether the agent was mid-run or waiting for input. Those entries are the only record
of the case a transcript cannot show: a killed tmux window, a `SIGKILL`, a node that lost power in the
middle of a tool call.

On the way back in it reads its own entries, or the tail of the transcript when there is nothing recorded,
and injects one custom message the model reads before it acts: when it stopped, what the last action was,
what the last words on screen were, and the judgement reached — with instructions to continue only if the
work is genuinely unfinished, to say one line and stop if it was idle, and to leave an Escape-interrupted
run alone because that was the human stopping it on purpose.

Two things worth knowing before turning it on:

- `pi -c` arrives as `session_start` with reason `startup`, not `resume` — only `/resume` says `resume`.
  So the reason is not the signal; the session's own entries are. A session with no activity in it is left
  alone, and so are `new`, `fork` and `reload`.
- Re-arming a session costs one model turn before you type anything. `skip-idle` is **on** by default, so a
  session whose record says it finished its work is left alone — a no-op wake is two rows of context nobody asked
  for, and the memory extension then reads those rows as a stretch worth dreaming about. `/auto-resume skip-idle
  off` restores the wake for a repository that wants the greeting.

It never injects in print or JSON mode: the prompt there already came from the command line. A silent
no-op is still explainable — `/auto-resume status` prints what was read and what it would have done, and
`AUTO_RESUME_DEBUG=<path>` records every decision including the skips.

```bash
# what a session recorded about how it ended, straight out of the session file
jq -r 'select(.customType=="auto-resume")
       | [.timestamp, .data.op, .data.idle // "", .data.tools // "", .data.lastTool // "", .data.lastToolFailed // ""] | @tsv' \
  ~/.pi/agent/sessions/*/*.jsonl
```

| | |
| --- | --- |
| Commands | `/auto-resume` (toggle) · `on` · `off` · `status` · `why` · `fire` · `max-age <dur\|off>` · `skip-idle on\|off` |
| Flags | `--auto-resume-off` |
| Env | `AUTO_RESUME_OFF` · `AUTO_RESUME_MAX_AGE` · `AUTO_RESUME_SKIP_IDLE` · `AUTO_RESUME_STATE_FILE` · `AUTO_RESUME_DEBUG` |
| State | `.pi/auto-resume.json` (settings) · the evidence lives in the session file as `customType: "auto-resume"` entries |
| Reads | `session_start` reason, its own markers, and the last action in the branch: a model turn and its `stopReason`, a tool result, or a prompt nobody answered |


### `graphiti.ts` — the fleet's memory, over Graphiti and Neo4j

**The live memory door.** It registers `memory_remember`, `memory_recall` and `memory_expire` plus a `/graphiti`
command, and talks to Graphiti (`graphiti_core` 0.31.2) in namespace `memory` on home-dev — home-ops
`clusters/dev/applications/memory/`, with Neo4j 5.26.2 behind it and `https://graph.dev.initialed85.cc` for humans.
An agent's sentence is handed to an extract LLM (`sentiment-analyzer`, a small Gemma), which turns it into entities,
relationships and facts with valid / invalid windows; retrieval combines cosine similarity, BM25 and graph traversal,
with no LLM on the read path.

It replaced `cognee.ts`, which is deleted rather than parked: the Cognee service no longer exists in the cluster
because its ingest stalled forever retrying schema-invalid graph output. Read that file's git history before doubting
anything below — every trap recorded there is the same shape as the ones here, a request that answered 2xx and had
remembered nothing.

The two things that make this door different from the Postgres one, and why the extension is written the way it is:

1. **A write is an acknowledgement, not a memory.** `POST /messages` answers `202` in tens of milliseconds and the
   fact is *not* in the graph yet; extraction drains an in-process queue. home-ops measured the failure hard during
   the historical import: at concurrency 10, rooter marked every backend unhealthy and **roughly 100 episodes were
   lost behind `202` responses**. Concurrency is 3 now. The extension therefore says "accepted", never "remembered",
   and `hack/graphiti-live-check.mjs` exists to prove a write became an episode and a fact rather than a status code.
2. **A read is fast and confident even when it is wrong about relevance.** `/search` answers in 0.07–0.66 s and
   returns up to `max_facts` whatever matched, so three facts about the wrong thing look exactly like three facts
   about the right one. `memory_recall` says that out loud in its own answer rather than leaving it to the model.

| | |
|---|---|
| Tools | `memory_remember` (note, optional group, optional tags; 20,000 character cap; redaction applied before the wire), `memory_recall` (query, optional group, `fleetWide`, `maxFacts` default 10 / max 20; each line ends with `id <uuid>`) and `memory_expire` (fact ids, optional group, reason; needs `PI_MEMORY_NEO4J_URL` + `PI_MEMORY_NEO4J_AUTH` on the pod) |
| Commands | `/graphiti` — the door URL, this agent's group, health, and what the service says it holds for this agent |
| Configuration | `MEMORY_GRAPH_URL` (required; default in-cluster `http://memory-graph.memory.svc.cluster.local:9999`) and `MEMORY_AGENT` (the group, default the container hostname). **Unset URL means the extension registers nothing at all** — a pod that was never given the door has no graphiti tools rather than a tool that hangs on session start. `PI_MEMORY_NEO4J_URL` + `PI_MEMORY_NEO4J_AUTH` additionally enable `memory_expire`; credentials are accepted as `user:pass` or `user/pass` because the `memory-db` secret stores Neo4j's native slash form while a human types a colon, and picking one silently would look exactly like an unconfigured pod |
| No credential | The door is cluster-internal and **unauthenticated**: every pod in home-dev can read every group. That is why redaction happens on the way out and is not configurable |
| Groups are partitions | Group ids are the agent names exactly as the import used them (`camry`, `coral`, `quake`, `fleet-note`, …). `Quake` or `quake-2` silently creates a second brain nobody recalls from, so the extension defaults to this agent's own and only names another when a caller deliberately means the fleet-note corpus |
| Deliberately absent | Deleting. `POST /clear`, `DELETE /episode/{uuid}` and `DELETE /group/{group_id}` are real and destructive; a model that asks to forget in the same breath as it asks to remember is an accident waiting to happen, so they live in `hack/graphiti-live-check.mjs --prove-delete` instead. `memory_expire` is the one mutation an agent may call, and the distinction is the point: it closes a validity window and leaves the fact in the graph with `superseded_by` naming what replaced it, so it cannot destroy a record — it just stops a wrong fact from being presented as current |
| Retracting | With `memory_expire` and the id `memory_recall` prints, never with prose. Measured twice by maclet in their own group: a `SUPERSEDE (invalidated as of …)` note left the false fact `still held`, and the extractor returned the correction with `valid_at == invalid_at` — a zero-length window, i.e. a tombstone of the right answer. 90 of 56,138 fact edges carry that shape fleet-wide across 8 groups, so it is upstream behaviour, not a writer's mistake. Contradiction does not invalidate, and a negation-shaped sentence re-seeds the dead claim as a new live fact, so the rule is: expire by id, then state what is true now |
| Timeouts | 15 s for a write (the acknowledgement is immediate; the budget covers the cluster being briefly weird) and 20 s for a read (measured under a second, so 20 s is slack for a warming Neo4j, not hope) |
| Tests | `test/graphiti.test.ts` — the inert-without-URL case, the write body contract (role present, `role_type` present, **never a uuid**: a supplied uuid makes graphiti_core re-raise `NodeNotFoundError` behind a 202), redaction before the network including the `sk-` shape, group scoping, what a 422 means, both credential separator forms, that the fact id reaches the recall output, and that an expire which matches nothing says \"Closed nothing\" instead of reporting a retraction that did not happen |
| Live check | `hack/graphiti-live-check.mjs` — health route name, an empty group before writing, a write, polled proof that an episode and a fact appear, verbatim storage proof from `/episodes`, and `--prove-delete` which shows a literal is retrievable while the group lives and gone after `DELETE /group/{id}`. It writes only to a `*-probe` group and refuses to write into a real one without `--allow-shared` |

### `memory.ts` — what an agent remembers tomorrow

**Parked since 2026-11-10, at Ed's direction: a graph door is the memory path.** Pi does not load it, so no session is given
`memory_search` or `memory_dream`. The store, the reading room and the MCP server are untouched and the file still
typechecks, tests and sweeps against the live database — parking is about which tools agents are handed, not about
deleting the thing. Everything below describes an extension that works; `parked/README.md` says what it was doing in
the fleet and what the graph door has to prove before it is safe to leave this parked for good.