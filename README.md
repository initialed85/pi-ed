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

Eleven of them live in `extensions/` and are what `pi install git:github.com/initialed85/pi-ed` loads. One more,
`memory.ts`, is in **`parked/`**: compiled, tested and swept against the live store, but outside the directory Pi
discovers, so no session is given its tools. `parked/README.md` says why and how to bring it back.

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

**Parked since 2026-11-10.** It lives in `parked/memory.ts`, so Pi does not load it and no agent in the fleet is given
`memory_search` or `memory_dream` while cognee (above) carries the fleet instead. Everything below describes an extension that
works and is still tested; the store, the reading room and the MCP server are untouched by the parking. Skip this
section until it moves back.

Nothing Pi does today survives a machine being rebuilt. This puts the session itself in Postgres: every turn
recorded raw, and a smaller set of things the agent decided were worth remembering, in `pi_ed` on home-dev
(`memory/schema/001_init.sql` explains why those are two tables and not one; `003_writer_heartbeat.sql` adds the
watermark that makes a rolled-back flush visible from outside the cluster).

Recording is ordinary and asynchronous: turns land on `turn_end` and when a run settles, on a debounce, through a
pool that never makes a turn wait for a database. If the store refuses, the rows go to a spool file and ride in with
the next successful flush. Nothing in the extension blocks, and nothing is lost twice — Pi's own session files are
still the raw record.

Dreaming is the interesting half, and it is not code summarising the agent. After ten idle minutes, ten minutes after
a session arrives from history, or immediately before the harness compacts the context away, the extension posts one
hidden message and the agent writes its own memory with `memory_dream`: two to four sentences about the stretch, three
to six loose subjects, and one honest line about how it felt. `feel` is its own column because the point is to watch
it change without parsing prose. A dream only runs over work rows it has not already considered — the rows a dream
produced itself do not count as work — and only when that stretch holds at least `minDreamWork` rows (4 by default),
so a session that woke up, said one line and went quiet is not asked to reflect on it. An interrupted run never
dreams: that was somebody hitting Escape on purpose.

