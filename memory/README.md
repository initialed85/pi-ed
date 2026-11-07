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
- **Cumulative counters.** `pg_stat_database` counts since the statistics were last reset, not since the last vacuum:
  `3068` inserts and `1054` deletes against a store holding a handful of rows is a testing history, not a leak.

If a future incident needs real statement-level visibility, ask for `pg_stat_statements` in the Deployment's
`shared_preload_libraries` plus `log_min_duration_statement = 250ms`. It costs a Postgres restart, and a restart is
safe by design: the writer spools to disk while the store is unreachable and replays on the next flush.

## Apply

```sh
kubectl --context home-dev -n pi-ed exec -i deploy/pi-ed-postgres -- \
  psql -U pi_ed -d pi_ed -v ON_ERROR_STOP=1 < memory/schema/001_init.sql
```

It is idempotent - `create table if not exists`, `create or replace function`, `create schema if not exists` - so
re-applying it after a restore is a no-op rather than an event.
