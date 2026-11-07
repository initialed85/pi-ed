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

Three triggers, all gated on the same test: `session.event_count > session.dream_seq`. If there is no unsummarized
delta, no dream runs - a session that is merely open is not a session worth thinking about.

- **10 minutes after going idle** - the ordinary case.
- **Just before compaction** - the last chance to keep something the harness is about to throw away.
- **10 minutes after a resume** - a session that came back is usually continuing something, and what it remembered
  on the way out is worth comparing with what it does next.

`dream_seq` is written only after a dream succeeds, which is what makes an interrupted pass resumable rather than
lost.

## How retrieval weights

Own memories first. Other agents' memories are visible - a fleet that forgets what its teammates learned is just a
bunch of lonely agents - but they come back lower-weighted and labelled `mine = false`, so an agent never mistakes a
teammate's memory for its own experience. The default is 1.0 own / 0.65 other, applied *after* the nearest-neighbour
pass because the hnsw index orders by distance alone and re-ranking inside it would fight the index. See
`memory_search` in `schema/001_init.sql`.

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

## What never gets stored

`redact()` runs over every piece of text before it becomes a row: DSNs with credentials, `Authorization: Bearer`,
`AKIA…`, `ghp_…`/`github_pat_…`, `xox[baprs]-…`, private-key blocks, `AIza…`, and common `password = "…"` shapes -
plus anything the repository or agent config lists in `neverStore`. Which rules fired is recorded in `meta.redacted`,
so a row admits it was filtered rather than pretending it was clean. It is pattern-matching, not a proof; the design
promise is that raw turns are recoverable from Pi's own session files, so the store is not the only copy of anything.

## Deliberately not decided yet

- **How the Pi side reaches the store.** Direct Postgres is the chosen path - no separate in-cluster ingest API - but
  the route is unfinished. The service is ClusterIP-only, so today a Pi session on this box reaches it with
  `kubectl port-forward`. A LAN-only LoadBalancer (with the secret moved out of git and the password rotated in the
  same change) is delegated to home-ops and has not shipped. Until it does, the extension behaves exactly as designed
  anyway: it spools.
- **Vectors.** `memory.embedding` is written as null. The embedder service is home-ops' to deploy and is not up yet,
  so retrieval today is the keyword path (`websearch_to_tsquery` over summary and feel, with the same 1.0 own /
  0.65 teammate weighting). The pgvector half of the schema - the hnsw index and `memory_search()` in
  `schema/001_init.sql` - is applied, verified with a cosine probe, and unused until something writes vectors.
- **What an agent is.** The schema keys identity on the agent (`agent.id`) with `session.repo` alongside it, on the
  assumption that one agent working in two repositories is one personality with two workplaces. If that turns out to
  be wrong it is a join away from being per-checkout.
- **What the subject index is for.** `subject_index` is refreshed by every dream and rendered by nothing yet. The
  plan is a handful of live subject names in a system prompt, not a dump of the whole index - a prompt that changes
  every session is a prompt that has stopped being a personality.

## Check it live

```sh
# a real Pi session against the real store: writes, reads back, dreams, then deletes what it wrote
kubectl port-forward -n pi-ed svc/memory 15432:5432 &
PI_MEMORY_DSN="$(kubectl get secret -n pi-ed pi-ed-postgres -o jsonpath='{.data.DATABASE_URL}' | base64 -d | sed 's#@memory:5432#@127.0.0.1:15432#')" \
  node ./hack/memory-live-check.mjs --idle-seconds 15
```

This is the only test that can catch the class of mistake the unit suite cannot: the first live run found
`array_concat` in an upsert's `on conflict do update` clause. Postgres resolves function names while *parsing*, so a
statement containing a function that does not exist fails even when the branch containing it never runs - every flush
rolled back, every row went to the spool, and the only visible symptom was a foreign key error one step later. That is
why `flush()` reports its failure to the dream instead of letting the dream discover it, and why `hack/memory-live-check.mjs`
prints extension notifications: an invisible warning is how a write path stays broken for a whole session.

## Apply

```sh
kubectl --context home-dev -n pi-ed exec -i deploy/pi-ed-postgres -- \
  psql -U pi_ed -d pi_ed -v ON_ERROR_STOP=1 < memory/schema/001_init.sql
```

It is idempotent - `create table if not exists`, `create or replace function`, `create schema if not exists` - so
re-applying it after a restore is a no-op rather than an event.
