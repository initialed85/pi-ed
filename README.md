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
hack/         check-package-shape.mjs, the CI gate on the package manifest
.woodpecker/  CI: workflow lint + typecheck + tests
```

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

Twelve of them live in `extensions/` and are what `pi install git:github.com/initialed85/pi-ed` loads. One more,
`memory.ts`, is in **`parked/`**: compiled, tested and swept against the live store, but outside the directory Pi
discovers, so no session is given its tools. Ed turned Postgres memory off on 2026-11-10 to make cognee the fleet's
memory path; `parked/README.md` keeps the measurements taken while that call was being made, and how to bring it back.

`turn-stats.ts` is documented in its own file header: it replaces the client's guesses
about throughput and timing with the numbers Rooter already publishes in response headers, drawn as one
dim line under each assistant answer.

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


### `cognee.ts` — what an agent remembers tomorrow, today

The live memory. It registers `memory_remember` and `memory_recall` plus a `/cognee` command, and talks to Cognee 1.6.7
in namespace `cognee` on home-dev (home-ops `clusters/dev/applications/cognee/`): Cognee ingests the text, builds a
knowledge graph from it — entities and relationships through rooter, vectors through the embeddings Service — and
answers questions against that graph. Ed chose it over mem0 because mem0's FOSS build dropped the graph, and the graph
was the point.

Writing is `memory_remember`, foreground by default: when the tool returns, the note is in the graph. `background: true`
returns in a fifth of a second and lets Cognee build server-side, which is the right choice for a long note or when a
build is already running (Cognee serves one worker, so writes serialize). Attribution goes in as Cognee's `node_set` —
the agent label plus any tags — and deliberately **not** as `session_id`: measured, a write with `session_id` set comes
back `session_stored` with `items_processed: 0`, the dataset stays `empty`, and a recall answers `memory_warming_up`.
Attribution that costs you the memory is not attribution.

Reading is `memory_recall`, and its default mode is `chunks` because it is 50× cheaper (0.3–0.5 s measured) and it is
the one mode that returns the words actually stored. `graph`, `rag` and `hybrid` synthesize across the graph in
10–25 s and cost a rooter round trip — and they reword: a GRAPH_COMPLETION answer to "what is quokkalisk" came back as
"Quokkalisk is a marker word used in the Pi-ed probe note written by Duke…", which is Cognee's prose, not the memory.
An agent that has to wait twenty seconds per recall stops recalling, so the cheap honest mode is the default and the
modes are spelled out in the tool description rather than auto-routed.

Two things the extension refuses to be vague about. A Cognee 200 is not always an answer: while a dataset is warming
up or mid-extraction it returns `source: "system"` entries with a status, and the tool says "no memories yet" in those
cases instead of reporting a read that found nothing. And a timeout is not a rollback — measured, a foreground write
that gave up after 300 s landed anyway, so the tool says the build may still be running and tells the agent to check
with `memory_recall` before writing the same note twice.

Text is redacted before it is sent, by `lib/redact.ts` — the same rule list the parked extension and the reading room
use, so the three cannot drift. That list is not enough for a Cognee key on its own (64 unlabelled hex characters
matches no shape), so `scrub()` adds the live key as a literal pattern to every upstream body this extension echoes.
The key itself is read from a mounted file at activation, held in a closure, and appears in no result, log line or
error.

With no key anywhere the extension registers nothing at all — no tools, no commands — so a pod that has not been given
the Secret has no memory tools rather than a tool that always fails.

| | |
| --- | --- |
| Tools | `memory_remember` (text, dataset, tags, background) · `memory_recall` (query, mode, dataset, tags, limit) |
| Commands | `/cognee` (where memory goes, what the key is mounted from without showing it, and each dataset's build state) |
| URL | `COGNEE_URL` then `COGNEE_BASE_URL` (home-ops' name), default `http://cognee.cognee.svc.cluster.local:8000`; the public door `https://cognee.dev.initialed85.cc` works from a laptop |
| Key | `COGNEE_API_KEY_FILE`, else `<mount>/api-key` where `<mount>` is `COGNEE_MOUNT_DIR` default `/run/secrets/cognee`, else `/etc/cognee/api-key`, else `COGNEE_API_KEY` — the `api-key` key of Secret `cognee-agent-keys` |
| Dataset | `COGNEE_DATASET_FILE`, else `<mount>/dataset`, then `COGNEE_DATASET` / `COGNEE_MEMORY_DATASET`, default `fleet-ops` (Cognee creates a dataset on first write, so the name is set once in the Secret rather than invented per agent) |
| Agent label | `COGNEE_AGENT` → `NAME` → the Pi session name → `host:repo`; sent as `node_set`, and reads can be narrowed with Cognee's `nodeName` (a list — a bare string is a 400) |
| Endpoints used | `POST /api/v1/remember` · `POST /api/v1/recall` · `GET /api/v1/datasets/status/memory` · `GET /health` |
| Deliberately absent | forgetting. Cognee exposes `DELETE /api/v1/datasets/{id}/data/{data_id}` and no tool offers it: deleting from a shared graph should be a decision made on purpose with the ids in front of someone |
| Tests | `test/cognee.test.ts` — request field names against the measured OpenAPI shapes, redaction before the network, no key in any error, a warming-up dataset not reported as a read, configuration precedence |
| Live checks | `hack/cognee-live-check.mjs` (the API contract, plus what Cognee really stored) and `hack/cognee-session-check.mjs` (a real Pi session that calls both tools and reads the marker back). Both write to probe datasets only, delete what they wrote, and scrub their own output so a check cannot become the leak |

### `memory.ts` — what an agent remembers tomorrow

**Parked since 2026-11-10, at Ed's direction: cognee is the memory path.** Pi does not load it, so no session is given
`memory_search` or `memory_dream`. The store, the reading room and the MCP server are untouched and the file still
typechecks, tests and sweeps against the live database — parking is about which tools agents are handed, not about
deleting the thing. Everything below describes an extension that works; `parked/README.md` says what it was doing in
the fleet and what cognee has to prove before it is safe to leave this parked for good.