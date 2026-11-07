# agent memory

A long-lived memory for Pi agents: the full history of what an agent did, and a smaller set of things it decided
were worth remembering.

The store itself is infrastructure and lives elsewhere - Postgres 16.15 with pgvector 0.8.7 in the `pi-ed` namespace
on home-dev, deployed by home-ops as `clusters/dev/applications/pi-ed/`. What lives here is the application's shape
(`memory/schema/`) and, soon, the Pi side that writes to it and reads from it.

## The two halves

`event` is the record. Every turn, unvectorised, append-only. It exists because a vector is a *judgement* about what
mattered, and a judgement made at write time silently becomes the only version you can ever ask about. Keeping the
raw history means a later pass - a better summariser, a different embedding model, a different question - can look at
the same stretch again and disagree.

`memory` is the judgement. A stretch of one agent's history summarized by that agent: what happened (`summary`),
what it was about (`subjects`), how the agent says it felt writing it (`feel`), and a vector for finding it again.
Each row stays anchored to the `event` rows it came from, so a remembered claim can be checked against what actually
happened.

`subject_index` is the lean view of a mind: which subjects an agent actually has memories about, with counts and
recency. pgvector answers "what is similar to this query"; it cannot answer "what is this table about". That is an
ordinary SQL question over the labels the summarising step emits, and it is the part small enough to sit in a system
prompt.

## When an agent dreams

Three triggers, all gated on the same test: is there a stretch that has not been summarized yet. In the extension the
test counts *work* rows in the current branch against how many there were when the last dream landed
(`dreamPending(workSeen, dreamed)`); `session.event_count > session.dream_seq` is the same idea expressed in the store,
for anyone looking from outside. If there is no unsummarized stretch, no dream runs - a session that is merely open is
not a session worth thinking about.

- **10 minutes after going idle** - the ordinary case.
- **Just before compaction** - the last chance to keep something the harness is about to throw away.
- **10 minutes after a resume** - a session that came back is usually continuing something, and what it remembered
  on the way out is worth comparing with what it does next.

`dream_seq` is written only after a dream succeeds, which is what makes an interrupted pass resumable rather than
lost.

