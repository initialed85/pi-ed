-- pi-ed agent memory: give every recorded event a natural key.
--
-- 001_init.sql keyed events on (session_id, seq) with `seq` supplied by the writer. That does not survive contact
-- with an asynchronous writer: the same entry can arrive twice - once from a debounced flush and once from a spool
-- replay after a failed write - and two arrivals of one entry must not become two rows. It also cannot survive a
-- branch change: /tree and /resume move which entries are on the path, so a client-supplied position is not stable
-- enough to be an identity.
--
-- So the key is the Pi session entry id, which is stable across every one of those, and `seq` stays as an ordering
-- column assigned inside the insert statement rather than trusted from the client.

begin;

set local search_path = memory, public;

alter table event add column if not exists source_entry_id text;

-- Safe because this migration lands while the table is empty; on a populated store the null rows would have to be
-- backfilled from the session file first, and dropping the old constraint without one would let duplicates in.
alter table event alter column source_entry_id set not null;

alter table event drop constraint if exists event_session_id_seq_key;

create unique index if not exists event_session_entry on event (session_id, source_entry_id);

commit;
