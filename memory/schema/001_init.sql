-- pi-ed agent memory: initial schema.
--
-- Store: `pi_ed` Postgres 16.15 + pgvector 0.8.7 in home-dev (`memory.pi-ed.svc.cluster.local`, ClusterIP only).
-- The store itself is home-ops' (clusters/dev/applications/pi-ed/); this file is the application's shape and the
-- canonical copy lives here, applied with:
--
--   kubectl --context home-dev -n pi-ed exec -i deploy/pi-ed-postgres -- \
--     psql -U pi_ed -d pi_ed -v ON_ERROR_STOP=1 < memory/schema/001_init.sql
--
-- Two tables of record and one table of judgement, deliberately kept apart:
--
--   event    - the full history, unvectorised, append-only. Cheap, complete, and never rewritten. This is what
--              makes the store rebuildable from scratch and what a future dream pass can re-read.
--   memory   - what an agent "dreamed" about a stretch of that history: a summary, subjects, a vector, and the
--              agent's own note about how it felt writing it. This is the part that gets retrieved.
--   subject_index - the lean aggregate an agent can carry in its head: which subjects it actually has memories
--                   about, weighted by how recent they are. pgvector does similarity per query; it does not tell
--                   you what a table is about. That question is ordinary SQL over the labels the dream step emits.
--
-- Everything is in one `memory` schema so the store can hold something else later without colliding, and so a
-- dump restores into a fresh cluster with one `SET search_path`.

begin;

create schema if not exists memory;

-- The writer in extensions/memory.ts names its tables unqualified, so this line is load-bearing: `insert into event`
-- means `memory.event` only because this role says so. The failure mode if it changes is not an error - move
-- `public` first, or let something create a same-named table there, and the writes split silently between two tables
-- while the store still reports healthy row counts. Keep `memory` first, and qualify every name in the extension
-- before that ever changes.
alter role pi_ed set search_path = memory, public;

set local search_path = memory, public;

/* Who an agent is.

   Identity is the agent, not the checkout: `home-ops` working in home-ops and `home-ops` working in a scratch
   directory are one personality with two repositories. `id` is the stable handle (the team-room session name where
   one exists, otherwise a slug of the hostname plus session name) and nothing derives from it - a rename is a new
   row and the old memories stay attributed to the old name, which is the honest version of "this agent's history". */
create table if not exists agent (
  id text primary key,
  name text not null,
  host text,
  repos text[] not null default '{}',
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  notes jsonb not null default '{}'
);

/* One recorded Pi session.

   `dream_seq` is the cursor that answers "has a memory summarized this far?" - a dream's span starts after it. It is
   stored here rather than computed per query because the difference is between a cheap idle check and a scan, and it
   is the field that makes an interrupted dream resumable. Its sibling `dream_considered_seq` (added in
   `006_dream_watermarks.sql`) answers the different question "has a dream been asked about this far?", which is what
   the trigger gates on; a dream that declines moves that one alone, so refusing to write never buries the rows. */
create table if not exists session (
  id text primary key,
  agent_id text not null references agent (id),
  repo text,
  cwd text,
  source text not null default 'unknown',
  started_at timestamptz not null,
  last_activity_at timestamptz not null,
  ended_at timestamptz,
  end_reason text,
  event_count integer not null default 0,
  dream_seq integer not null default 0
);

create index if not exists session_agent_recent on session (agent_id, last_activity_at desc);

/* The full history.

   Unvectorised on purpose: the vector is a judgement about what mattered, and a judgement applied at write time
   quietly becomes the only version you can ever ask about. Keeping the raw turn means a later dream pass, a better
   summariser, or a different embedding model can look at the same stretch again and disagree.

   `kind` is coarse on purpose too. It says which side of the exchange a row came from, which is enough to tell a
   tool's output from a model's claim about it - a distinction worth keeping because they are not the same evidence.

   `seq` is per-session ordering as recorded, not Pi's internal tree order: the writer is asynchronous and may
   deliver late, so ordering is assigned on the way in rather than trusted from the client. */
create table if not exists event (
  id bigserial primary key,
  session_id text not null references session (id) on delete cascade,
  agent_id text not null,
  seq integer not null,
  at timestamptz not null,
  kind text not null check (kind in ('user', 'assistant', 'tool_call', 'tool_result', 'marker', 'system')),
  tool_name text,
  text text,
  meta jsonb not null default '{}',
  unique (session_id, seq)
);