**A dream's own rows are not new work.** Dreaming is a turn like any other, so it leaves rows behind: the hidden
request, the agent's answer, the `memory_dream` call and its result. They are recorded in `event` and tagged
`meta.dream_turn`, because a gate that counts them as work makes the first dream look like an unsummarized stretch
forever - a session left open would then dream about dreaming every ten minutes, and a memory corpus would quietly
become a hall of mirrors. The live check caught exactly that (an agent dutifully reporting "dream about a previous
dream" among its subjects, and a memory row whose whole subject list was `none`). Three things hold the line: the gate
counts work rather than rows, the span a memory is anchored to excludes the residue, and `memory_dream` asks
`dreamSpanStatement` first so a span with no work in it is refused in words instead of being written.

## How retrieval weights

Own memories first. Other agents' memories are visible - a fleet that forgets what its teammates learned is just a
bunch of lonely agents - but they come back lower-weighted and labelled with the teammate's name, so an agent never
mistakes a teammate's memory for its own experience. The default is 1.0 own / 0.65 other, applied *after* the
nearest-neighbour pass because the hnsw index orders by distance alone and re-ranking inside it would fight the index.
See `memory_search` in `schema/001_init.sql`.

Two paths run, not one. Vector recall is primary: the query is embedded and handed to `memory_search()`, which takes
the nearest neighbours from hnsw and then applies the weights. Text recall runs underneath it as the net - a memory
written while the embedder was down has no vector and is still a memory, and a query that misses semantically but
matches a word should still find it. The results are merged by row id, each labelled with the path that found it:

```
- mine                     [vector similar 0.435] [memory search, self-test] A short check … — felt: Fine, but thin
- memory-live-check-teammate [vector similar 0.556] [bluehammer, drill]      The drill was retired … — felt: wry
```

That pair is the weighting doing its job rather than the index doing its: the teammate's memory was the *closer* text
(0.556 against 0.435) and still came back second, because 0.435 × 1.0 beats 0.556 × 0.65. It is measured by
`hack/memory-live-check.mjs`, which plants a second agent's memory through the same embedder for exactly this check.

### How far 0.65 actually goes

The crossover falls straight out of the arithmetic: a teammate row outranks your own when its similarity exceeds
`own / 0.65`, i.e. about **1.54x closer**. A second measurement from `2026-11-08` shows the boundary from the other
side - own 0.597 (a dream row that mentions the subject) against teammate 0.851 (verbatim the subject), damped to
0.553, own still ahead by 0.044 where the threshold was 0.918. A run the same day that passed the planted row's *own*
vector as the query - a mistake in the check, since it makes that row a perfect match by construction - produced the
reverse order, 0.650 against 0.506 at a ratio of 1.98. Both regimes are real, so the rule is written down rather than
assumed: **damping is not a veto.** A teammate memory that is much nearer the question will speak over your own
memory that merely mentions the same thing, and anyone tuning 0.65 is deciding how big that gap has to be before that
is allowed. These are the numbers to argue against.

The check now asserts the mechanism rather than the ranking - every row it gets back must satisfy
`score / similarity == the weight the store applied` - and prints the order it observed. Demanding the order would
make a store check depend on which of two sentences happens to be nearer the question, which is a fact about phrasing
and not about retrieval.

## The Pi side

`extensions/memory.ts` is the writer and the reader. It records turns as `event` rows on `turn_end` and when a run
settles, on a short debounce, through a connection pool it never lets a slow database block a turn: if the store
refuses, the rows go to a local spool file and ride along with the next successful flush, keyed by the session they
came from. A dream is not injected by code. The extension posts one hidden message (`customType: "memory:dream",
display: false, triggerTurn: true`) and the agent writes its own memory by calling `memory_dream` with a summary,
subjects and a line about how it felt - which is the whole point: the judgement is the agent's, in the agent's words.

The `event` row shape keeps the distinction a history table needs: `text` is what was said, `meta` is what surrounded
it (which tool, whether it errored, whether the text was clipped, which redaction rules fired), `seq` is assigned by
the database on the way in rather than trusted from the client, and `source_entry_id` makes a replay idempotent - an
id that only exists while the process is alive, which is why the unique key is `(session_id, source_entry_id)` rather
than a primary key.

Images are recorded as `[image image/png 3072b]`. An assistant entry that said nothing is kept ("it thought and said
nothing" is an observation); a user entry that carried nothing is dropped.

Events are never embedded. A dream is the unit of meaning; the raw turns are the evidence under it, and a vector over
every turn would be a second, worse memory of the same stretch.

## The embedder

Vectors come from a service, not from this extension: `embeddings.dev.initialed85.cc` runs `BAAI/bge-base-en-v1.5`
(GGUF F16, 768 dimensions, CLS pooling, L2-normalised output) on a home-dev GPU slice, in the same shape as the image
classifier and the sentiment analyzer. The client is the OpenAI-compatible one - `POST /v1/embeddings`, `{ model,
input: […] }`, `data[].embedding` - so changing model, quantisation or server is a config line in `memory.json`, not a
change to this file, and a teammate's agent can use the same service without sharing any code.

Three things the deployment taught this client:

- **The window is the model's.** bge-base was trained at 512 tokens and llama.cpp answers HTTP 500 above it ("input
  (646 tokens) is too large to process"). A long summary is therefore split at sentence boundaries - word boundaries
  when a single sentence is too long, a hard slice when a single *token* is, which is what a runaway base64 blob is -
  and the resulting unit vectors are averaged back to length one, so a four-chunk memory is comparable to a one-chunk
  one. Truncating would have been the quiet wrong answer: it changes what the vector means while leaving the row
  looking the same.
- **The dimension is part of the store's promise.** `memory.embedding` is `vector (768)` with a check on
  `embedding_dim`, so a service answering 384 dimensions is a reported failure rather than a value to write. Writing
  it would make old rows and new rows silently incomparable.
- **Cost is only knowable if it is written down.** `usage.prompt_tokens` comes back free and lands in the memory row's
  `detail` next to `embed_model` and `embed_chunks`, and `embedding_model`/`embedding_dim` travel on the row itself:
  when the embedder changes, a memory still says which model produced its vector instead of quietly becoming wrong.

An embedder that is down does not stop a dream. The memory is written without a vector, its `detail` carries
`embed_error` with the reason and how long the attempt took, and `memory_search` says in the result line that vector
recall was unavailable. A memory findable only by keywords is a degraded memory, not a lost one.

## What never gets stored

`redact()` runs over every piece of text before it becomes a row: DSNs with credentials, `Authorization: Bearer`,
`AKIA…`, `ghp_…`/`github_pat_…`, `xox[baprs]-…`, private-key blocks, `AIza…`, and common `password = "…"` shapes -
plus anything the repository or agent config lists in `neverStore`. Which rules fired is recorded in `meta.redacted`,
so a row admits it was filtered rather than pretending it was clean. It is pattern-matching, not a proof; the design
promise is that raw turns are recoverable from Pi's own session files, so the store is not the only copy of anything.

## Deliberately not decided yet

- **Which DSN to put in `memory.json`.** Both routes exist now and they are not interchangeable. Inside the cluster -
   or from a checkout whose source address is pod-network, like this one - it is `memory.pi-ed.svc.cluster.local:5432`
   (ClusterIP 10.43.5.96). From a machine actually on the LAN it is `192.168.1.113:5434` (or any node address, same
   Service), and that Service answers *only* LAN addresses. The secret lives in `___secret/` in the home-ops
   repository and the password that used to be in git history was rotated when the LAN route shipped, in the same
   commit. Neither DSN should ever be typed into a shell: read it out of the secret, as the live-check command below
   does.
- **Whether the embedder should be quantised further.** home-ops ran it F16 rather than the Q8 the sentiment analyzer
   uses, on the grounds that an embedding is read back as a distance and 8-bit quantisation drifts distances.
   Accepted, and the knob is theirs. What is *not* open is running an int8 variant next to it: two models in one column
   make a fleet's memories incomparable, and `embedding_model` exists to make that visible rather than to license it.
- **What an agent is.** The schema keys identity on the agent (`agent.id`) with `session.repo` alongside it, on the
  assumption that one agent working in two repositories is one personality with two workplaces. If that turns out to
  be wrong it is a join away from being per-checkout.
- **What the subject index is for.** `subject_index` is refreshed by every dream and rendered by nothing yet. The
  plan is a handful of live subject names in a system prompt, not a dump of the whole index - a prompt that changes
  every session is a prompt that has stopped being a personality.

## Check it live

```sh
# a real Pi session against the real store: writes, reads back, dreams, searches again, deletes what it wrote
PI_MEMORY_DSN="$(kubectl get secret -n pi-ed pi-ed-postgres -o jsonpath='{.data.DATABASE_URL}' \
  | base64 -d | sed 's#@memory:5432#@10.43.5.96:5432#')" \
  node ./hack/memory-live-check.mjs --idle-seconds 15
```

No port-forward needed from a checkout on the cluster network. From a machine on the LAN, the same secret with
`s#memory:5432#192.168.1.113:5434#` instead.

What a passing run proves, in order: turns of five kinds in `event`; a read path that reports an honest empty result
before anything is written; a dream anchored to `span_first_event`/`span_last_event` with a vector from the embedder
and the model name beside it; a second search that finds this agent's own memory *above* a teammate memory planted
through the same embedder, with the teammate row labelled by its own name; and a store left with nothing of the probe's
in it - including when the run fails halfway, because a fabricated memory left in a shared store is worse than a
failed check.

The prune waits for the writer process to exit. That ordering is not pedantry: the last turn's rows flush on
`agent_settled`, which happens *after* the tool result the check waits for, so a delete that runs first is followed by
the inserts it just performed. Four check runs left a resurrected session row, four events and an agent row behind,
and each one had reported a clean store while doing it.

This is the only test that can catch the class of mistake the unit suite cannot: the first live run found
`array_concat` in an upsert's `on conflict do update` clause. Postgres resolves function names while *parsing*, so a
statement containing a function that does not exist fails even when the branch containing it never runs - every flush
rolled back, every row went to the spool, and the only visible symptom was a foreign key error one step later. That is
why `flush()` reports its failure to the dream instead of letting the dream discover it, and why `hack/memory-live-check.mjs`
prints extension notifications: an invisible warning is how a write path stays broken for a whole session.

## What a store failure is called

Every failure this extension reports is prefixed with one word that names its kind - `dns:`, `refused:`, `timeout:`,
`slots:`, `auth:`, `sql:`, `error:` - and the original text follows verbatim. The tag exists because of a trap
home-ops hit while proving the sweep job: the probe connected to `-h pi-ed-postgres`, the *Deployment's* name, and
died with `could not translate host name`. That is a configuration fault, and it presents to a reader exactly like an
unreachable store - which is the one distinction the heartbeat pairing with `pg_isready` is supposed to make. So the
name matters on both sides:

- **the in-cluster Service is `memory`** (`memory.pi-ed.svc.cluster.local:5432`, ClusterIP `10.43.5.96`). The
  Deployment is `pi-ed-postgres` and that name does not resolve to anything. `kubectl exec deploy/pi-ed-postgres`
  works because it targets a pod, not a host.
- `dns:` means something is pointing at the wrong place. `refused:` means the place exists and nothing is listening.
  `slots:` means the store is up and full. `sql:` means the store answered and disagreed - the `array_concat` class
  of bug lands there. `error:` is honest about not knowing.

Classification is done on the message text, not on exception types, because Node raises string-coded errors here and
Postgres raises SQLSTATE-prefixed text there, and text is the only common ground. `classifyStoreError` and
`describeStoreError` are exported, and `test/memory.test.ts` asserts the classification against real messages -
including home-ops' trap, quoted word for word - plus the end-to-end case, where the CI DSN points at a closed port
on `127.0.0.1:1` and the tool must answer `memory_search failed: refused: connect ECONNREFUSED 127.0.0.1:1` rather
than a mystery.

## What the statistics look like from outside

`pi_ed` will look strange in `pg_stat_*` and it is worth writing down why before someone spends an evening worrying:

- **Counts that dwarf the table.** `subject_index` is a materialized view and every dream ends with `refresh
  materialized view subject_index`, which is a truncate plus a bulk insert. Postgres reports those as large
  `n_tup_ins` numbers, and the rows it removed are invisible: `0` live and `0` dead next to a few hundred inserts is
  this view behaving normally, not rows being lost.
- **Deletes with no rows left.** The live check writes under the agent name `memory-live-check` and deletes everything
  it wrote at the end of a run, on the failure path as well as the success path. That is where `n_tup_del` comes from
  while the tables sit near empty.
- **Rollbacks.** Every flush is a transaction, so a rejected statement is a rollback - the `22` rolled back against
  `2807` commits was the live check's own failing statements, not a write path silently breaking. When that did happen
  for real (the `array_concat` bug above), the symptom was visible: every row went to the spool and the check said so.
- **`n_live_tup` is an estimate, not a count.** Measured on this store: `pg_stat_user_tables` reported
  `memory | 24 ins | 23 upd | 1 del | 24 live` in the same minute that `select count(*) from memory.memory` returned
  `0`. The visibility map had not been brought up to date after the prune. Quoting that number as residue would have
  reported rows that do not exist. The honest external read is `relkind` plus `count(*)`, with `pg_stat_database`'s
  `xact_rollback` as the database-wide signal.
- **Read `relkind` before believing anything about a "table".** Join `pg_stat_user_tables` to `pg_class` and look:
  `m` is a materialized view, `r` is a table. home-ops read `subject_index` as a table with vanished rows, and every
  real `r` table here has deletes nearly equal to inserts (`agent 14/13`, `event 264/264`, `session 23/22`), which is
  the probe writing and then cleaning up. Their side of this is `MAINTENANCE.md` (home-ops `7ce76ac`), with the
  `relkind` query tested against this live store rather than written from memory.

- **Cumulative counters.** `pg_stat_database` counts since the statistics were last reset, not since the last vacuum:
  `3068` inserts and `1054` deletes against a store holding a handful of rows is a testing history, not a leak.

If a future incident needs real statement-level visibility, ask for `pg_stat_statements` in the Deployment's
`shared_preload_libraries` plus `log_min_duration_statement = 250ms`. It costs a Postgres restart, and a restart is
safe by design: the writer spools to disk while the store is unreachable and replays on the next flush.

## Writer visibility: the heartbeat table

### What things actually cost here

Measured from `pg_stat_statements` (on since home-ops `9325af4`, `track = all`) after a full live-check run:

| statement | calls | mean | max |
| --- | --- | --- | --- |
| `insert into event (…)` | 53 | 0.28 ms | 7.69 ms |
| `refresh materialized view subject_index` | 6 | 16.01 ms | 21.72 ms |
| `select * from memory_search($1, $2::vector, …)` | 5 | 4.34 ms | 17.11 ms |
| `insert into writer_heartbeat (…)` | 6 | 0.29 ms | 0.54 ms |

Read those numbers the way the view produces them, or a future comparison invents a regression. `pg_stat_statements`
is **cumulative since the last reset or server start**, so `calls` is a running total, not a measurement of anything
that happened today: home-ops read this same view earlier in the same evening as my run above and got `4 calls,
14.78 ms mean, 17.77 ms max` for the matview refresh where I read `6 calls, 16.01 ms mean, 21.72 ms max`. Same
reality, different moments. **Compare means and maxima across time; never compare `calls`.** If a run genuinely needs
per-run counts, the tool is `select pg_stat_statements_reset()` - and that is shared state in a database other people
are reading mid-afternoon, so it is a thing to say out loud first, not a thing to slip into a measurement script.

The matview refresh is the most expensive routine thing this store does, and it costs twenty milliseconds - which is
also why `log_min_duration_statement = 250 ms` is defensible as a number rather than a preference: it sits roughly
**twelve times above the priciest recurring statement here**, so anything that clears it is pathological by
definition. The check home-ops added to the daily sweep follows from that directly and has a counter-intuitive
healthy reading: `kubectl logs deploy/pi-ed-postgres --since=24h | grep duration:` should print **nothing**, and a
line is the finding. Two
consequences worth recording so nobody re-derives them:

- **`log_min_duration_statement = 250ms` logs nothing normal, on purpose.** It is a tripwire for a statement that has
  gone pathological, not a way to see ordinary cost - `pg_stat_statements` is where ordinary cost lives, without
  writing statement text into logs the fleet scrapes. Statement text here is agent-authored content, so logging at
  10 ms to catch a 16 ms refresh trades a store's reasoning for a number that is already available in the view.
  Defended in git now, in the manifest comment where the setting lives (home-ops `e23a14d`), with the twelve-times
  ratio as the justification so a future sweep cannot "optimise" the threshold down by intuition.
- **Event inserts are one row per statement (53 calls, 53 rows) and stay that way.** Batching them into one statement
  per flush would save roughly fifteen milliseconds in a whole run - real, and not worth losing the ability to name
  which statement a failed transaction failed on. If a future session ever does batch them, it should say which
  number made it worth it.

`74b2818` made failures *quieter* on purpose - a rejected batch rolls back, the rows go to the local spool, the dream
says so to the agent, and the store is pruned clean afterwards. Nothing cluster-visible remains. `writer_heartbeat`
(`schema/003_writer_heartbeat.sql`) is the fix for that: the writer stamps the store on its way out, in its own
implicit transaction, never inside the batch's transaction - a stamp that rolls back with the failure it is meant to
report is not evidence of anything.

Two timestamps, and the pair is the whole design:

| column | meaning |
| --- | --- |
| `last_activity_at` | a writer was here - a session opened, or a flush was attempted, successfully or not |
| `last_flush_at` | a writer *committed* a batch |

Plus `flushes`, `failures`, `spool_rows` (how deep the backlog on local disk is), `last_error`, `last_error_at`.

The reason both exist is that "the watermark is old" is not a signal: an agent that is not running has an old
watermark too. Activity without a commit is the signal, and it only appears when the store is reachable and refusing -
which is exactly the `array_concat` shape: every flush rolled back, every row went to the spool, and the only trace
was `xact_rollback` climbing while the tables stayed empty.

`schema/003_writer_heartbeat.sql` - the table itself, including `spool_since` (created with the table for a fresh
store, and carried onto an existing one by `alter table ... add column if not exists`); `heartbeatPageAlertStatement` and
`heartbeatAdvisoryAlertStatement` in `extensions/memory.ts` - the two queries, exported from the writer so the
documentation and the alerts cannot drift apart; `test/writer-heartbeat.test.ts` - the proof, which runs only against
a store (`PI_LIVE_DSN=... npx vitest run test/writer-heartbeat.test.ts`) and fabricates each shape: stale without a
commit, healthy, recently refused, refused long ago:

```sql
-- page someone when a writer is working and not committing
select agent_id, repo, last_activity_at, last_flush_at, failures, spool_rows, last_error
from writer_heartbeat
where (last_flush_at is null and last_activity_at < now() - interval '2 hours')
   or (last_flush_at is not null and last_activity_at - last_flush_at > interval '2 hours')
order by last_activity_at desc;

-- note it, do not page anyone, when a writer was refused recently or has rows stranded
select agent_id, repo, failures, last_error, last_error_at, spool_rows
from writer_heartbeat
where (failures > 0 and last_error_at > now() - interval '24 hours')
   or (spool_rows > 0 and last_activity_at > now() - interval '2 hours')
order by last_error_at desc nulls last;
```

If a maintenance sweep only gets to run **one** statement, run the sweep variant - `heartbeatSweepStatement()` - which
is both conditions in one result set, page rows first, with the number a human actually reads:

```sql
select * from (
  select agent_id, repo,
    case when (last_flush_at is null and last_activity_at < now() - interval '2 hours')
           or (last_flush_at is not null and last_activity_at - last_flush_at > interval '2 hours')
         then 'page' else 'note' end as severity,
    case
      when last_flush_at is null then round(extract(epoch from (now() - last_activity_at)) / 60.0, 1)
      else round(extract(epoch from (last_activity_at - last_flush_at)) / 60.0, 1)
    end as minutes_without_commit,
    spool_since, round(extract(epoch from (now() - spool_since)) / 86400.0, 1) as spool_days,
    flushes, failures, spool_rows, last_error, last_error_at, last_activity_at, last_flush_at
  from writer_heartbeat
  where (last_flush_at is null and last_activity_at < now() - interval '2 hours')
     or (last_flush_at is not null and last_activity_at - last_flush_at > interval '2 hours')
     or (failures > 0 and last_error_at > now() - interval '48 hours')
     or (spool_rows > 0)
) as flagged
order by (severity = 'page') desc, last_activity_at desc nulls last;
```

### Windows that match how often someone actually looks

The sweep variant's advisory half is **wider** than `heartbeatAdvisoryAlertStatement`, deliberately, because of a rule
that applies whenever one system reports on another's database:

> a report window has to be comfortably wider than the interval at which it is read, or the condition stops
> describing what happened and starts describing when you happened to look.

home-ops' sweep runs once a day at 01:30 Perth. A 24 h failure window read once a day can only see a refusal that is
still inside its own window when the sweep fires, so a refusal 25 hours old is invisible forever - window and cadence
cancel each other out. The sweep therefore looks back 48 h, two sweep intervals, which is the smallest margin that
makes the gap impossible. `spool_rows` loses its recency guard entirely, for the same reason aimed the other way:
"spooled within the last two hours" is effectively dead on a daily cadence and hides the case a daily reader most
wants - a spool sitting there for days because a laptop closed and nothing replayed it. `spool_rows` returns to zero
by exactly one route (a successful replay by the writer that wrote it), so a nonzero value is a finding at any age,
and the age is already in the output as `last_activity_at` rather than being used to filter it away.

The real-time pair keeps its narrow windows because a real-time evaluator has nothing to widen: `heartbeatAdvisoryAlertStatement`
is the 24 h / 2 h version, and `test/writer-heartbeat.test.ts` proves both readings on the same fabricated rows - a
refusal 30 hours old is outside the alert set and inside the sweep, and a writer that stranded 7 rows three days ago
is missed by both alert queries and caught by the sweep.

### The age of a finding is in the store, not in the report

`spool_since` records when a stranded backlog began, and only a transition from "no backlog" starts it: a failure
that repeats does not reset the clock, and `heartbeatFlushStatement` sets both `spool_rows = 0` and `spool_since =
null`, so the next stranding measures from then rather than inheriting an old measurement. The sweep returns
`spool_days` alongside it.

That column exists because home-ops' report design needs an age and the heartbeat previously could only give the age
of the *last* failure. A finding that reappears every morning as a fresh discovery trains a reader to skim past it -
their own precedent for what that looks like is `cert-manager-startupapicheck`, `Failed` in dev for 105 days,
contributing a permanent series nobody reads any more. "Still open, 4 days" is only honest if something measured the
4 days. The dedup key is `agent_id` with `severity`, and the age anchors are different per finding: `last_error_at`
for a refusal, `spool_since` for a backlog. The live suite proves the non-resetting directly, by backdating a
backlog four days, running another refusal against it, and asserting the timestamp did not move.

One consequence of the page query that a test nearly made me get wrong, so it is written down: **a page row can be
late without being wrong.** A healthy writer's asymmetry is a few seconds, because it flushes on a debounce measured
in seconds, so a one-day gap between last commit and last turn cannot come from a session that ended cleanly - it can
only come from turns that failed to commit. A writer that failed, kept taking turns for a day, and then had its
machine close three days ago still pages, and the reader distinguishes "happening now" from "nobody has fixed this"
by `last_activity_at`, which is printed in every row.

The severity column is the point of this variant: a daily sweep should not depend on which query the operator
remembered to run. It also exists because a sweep has to read an *empty* result honestly - **zero rows means no
writers are active**, not no problem - so the same sweep should check `pi-ed-postgres` readiness alongside it, and
treat "no rows" and "app unhealthy" as one finding rather than two clean ones. `minutes_without_commit` is measured
against the last commit when there is one and against arrival when there is none, which is why the column is a `case`
rather than a subtraction: the two page shapes have different clocks available.

One trap worth naming here, because it cost a test run: Postgres comments start with `--` or a slash-star, never a
pair of slashes. A `//` comment written neatly inside a SQL template string parses as division and fails at the first
word of the sentence, with the typechecker completely uninvolved. The sweep statement carries no comments for that
reason.

**Two hours** is the page window, chosen for the failure mode rather than for the fastest possible detection: a normal
session flushes every few seconds, so a writer that is functioning does not go two hours without a commit, while two
hours is long enough that a laptop session that was closed, a checkout that was moved, or a Postgres restart that the
pool rode out does not page anyone. The advisory query's 24 hours is deliberately a *record* window rather than an
alert threshold - a planned restart produces exactly one refused batch, and an alert that fires on every planned
restart is an alert that gets muted the first time it is right.

What is *not* covered, and is worth saying plainly: a store that cannot be reached at all leaves no stamp anywhere,
and an absent stamp is indistinguishable from nobody working. That is a property of option (b) - a watermark written
by the writer - and it is why the page query looks for asymmetry between two columns rather than for age. Whether a
`pi-ed-postgres` exporter is scraped by vmagent on top of this is a separate decision for Ed, not something to settle
by inference from the heartbeat.

## Backups, and the window not to roll in

Two copies exist and they are not equally trustworthy. The nightly `pg_dump` CronJob - alpine, no kubectl, mounts the
NFS share directly and writes `pi-ed-dump-<utc>.sql` to romulus - is the copy worth restoring from. The Longhorn
`backup-daily` group in dev also carries `pvc-4b1dccc5`, and that is the copy to hope is never needed: Longhorn
silently skips a volume that is *detached* when the job fires - labelled, selected, reported as handled,
`lastBackupAt: none`. Not hypothetical; it happened to `woodpecker-pgdump` on 2026-11-07.

So nothing detaches this volume between 17:55Z and 18:10Z. No `kubectl rollout restart deploy/pi-ed-postgres`, no
scale to zero, no cordon that evicts it. A manifest change that alters the pod template - `shared_preload_libraries`
for `pg_stat_statements`, an image bump - belongs at some other hour, because Argo rolls the pod whenever the sync
wave lands and a pod rolled at 18:00Z is a volume detached exactly when the backup job enumerates it. A rollout
outside that window is safe for the writer too: the pool fails, spools to disk, and replays on the next flush.

Assert presence and mtime when checking a backup, never size. A few hundred bytes is the correct output of a healthy
store the live check has just cleaned out; a `Complete` CronJob with no new file is the failure mode.

## Apply

Apply them in filename order - `001` is the store, `002` added `event.source_entry_id`, `003` added
`writer_heartbeat`:

```sh
for f in memory/schema/*.sql; do
  kubectl --context home-dev -n pi-ed exec -i deploy/pi-ed-postgres -- \
    psql -U pi_ed -d pi_ed -v ON_ERROR_STOP=1 < "$f" || break
done
```

The live check waits on a real model deciding to call tools, so a full run can take several minutes; its budgets are
generous on purpose. A timeout from that script names the phase it was waiting for, and a timeout waiting for a tool
to *start* is model latency, not a broken store - the check's own comment says why an impatient budget manufactures
the failure it exists to detect.

Each is idempotent - `create table if not exists`, `create or replace function`, `create index if not exists`,
`create schema if not exists` - so re-applying them after a restore is a no-op rather than an event, and applying
them out of order fails loudly on a missing dependency rather than half-building a schema.

### The one setting the writer depends on

`001_init.sql` carries `alter role pi_ed set search_path = memory, public`, and the writer's table names are
unqualified, so that line is load-bearing rather than tidy: `insert into event` means `memory.event` only because the
role says so. The failure mode if it ever changes is not an error - if `public` moves first, or something creates a
same-named table in `public`, the writes silently split between two tables and the store reports exactly the row
counts a healthy store would. Two rules follow, and both are worth stating before someone "just reorders" a line:
keep `memory` first in that role's `search_path`, and if it ever has to move, qualify every name in
`extensions/memory.ts` first.

home-ops' copy in `MAINTENANCE.md` spells the sweep query `memory.writer_heartbeat`, and that is the right difference
rather than drift: a report run by someone else should not inherit a setting it does not own, because a sweep that
reads the wrong schema does not fail, it reports "no writers active".