The count is a gate on *asking*, not a verdict on *content*. The store refuses a span for one reason only: it holds
nothing. A short but non-empty span is written and annotated, because the failure mode of the old hard floor was
silent and total — a two-row stretch holding a peer's question about the Earl was declined as "too thin", and the
watermark moved past it anyway. There are two watermarks for the two questions: `dream_seq` is how far a memory has
summarized (what the next dream's span reads off), `dream_considered_seq` is how far a dream has been asked about
(what the gate reads off). Writing a memory moves both; declining moves only the second, so the stretch is folded into
the next memory instead of being buried by the one that passed on it.

A dream that decides nothing was worth remembering still has to close its stretch, or the gate re-opens every idle
window forever: five dream turns in one session, the last three with no work between them, each one a hidden prompt and
a refusal sitting in the context. `closeDreamTurn` moves the local gate and the store's `dream_considered_seq` on a
clean no-op, and deliberately leaves everything open when the store refused for a transient reason — a stretch Postgres
would not take really is unsummarized. What it must never do is move `dream_seq` over rows no memory ever described.

Retrieval is `memory_search`, and it runs two paths rather than choosing between them: the query is embedded and
handed to pgvector's hnsw index, and full text over summary and feel runs underneath as the net - a memory written
while the embedder was down has no vector and is still a memory. This agent's memories come back at 1.0 and
teammates' at 0.65 - visible, labelled with the teammate's name, and never able to outrank something this agent lived
through. Each hit carries the number the query actually ordered by, because a live run of the check noticed the agent
could describe the order of a recall but not its confidence. What that weighting looks like in practice: a teammate's
memory that was the *closer* text (similarity 0.556 against 0.435) still came back second.

The vectors come from a service rather than from this extension - `embeddings.dev.initialed85.cc`, `bge-base-en-v1.5`,
768 dimensions, the OpenAI-compatible `/v1/embeddings` - which matters mostly for what it refuses to do: it sends a
long summary as several chunks and averages the vectors rather than truncating one, and it treats a response of any
other dimension as a failure rather than a value to write into a column that promises 768.

Two safety notes, both learned rather than designed in. Text is redacted on the way in (DSNs, bearer tokens,
`AKIA…`, `ghp_…`, Slack tokens, private-key blocks, `password = "…"`, plus anything your `.pi/memory.json` lists in
`neverStore`), and the row records which rules fired. And a dream is refused when the events it would summarise did
not reach the store: a memory whose raw stretch is missing is a claim nothing can check later, and the agent should
be told that in words rather than handed a foreign key error.

With no DSN configured the extension registers nothing at all — no tools, no commands, no lifecycle handlers — so it
is safe to leave in the package before the store exists.

| | |
| --- | --- |
| Commands | `/memory` (what this agent has, and what is buffered) |
| Tools | `memory_search` (query, limit, since_days, own_only) · `memory_dream` (summary, subjects, feel) |
| Config | `.pi/memory.json` then `~/.pi/agent/memory.json`: `dsn` · `agent` · `dreams` · `idleDreamMinutes` · `resumeDreamMinutes` · `minDreamWork` · `flushMs` · `maxTextChars` · `skip` · `neverStore` · `embeddings` · `embedUrl` · `embedModel` · `embedMaxChars` · `embedTimeoutMs` · `ownWeight` · `otherWeight` |
| Env | `PI_MEMORY_DSN` (wins over both files) · `PI_MEMORY_DISABLED` · `PI_MEMORY_CONFIG` · `PI_MEMORY_SPOOL` |
| Store | `memory.pi-ed.svc.cluster.local:5432` in-cluster; `192.168.1.113:5434` from the LAN (LAN-only LoadBalancer); secret in home-ops' `___secret/` |
| Embedder | `https://embeddings.dev.initialed85.cc` — `bge-base-en-v1.5`, 768-dim, `POST /v1/embeddings` |
| Writes | `event` (raw turns: user / assistant / tool_call / tool_result / marker / system), `session`, `agent` on the way in; `memory` (with `embedding`, `embedding_model`, `detail`) and `subject_index` when a dream lands, plus `session.dream_considered_seq` when a dream ends having written nothing (`session.dream_seq` only when a memory actually landed) |
| Reads | the session branch, the session id, `session.dream_seq` and `session.dream_considered_seq`, and `agent.name` for cross-agent attribution |
| Live check | `hack/memory-live-check.mjs` — a real Pi session against the real store; needs the DSN, spends model tokens, and deletes what it wrote, including when it fails halfway |

#### the graph that forms on its own (`memory.edge`)

Every memory already says what it is about, which memories it was dreamed from, and which subjects it shares. None of
that is a relationship the store can query: what is missing is the other end. `memory.edge` is the typed edge table
that supplies it — `memory_about`, `dreamed_from`, `shares_subject`, four `room_*` kinds over the team-room messages,
and `wakes` between a schedule job and the run it fired — each with `via` (the event, subject or job the link came
from) and `asserted_by` (who claimed it).

Two rules that took an incident to learn. Edges are derived from a `join`, never from a hand-curated list, so a
backfill and the write path cannot drift: `hack/backfill-edges.mjs` and the extension's real-time statements share one
derivation, which is what `test/edges.test.ts` asserts. And derived edges are written **after** the event transaction
commits, never inside it — a graph fault must not spool valid events, because an incomplete graph is a second opinion
that failed while an incomplete event log is the memory system breaking.

The live store holds ~32k edges (31,755 `memory_about`, 145 `wakes`, 139 `room_*`, 128 `shares_subject`, 79
`dreamed_from`), derived from a backfill that ran once. Migration `005_edges.sql` ships `memory.graph_edges`, a view
that resolves each endpoint's type and display name, because an edge whose ends are integers is a graph nobody can
read without a second query.

| | |
| --- | --- |
| Migration | `memory/schema/005_edges.sql` (create-only: rerunnable, and it must be — a `do` block is not idempotent) |
| Backfill | `hack/backfill-edges.mjs` (`--check` derives without inserting; `--apply` runs in one transaction and rolls back on any failure) |
| Kinds | `memory_about` · `dreamed_from` · `shares_subject` · `room_reply` · `room_ask` · `room_delegate` · `room_update` · `wakes` |
| Tests | `test/edges.test.ts` — kind parity between extension and migration, statement shape, edges provably written after the commit, and the derivations reconciled against a live store |

#### the reading room (`ui/`)

A read-only web UI for all of the above — the memories, the events a span is made of, and the graph as a draggable
force-directed picture — at `https://memory.dev.initialed85.cc`, gated by the same Google sign-in as every other dev
service. Node plus `pg` on the back, vanilla JavaScript and SVG on the front, no framework. `home-ops`
`clusters/dev/applications/memory-ui/README.md` covers the gate and the read-only enforcement; `ui/README.md` covers
running it locally.


### `searxng.ts` — web search through my own SearXNG

Registers a tool named `web_search`, which **replaces** Pi's built-in DuckDuckGo search (registering a
tool with a built-in's name replaces it entirely). Results are the same shape the built-in returns, so
nothing downstream notices.

```bash
SEARXNG_URL=https://searxng.dev.initialed85.cc   # default; override for a local container
```

Two things worth knowing if you fork this: the instance must have `json` in its SearXNG `formats` list,
or every call dies with a non-JSON error; and the endpoint is a homelab service behind a LAN/Tailscale
allowlist, so it answers 403 from anywhere else and the tool says so explicitly rather than pretending
there were no results.

### `queue-reload.ts` — `/queue-reload`

Queues a reload for when the agent is next idle, instead of dropping the runtime in the middle of a turn.
`/reload` while the agent is working interrupts it; this waits.

### `session-commands.ts` — `/continue` and `/clear`

- `/continue` re-arms a session with an explicit instruction to resume from the last *verified* state and
  to take a materially different step if the last one failed — rather than retrying the same dead end,
  which is what a plain "continue" tends to do.
- `/clear` starts a fresh session and carries the current session name over, so `--session-name` keeps
  working after you clear.

### `session-markers.ts` — `/comment` and `/score`

Marks on the session for reviewing model performance later. They go in the session history and the
model cannot see them.

- `/comment <text>` — a note.
- `/score <0|1|2> [note]` — a rating: 0 bad, 1 neutral, 2 good. `bad` / `neutral` / `ok` / `good` work
  too, so the intent never has to be remembered.

Each writes a `CustomEntry` with `pi.appendEntry()`. Custom entries are ignored by Pi's
`buildSessionContext()`, and an extension command is executed rather than sent as a prompt, so neither
the mark nor the text you typed reaches the model. `test/session-markers.test.ts` asserts that against
Pi's real context builder rather than against this sentence.

Pi stamps the entry with `id`, `parentId` and an ISO `timestamp`, so it is durable and sits in the tree
at the point you made it. The record also carries what cannot be recovered later: which model and
thinking level were in use (they change mid-session) and the entry id of the message being marked. That
target is the nearest *message* walking back from the leaf rather than the leaf itself, so two marks in
a row still rate the same turn instead of the second one rating the first.

A score of 1 is written, not skipped. If neutral meant "no entry", a reader could not tell a turn rated
neutral from a turn nobody rated, which is the difference between a rating scale and a count of
complaints.

Marks render in the transcript via `registerEntryRenderer`, so you can see what you marked without the
model seeing it.

```bash
jq -r 'select(.customType=="model-marker")
       | [.timestamp, .data.kind, .data.score, .data.text // .data.note] | @tsv' \
  ~/.pi/agent/sessions/*/*.jsonl
```

| | |
| --- | --- |
| Record | `customType: "model-marker"`, `data.v: 1` — the one string a reader should grep for |
| Score | `0` bad, `1` neutral, `2` good, stored as a number so it can be averaged |

### `tags.ts` — `/tag` hashtags on a turn, or on the session

Labels for later. A hashtag goes on the exchange you are looking at, or on the session as a whole, and
none of it reaches the model.

```bash
/tag                             what is tagged, anywhere
/tag message add #rooter #slow   this exchange: the prompt, its tool calls, its answer
/tag session add #wip #home-ops  this session, which also puts them in the footer
/tag message remove #slow
/tag session clear
/tag message list
```

Two scopes, because there are two different things worth labelling. A message tag is about one exchange;
the footer would be the wrong place for it, because a status line is a slot the next turn overwrites — a
turn tag shown there reads as though it belongs to whatever you are doing now. Session tags go in the
footer because they describe the session, and nothing about the next turn can make them stale.

**A message tag is keyed on the turn, not on the leaf.** The record carries both ends of the span:
`turnId` is the nearest user prompt walking back from the leaf, `messageId` is the last message at the
time. Tag mid-turn (after the third tool result) and tag again after the answer, and both join up on the
same exchange; key on the leaf instead and the second tag would describe the first. System entries are
skipped — a `message` entry with role `system` is the prompt and tool loadout being patched, not something
anybody said, and it is often the newest entry in the tree.

**The log is append-only, because that is all the session tree allows.** One record is one operation on
one scope, and what is tagged is what the operations leave behind when replayed along the current branch.
That has three consequences worth knowing: tags are **branch-relative** (navigate to an earlier point with
`/tree` and the tags made after it are not there); tags **survive compaction** (the replay reads the raw
branch, not the compacted context); and an operation that would change nothing **writes nothing**, because
a record that does nothing makes the log read as though something had been applied.

**Names are normalized so one idea cannot become two tags.** The leading `#` is optional and stripped,
`#Prod`, `PROD` and `prod` are the same tag, and the stored list is sorted. Letters and numbers from any
script, then `_ . : / -`, which covers `#home-ops`, `#2026-11-04`, `#v3.0` and `#pi/agent` without allowing
anything that could be mistaken for another part of the grammar. Tags are separated by spaces or commas.

**Completions cover the grammar only** — the scope, then the verb. `getArgumentCompletions` is handed the
text typed so far and nothing else: no session, no branch. Offering tag names would mean caching the tags
this extension last wrote, and that cache goes stale across `/resume`, `/tree` and `/fork`, so it would
start proposing tags that are no longer there. Typing a hashtag yourself cannot be stale.

Like `/comment` and `/score`, these are `CustomEntry` values written with `pi.appendEntry()`, so Pi's
`buildSessionContext()` ignores them and `test/tags.test.ts` asserts that with Pi's own context builder.
A record that names no tags on a `clear` is still rendered, because the log then says the scope was emptied
rather than showing an empty tag list.

```bash
jq -r 'select(.customType=="tag")
       | [.timestamp, .data.scope, .data.op, (.data.tags | join(",")),
          .data.target.turnId // "session"] | @tsv' \
  ~/.pi/agent/sessions/*/*.jsonl
```

| | |
| --- | --- |
| Record | `customType: "tag"`, `data.v: 1` — the one string a reader should grep for |
| Scopes | `message` (one exchange, keyed on its prompt) · `session` (the whole session, shown in the footer) |
| Ops | `add` · `remove` · `clear`, each one record, replayed along the branch |
| Knobs | `TAG_VERSION` (1), `MAX_TAG_LENGTH` (64), `MAX_TAGS_PER_SCOPE` (64), `STATUS_KEY` (`tags`) |

## Tests

```bash
npm run check     # tsc --noEmit && vitest run
```

The suite drives each extension against a fake `ExtensionAPI` (`test/harness.ts`) that records every
registration, tool call, notification and session-manager operation, and fails loudly on anything an
extension has not been written against — a half-built code path shows up as a test failure instead of a
mystery in a live session. There is no Pi runtime, no provider and no network: `searxng.ts` is tested
against a stubbed `fetch`, `test/autopilot.test.ts` holds the hop-limit surface still,
`test/session-markers.test.ts` proves the marks do not reach the model using Pi's own context builder,
`test/tags.test.ts` holds the tag grammar and the branch-relative replay of the append-only log,
`test/schedule.test.ts` holds the DST arithmetic (a gap occurrence, a repeated hour that must fire once),
the lease that a sibling session already holds and the peer election that a lower session id wins, and
`test/packaging.test.ts` asserts each extension's whole registration
surface, so a file that quietly registers nothing cannot pass.

`test/memory.test.ts` is the one suite with a deliberate hole: it never talks to a live Postgres. Every write-path
test runs against a DSN pointed at a closed port, because the behaviour that has to be correct is the one where the
database is unreachable, and the SQL is asserted as statements — parameter counts, the conflict key, the span over
unsummarized events — rather than as rows. What the suite cannot check is whether the SQL parses, so
`hack/memory-live-check.mjs` does: it drives a real Pi session against the real store, reads a memory back across
sessions, waits for a dream, searches a second time against a teammate memory it planted through the same embedder,
prints the recorded kinds, the span the memory anchored to and the vector the dream wrote, and then deletes its own
rows — including when the run fails halfway, because a fabricated memory left in a shared store is worse than a
failed check.

`npm install` pulls `@earendil-works/*` at 1.5.0 for the typecheck. When Pi updates, bump those versions
and re-run; the tests are pinned to the API surface they were written against.

## CI

[Woodpecker](https://woodpecker.dev.initialed85.cc) runs `.woodpecker/lint.yaml` (the house workflow
linter, which is the same plugin every repo on that server runs) and `.woodpecker/ci.yaml`
(`npm ci` → `tsc --noEmit` → `vitest run`).

## Not included

`herdr-agent-state.ts` is excluded on purpose. It sits in the same extensions directory, but its own header
says it is installed and overwritten by [herdr](https://github.com/initialed85/herdr)'s Pi integration. A
copy of someone else's generated file is not a source of truth, and the next `herdr` update would silently
diverge from this repo. `test/packaging.test.ts` fails if a file with those markers appears here.

## License

MIT. These are my working files; they are tuned for my models, my clusters and my habits, and the comments
say which numbers came from measurement rather than from a guess. Take what is useful.
