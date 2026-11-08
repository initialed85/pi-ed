-- The history of a subject index that was consolidated by hand.
--
-- The store reached 105 distinct subject labels across 23 memories: 1.0 uses per label, meaning almost every dream
-- minted a narrower phrase than the one before it. An index like that cannot be scanned, only guessed at, and
-- `memory_search`'s subject match never fired because nobody writes the same label twice.
--
-- Part of that was a parse bug (a JSON array passed as a string, split on commas, labels stored as
-- `["agent memory and recall"`), fixed in extensions/memory.ts. The rest was genuine: labels that describe overlapping
-- topics in different words. Consolidating those is a judgement call, and a judgement call recorded nowhere is a
-- mystery later. So every merge this repository performs is written here with the similarity that justified it and the
-- model that measured it.
--
-- Two things this table is for:
--
--   auditing    a row's previous array is kept in memory.memory.detail -> subjects_before, and this table says which
--               label it became and how close the call was. A weakest-similarity near the threshold is the place to
--               look first if a future search fails to find something.
--   vocabulary  the canonical side is the short list a future write path should snap new labels onto, rather than
--               letting 105 labels grow to 1050.
--
-- Fresh stores get this at first init. The live store got it from hack/resummarize-subjects.mjs, which creates the
-- same table if it is absent - the init directory only ever runs on an empty data directory.

create table if not exists memory.subject_merge (
  run_id text not null,
  label text not null,
  canonical text not null,
  similarity numeric not null,
  embed_model text not null,
  applied_at timestamptz not null default now(),
  primary key (run_id, label)
);

create index if not exists subject_merge_label_idx on memory.subject_merge (label);
create index if not exists subject_merge_canonical_idx on memory.subject_merge (canonical);
