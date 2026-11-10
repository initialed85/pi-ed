-- memory/schema/006_dream_watermarks.sql
--
-- Two watermarks where there used to be one, because the question they answer is not the same question.
--
-- `dream_seq` (001) was asked: "how far has a dream *summarized*?" and it also got used to answer "how far has a
-- dream *looked*?", which is what stopped a bounced session re-dreaming a stretch it had already declined. Those two
-- are not the same, and conflating them is how the fleet lost a thing its Earl found interesting: a peer's question
-- about himself arrived in macker's session (01a1b9ad) at 10:04, the idle dream fired at 10:15, the dream prompt told
-- the agent to decline a thin stretch, and `closeDreamTurn` moved `dream_seq` past the whole thing anyway - so the
-- rows were neither remembered nor available to the next memory, and are now outside every span.
--
-- So: `dream_seq` is what a future dream has left to summarise, and `dream_considered_seq` is what a dream has
-- already been asked about. A dream that writes advances both. A dream that declines - or is refused by an empty
-- span - advances only the second, so the asking does not loop across restarts (the runaway this cursor was
-- introduced to stop) while the stretch stays open and gets folded into the next memory that is actually written.
--
-- Idempotent, like the rest of the schema files.

alter table memory.session add column if not exists dream_considered_seq integer not null default 0;

-- A session that has already dreamed under the single-cursor regime must not re-open the gate for work that is
-- already summarized, so the new watermark starts no lower than the old one.
update memory.session set dream_considered_seq = dream_seq where dream_considered_seq < dream_seq;
