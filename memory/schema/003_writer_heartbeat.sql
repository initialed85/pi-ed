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
  /** When this table first heard of the id, which for any row written after this column existed *is* when the writer
      first arrived - heartbeat rows are created by the first stamp. Rows that existed before the column carry the
      migration time instead, and that difference is why the drift query below reports a candidate pair rather than a
      verdict. */
  first_seen_at timestamptz not null default now(),
  /** Bumped when a session opens and whenever a flush is attempted, successfully or not. */
  last_activity_at timestamptz not null default now(),
  /** Bumped only when a batch of rows actually committed. Null until this agent has written anything. */
  last_flush_at timestamptz,
  flushes integer not null default 0,
  failures integer not null default 0,
  /** Rows sitting on local disk at the last report: how deep the backlog behind a broken store has grown. */
  spool_rows integer not null default 0,
  /** When that backlog began. Only a transition from "no backlog" starts it, so a repeating failure does not reset
      the clock and a report can state how long something has been open instead of rediscovering it daily. Null when
      there is no backlog. Added after this table first shipped - see the alter below, which is what carries an
      existing store forward. */
  spool_since timestamptz,
  last_error text,
  last_error_at timestamptz
);

-- Additive and idempotent, in the same shape as everything else here: no restart, harmless on a store that already
-- has the column, and required on one that was created before it existed.
alter table writer_heartbeat add column if not exists spool_since timestamptz;
-- The same additive shape for `first_seen_at`. A not-null column with a default fills existing rows with the moment of
-- the migration, which is a fact about the migration and not about the agent; the column's comment says so, and the
-- drift query is written so that a stale row's `first_seen_at` being later than its `last_activity_at` is a sign the
-- row predates the column rather than a finding.
alter table writer_heartbeat add column if not exists first_seen_at timestamptz not null default now();

comment on table writer_heartbeat is 'watermarks from pi-ed''s memory writer - activity vs committed, per agent';

create index if not exists writer_heartbeat_activity_idx on writer_heartbeat (last_activity_at);
create index if not exists writer_heartbeat_flush_idx on writer_heartbeat (last_flush_at);

commit;
