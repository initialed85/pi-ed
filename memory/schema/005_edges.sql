-- Typed edges between the things the store already holds: memories, events, agents.
--
-- Why a graph at all: `memory.memory` and `memory.event` describe individual things well, and asking "what is this
-- memory about, which teammate said something adjacent, who was this delegate aimed at" currently means writing that
-- SQL by hand every time. A typed edge table makes the relationships queryable as data rather than as a query you
-- have to remember.
--
-- WHY THESE EIGHT KINDS AND NOT AN OPEN-ENDED SET. Every kind below was chosen against the live store (29,749 events,
-- 81 memories, 20 agents) by measuring whether the relationship is derivable from what is already written, rather
-- than by starting from what graphs usually contain. Two obvious candidates were thrown out for that reason:
--
--   tool_call -> tool_result, joined on `meta ->> 'toolCallId'`. 8,975 tool_result rows carry the id and 0 tool_call
--     rows do, so the pair is unjoinable from what is stored. It is not a small gap either: 132 tool_result rows carry
--     `redacted` but only 1 tool_call row does, which says the omission has been in the writer for a long time. An
--     edge kind nobody can populate is a constraint waiting to be loosened, so it is absent until the writer records
--     the id on both sides.
--   memory -> memory similarity edges from embeddings. `memory_search` already ranks by cosine at query time, and a
--     materialised similarity edge would freeze one afternoon's ranking into the schema. `shares_subject` is included
--     instead because it comes from the agent's own label rather than from a model's distance.
--
-- The two things that DO link up, measured before this file was written:
--
--   79 of 81 memories match a `memory_dream` tool_call whose `meta -> 'input' ->> 'summary'` equals the memory's
--     summary verbatim. A dream can be traced to the call that produced it without any new write path.
--   32,097 event memberships across 81 spans (median 50 events, max 6,604) - but only when the span is read the right
--     way, which is the defect this table also fixes. See the note on `memory_about`.

begin;

set local search_path = memory, public;

/* The edges.

   Postgres has no polymorphic foreign key, so the endpoints are six nullable columns with foreign keys each, and a
   CHECK spells out which combination each kind is allowed to use. That check is the type system: without it, `kind`
   is a label on rows whose shape is decided elsewhere, and the first bad writer makes the table untrustworthy.

   `dst_agent` is deliberately NOT a foreign key. A team-room name can arrive before that agent has ever written a
   row here - ocr naming an agent that has not dreamed yet - and rejecting the edge because the peer has not
   introduced itself loses real information and teaches nobody anything. The agent side stays a name.

   A room edge may fill BOTH `dst_agent` and `dst_event`. A delivered message has two ends worth keeping: who it was
   aimed at, and the arrival row that proves it got there. Recording only the first loses the evidence; recording only
   the second loses the relationship. The shape check allows either, and requires at least one. */
create table if not exists memory.edge (
  id bigserial primary key,
  kind text not null check (
    kind in ('memory_about', 'dreamed_from', 'shares_subject', 'room_reply', 'room_ask', 'room_delegate', 'room_update', 'wakes')
  ),
  -- Who asserted the edge. For an edge derived from a message it is the writer of that message; for one derived from
  -- a span it is the agent whose memory it is. Two agents can independently assert the same edge and the unique
  -- constraint below treats that as one fact, so this column is provenance rather than identity.
  asserted_by text not null references memory.agent (id),
  at timestamptz not null default now(),

  src_event bigint references memory.event (id) on delete cascade,
  dst_event bigint references memory.event (id) on delete cascade,
  src_memory uuid references memory.memory (id) on delete cascade,
  dst_memory uuid references memory.memory (id) on delete cascade,
  src_agent text references memory.agent (id),
  dst_agent text,

  -- Meaning is per kind: shared-subject edges carry how many labels matched, span edges carry nothing, room edges
  -- carry what the message was aimed at. Kept numeric and nullable rather than inventing a scale that only one kind
  -- can fill.
  weight numeric,
  meta jsonb not null default '{}',

  constraint edge_shape check (
    case kind
      when 'memory_about'   then src_memory is not null and dst_event is not null
      when 'dreamed_from'   then src_memory is not null and dst_event is not null
      when 'shares_subject' then src_memory is not null and dst_memory is not null
      when 'room_reply'     then src_event is not null and (dst_agent is not null or dst_event is not null)
      when 'room_ask'       then src_event is not null and (dst_agent is not null or dst_event is not null)
      when 'room_delegate'  then src_event is not null and (dst_agent is not null or dst_event is not null)
      when 'room_update'    then src_event is not null and (dst_agent is not null or dst_event is not null)
      when 'wakes'          then src_event is not null and dst_agent is not null
      else false
    end
  ),
  constraint edge_not_self check (
    src_event is null or dst_event is null or src_event <> dst_event
  ),
  constraint edge_memory_not_self check (
    src_memory is null or dst_memory is null or src_memory <> dst_memory
  ),
  -- `nulls not distinct` (Postgres 15+) is load-bearing here, not cosmetic. With the default NULL semantics a
  -- span edge and a room edge - which differ in which endpoint columns are filled - can each repeat indefinitely,
  -- because any pair of rows differs in a NULL. Re-run a backfill without this and it grows the table instead of
  -- proving it already ran.
  constraint edge_distinct unique nulls not distinct (kind, src_event, dst_event, src_memory, dst_memory, src_agent, dst_agent)
);