create index if not exists event_agent_recent on event (agent_id, at desc);
create index if not exists event_session_order on event (session_id, seq);
create index if not exists event_kind_recent on event (kind, at desc);

/* The memories.

   A memory is a stretch of one agent's history, summarized: `span_first_event`/`span_last_event` keep it anchored to
   the raw rows it came from, so a claim can always be checked against what actually happened.

   `feel` is the agent's own line about writing this. It is its own column rather than a sentence inside the summary
   because the point is to be able to see it change over time without parsing prose, and because retrieval results
   that carry it read differently from ones that do not.

   `embedding_model`/`embedding_dim` travel with the row. The vector column is a fixed 768 today (BAAI bge-base-en
   v1.5, the dimension home-ops already proved against this store with an hnsw cosine probe); when the embedder
   changes, existing rows keep saying which model produced them instead of silently becoming wrong. A new dimension
   is a new column, not a migration that destroys the comparison between old and new. */
create table if not exists memory (
  id uuid primary key default gen_random_uuid(),
  agent_id text not null references agent (id),
  session_id text not null references session (id) on delete cascade,
  created_at timestamptz not null default now(),
  trigger text not null check (trigger in ('idle10m', 'pre_compaction', 'resume10m', 'manual')),
  span_first_event bigint references event (id) on delete set null,
  span_last_event bigint references event (id) on delete set null,
  summary text not null,
  subjects text[] not null default '{}',
  feel text,
  detail jsonb not null default '{}',
  embedding vector (768),
  embedding_model text,
  embedding_dim integer,
  check (embedding_dim is null or embedding_dim = 768)
);

create index if not exists memory_embedding_hnsw on memory using hnsw (embedding vector_cosine_ops);
create index if not exists memory_agent_recent on memory (agent_id, created_at desc);
create index if not exists memory_subjects_gin on memory using gin (subjects);
create index if not exists memory_session on memory (session_id);

/* The lean index: what this agent's memory is actually about.

   Counts plus recency, nothing clever. This is the thing an extension can render as a handful of subject names in a
   prompt, and the thing that should stay stable - it changes when the agent's work changes, not when a query does.
   `most_recent` first so a prompt can show the few subjects that are live rather than the most numerous ones. */
create materialized view if not exists subject_index as
select a.id as agent_id,
       subject.subject,
       count(*) as memories,
       max(m.created_at) as most_recent
from memory m
join agent a on a.id = m.agent_id
cross join lateral unnest(m.subjects) as subject (subject)
group by a.id, subject.subject;

create unique index if not exists subject_index_agent_subject on subject_index (agent_id, subject);

/* The retrieval ordering.

   Own memories first, other agents' available but visibly lower-weighted and labelled `mine = false`, so an agent
   can tell the difference between something it remembers and something a teammate remembered.

   The shape matters for the index: hnsw orders by distance alone, so the CTE takes the nearest neighbours first and
   the weighting happens afterwards over a small candidate set. Filtering on `created_at` before the vector
   comparison would fight the index; filtering the candidates afterwards does not. */
create or replace function memory_search (
  p_agent text,
  p_query vector (768),
  p_limit integer default 8,
  p_own_weight numeric default 1.0,
  p_other_weight numeric default 0.65,
  p_since timestamptz default now() - interval '120 days'
)
returns table (
  id uuid,
  agent_id text,
  session_id text,
  summary text,
  subjects text[],
  feel text,
  created_at timestamptz,
  trigger text,
  similarity real,
  weight numeric,
  score numeric,
  mine boolean
)
language sql
as $$
  with near as (
    select m.*
    from memory m
    where m.embedding is not null
      and m.created_at >= p_since
    order by m.embedding <=> p_query
    limit p_limit * 5
  )
  select n.id,
         n.agent_id,
         n.session_id,
         n.summary,
         n.subjects,
         n.feel,
         n.created_at,
         n.trigger,
         (1 - (n.embedding <=> p_query))::real as similarity,
         case when n.agent_id = p_agent then p_own_weight else p_other_weight end as weight,
         (1 - (n.embedding <=> p_query)) * case when n.agent_id = p_agent then p_own_weight else p_other_weight end as score,
         n.agent_id = p_agent as mine
  from near n
  order by score desc
  limit p_limit
$$;

commit;
