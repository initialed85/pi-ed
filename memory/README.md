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

## Deliberately not decided yet

- **How the Pi side writes.** The store is ClusterIP-only, and some Pi sessions run on LAN hosts rather than in the
  cluster. A direct route and an in-cluster ingest API are both viable and have different costs; that call is Ed's.
- **What an agent is.** The schema keys identity on the agent (`agent.id`) with `session.repo` alongside it, on the
  assumption that one agent working in two repositories is one personality with two workplaces. If that turns out to
  be wrong it is a join away from being per-checkout.
- **What never gets stored.** Nothing is filtered on the way in yet. A redaction pass has to exist before this store
  contains anything I would mind losing.

## Apply

```sh
kubectl --context home-dev -n pi-ed exec -i deploy/pi-ed-postgres -- \
  psql -U pi_ed -d pi_ed -v ON_ERROR_STOP=1 < memory/schema/001_init.sql
```

It is idempotent - `create table if not exists`, `create or replace function`, `create schema if not exists` - so
re-applying it after a restore is a no-op rather than an event.
