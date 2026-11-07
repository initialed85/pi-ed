-- Writer visibility: the watermark a successful flush leaves behind.
--
-- The failure this exists for is the quiet kind. A flush is one transaction, so a rejected statement rolls the whole
-- batch back, the rows go to the agent's local spool, and the store ends up looking healthy - empty tables, no error,
-- no metric. That is how the `array_concat` parse-time bug behaved for an entire session: the only cluster-visible
-- trace was `pg_stat_database.xact_rollback`, and the error text pointed somewhere else.
--
-- So the writer stamps the store on the way out. The useful signal is not "the watermark is old", because an agent
-- that is not running has an old watermark too. It is the pair:
--
--   last_activity_at   the writer was here (session opened, or a flush was attempted)
--   last_flush_at      the writer committed something
--
-- Activity without a commit for hours is a broken write path. Silence in both columns is just a fleet having dinner.
-- Written in its own implicit transaction, deliberately outside the batch's transaction: a stamp that rolls back with
-- the failure it is reporting is not evidence of anything.

begin;

create table if not exists writer_heartbeat (
  agent_id text primary key,
  repo text,
  /** Bumped when a session opens and whenever a flush is attempted, successfully or not. */
  last_activity_at timestamptz not null default now(),
  /** Bumped only when a batch of rows actually committed. Null until this agent has written anything. */
  last_flush_at timestamptz,
  flushes integer not null default 0,
  failures integer not null default 0,
  /** Rows sitting on local disk at the last report: how deep the backlog behind a broken store has grown. */
  spool_rows integer not null default 0,
  last_error text,
  last_error_at timestamptz
);

comment on table writer_heartbeat is 'watermarks from pi-ed''s memory writer - activity vs committed, per agent';

create index if not exists writer_heartbeat_activity_idx on writer_heartbeat (last_activity_at);
create index if not exists writer_heartbeat_flush_idx on writer_heartbeat (last_flush_at);

commit;