-- Both directions, per kind: "what does this memory touch" and "what touches this event" are both asked constantly,
-- and a two-sided index pair is what makes a graph walk cheap instead of a table scan with optimism.
create index if not exists edge_kind_src_event on memory.edge (kind, src_event);
create index if not exists edge_kind_dst_event on memory.edge (kind, dst_event);
create index if not exists edge_src_memory on memory.edge (src_memory);
create index if not exists edge_dst_memory on memory.edge (dst_memory);
create index if not exists edge_kind_at on memory.edge (kind, "at" desc);
create index if not exists edge_dst_agent on memory.edge (dst_agent) where dst_agent is not null;
create index if not exists edge_meta_gin on memory.edge using gin (meta);

/* `memory_about`, and the span defect it exists to fix.

   `span_first_event` / `span_last_event` are event IDS from a global bigserial, not per-session sequence numbers.
   Subtracting them - which is the obvious way to ask how big a span is - counts every other agent's ids that happen
   to fall in the range. Measured on the live store: the naive arithmetic reports a median of 3,719 events per span, a
   maximum of 455,119, and 2,851,945 events under spans in a store that holds 29,749 events. The correct reading - same
   session, the sequence numbers of those two events - reports a median of 50, a maximum of 6,604 and 32,097 total.
   That is not a rounding difference; the wrong version is wrong by two orders of magnitude and looked plausible.

   Membership is therefore materialised as edges rather than left as an interval to be interpreted per query, with
   dream residue excluded to match the span the memory actually claims. A memory's span is now something you can
   join, not something you have to know how to decode. */

/* The graph, in one view, with labels already resolved.

   The UI and any ad-hoc question want "who linked to whom, and what were the ends called" without joining five
   tables each time. Labels are clipped here rather than in the caller so a graph does not carry a 500-word tool
   result as a node name. */
create or replace view memory.graph_edges as
select e.id,
       e.kind,
       e."at",
       e.asserted_by,
       e.weight,
       e.meta,
       case
         when e.src_memory is not null then 'memory'
         when e.src_event is not null then 'event'
         when e.src_agent is not null then 'agent'
       end as src_type,
       coalesce(e.src_memory::text, e.src_event::text, e.src_agent) as src_id,
       case
         when e.src_memory is not null then left(sm.summary, 120)
         when e.src_event is not null then coalesce(se.tool_name, se.kind, '')
         when e.src_agent is not null then e.src_agent
       end as src_label,
       case
         when e.dst_memory is not null then 'memory'
         when e.dst_event is not null then 'event'
         when e.dst_agent is not null then 'agent'
       end as dst_type,
       coalesce(e.dst_memory::text, e.dst_event::text, e.dst_agent) as dst_id,
       case
         when e.dst_memory is not null then left(dm.summary, 120)
         when e.dst_event is not null then coalesce(de.tool_name, de.kind, '')
         when e.dst_agent is not null then e.dst_agent
       end as dst_label,
       coalesce(ma.name, da.name) as other_agent
from memory.edge e
left join memory.memory sm on sm.id = e.src_memory
left join memory.memory dm on dm.id = e.dst_memory
left join memory.event se on se.id = e.src_event
left join memory.event de on de.id = e.dst_event
left join memory.agent da on da.id = e.dst_agent
-- The agent on the other side of the fact, which for a memory edge is the memory's own author and for a room edge is
-- the agent the message was aimed at. Naming both ends makes the view readable without a second pass.
left join memory.agent ma on ma.id = coalesce(sm.agent_id, dm.agent_id);

/* What a graph walk needs next: how many edges each thing has, so a view can rank nodes instead of drawing all of
   them. Degree over both endpoint columns, per type, in one view. */
create or replace view memory.graph_degree as
with endpoints as (
  select 'memory' as node_type, src_memory::text as node_id, count(*) as out_edges
  from memory.edge where src_memory is not null group by 2
  union all
  select 'memory', dst_memory::text, count(*) from memory.edge where dst_memory is not null group by 2
  union all
  select 'event', src_event::text, count(*) from memory.edge where src_event is not null group by 2
  union all
  select 'event', dst_event::text, count(*) from memory.edge where dst_event is not null group by 2
  union all
  select 'agent', src_agent, count(*) from memory.edge where src_agent is not null group by 2
  union all
  select 'agent', dst_agent, count(*) from memory.edge where dst_agent is not null group by 2
)
select node_type, node_id, sum(out_edges) as edges
from endpoints
group by node_type, node_id;

commit;

-- Apply with:
--
--   kubectl --context home-dev -n slopyphus exec -i deploy/pi-ed-postgres -- \
--     psql -U pi_ed -d pi_ed -v ON_ERROR_STOP=1 < memory/schema/005_edges.sql
--
-- Existing rows are not linked by this file. Backfilling them is hack/backfill-edges.mjs, which derives every kind
-- from what is already stored and is safe to re-run because of `edge_distinct`.
