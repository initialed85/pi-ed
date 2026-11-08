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

### How far 0.65 actually goes

The crossover falls straight out of the arithmetic: a teammate row outranks your own when its similarity exceeds
`own / 0.65`, i.e. about **1.54x closer**. A second measurement from `2026-11-08` shows the boundary from the other
side - own 0.597 (a dream row that mentions the subject) against teammate 0.851 (verbatim the subject), damped to
0.553, own still ahead by 0.044 where the threshold was 0.918. A run the same day that passed the planted row's *own*
vector as the query - a mistake in the check, since it makes that row a perfect match by construction - produced the
reverse order, 0.650 against 0.506 at a ratio of 1.98. Both regimes are real, so the rule is written down rather than
assumed: **damping is not a veto.** A teammate memory that is much nearer the question will speak over your own
memory that merely mentions the same thing, and anyone tuning 0.65 is deciding how big that gap has to be before that
is allowed. These are the numbers to argue against.

The check now asserts the mechanism rather than the ranking - every row it gets back must satisfy
`score / similarity == the weight the store applied` - and prints the order it observed. Demanding the order would
make a store check depend on which of two sentences happens to be nearer the question, which is a fact about phrasing
and not about retrieval.

### "Own rows exist and none came back" is a different failure class

The crossover answers *is this memory good enough*. The question next to it is *is this the right agent's memory at
all*, and that one is the failure where the store looks perfectly healthy while an agent is handed somebody else's
recollection - because "teammate rows came back" reads like retrieval working. home-ops named this while the crossover
was fresh, and it is now tested rather than noted.

Nothing here filters on `repo`. `memory_search` in `001_init.sql` has **no agent filter at all**: the candidate set is
the whole store, and the only thing an agent id does is set `mine`, the weight, and the label. So own rows can only
disappear three ways:

1. **candidate-window starvation** - hnsw takes `p_limit * 5` nearest neighbours before weighting is applied, so with
   `limit 1` the window is five rows wide and an own row that is merely farther cannot enter it;
2. **the `p_since` window**, which is a deliberate age cut, not a bug;
3. **identity drift**, which is the interesting one. `agentIdentity` is a config override, else the session name, else
   `host:directory` - deliberately *not* repo-scoped, so that one agent in two repositories stays one agent. That
   choice is also what makes drift possible: rename a session, move a checkout, or run on another host, and the id
   your rows were written under stops being the id that searches.

The pair that tells them apart is two counts, not a ranking:

```sql
select count(*) from memory.memory where agent_id = 'the id searching now';   -- 0 with rows elsewhere is drift
select count(*) from memory.memory where agent_id = 'the id that wrote them'; -- >0 confirms the rows are still there
```

Drift is config - silently wrong rather than visibly broken, the same drawer as a bad `search_path` or an Argo
`OutOfSync` with an empty diff list, and a note rather than a page. Starvation is a quality question about the query.

The tool now says which one it is, in the text the agent reads, rather than leaving it to be inferred from an absence:

```
note: this agent has 1 memory in the store and none of them came back for this query. Nothing matched for anyone,
      so this query found no memory at all.

note: this agent has no memories in the store under the id "pi-ed", so everything listed belongs to another id. If
      this agent expected its own history here, check which id this checkout writes as - a session name, or
      host:directory when there is no name.
```

`ownReturned` travels in the tool's `details` as well, so a check can read the fact instead of parsing prose.
`test/retrieval-scoping.test.ts` holds all three shapes against the live store with fabricated vectors - identity
drift (a perfect vector match, similarity above 0.99, returned as a 0.65-weighted teammate row while the searching id
has nothing), window starvation (own row orthogonal to the query, six nearer teammate rows, `limit 1`, own count still
1), and both notes emitted by the real tool for the right shape. The vectors are fabricated on purpose: which rows
come back and whose they are labelled does not depend on a model, and a test that needs the embedder fails for a
reason unrelated to retrieval scope.

### Naming the drift pair from the store

`writer_heartbeat` gained `first_seen_at` (`timestamptz not null default now()`, added the same idempotent way as
`spool_since`) because `repo` travels on every heartbeat row and that is enough to name a drift pair without anybody
inferring it from two complementary timelines. home-ops' hazard is in their report rather than in mine: drift arrives
as a brand-new `agent_id` while the old one stops growing, and their dedup key is (`agent_id`, severity), so a report
keyed on agent ids alone can only ever say "a new agent appeared" when the truth is "this agent moved".

`identityPairStatement()` reports the pair, with the arrival required to postdate the stall:

```sql
select a.repo,
       a.agent_id as stalled_id,
       b.agent_id as arriving_id,
       a.last_activity_at as stalled_last_activity_at,
       a.last_flush_at as stalled_last_flush_at,
       a.flushes as stalled_flushes,
       b.first_seen_at as arriving_first_seen_at,
       b.last_activity_at as arriving_last_activity_at,
       b.flushes as arriving_flushes,
       round(extract(epoch from (now() - a.last_activity_at)) / 60.0, 1) as stalled_minutes,
       round(extract(epoch from (b.first_seen_at - a.last_activity_at)) / 60.0, 1) as minutes_from_stall_to_arrival
from memory.writer_heartbeat a
join memory.writer_heartbeat b on b.repo = a.repo and b.agent_id <> a.agent_id
where a.repo is not null
  and a.last_activity_at < now() - interval '2 hours'
  and b.last_activity_at > now() - interval '2 hours'
  and b.first_seen_at > a.last_activity_at
  and a.first_seen_at <= a.last_activity_at
order by b.first_seen_at desc;
```

Measured against fabricated rows - four probe ids on one repo, and exactly one pair comes back, at `stalled_minutes
4320` and `minutes_from_stall_to_arrival 4260`. The three ids it must *not* report are in the live suite as fabricated
shapes: a **flatmate** (another agent active in the same checkout, arrived before the stalled one went quiet - two
agents sharing a repository is ordinary here, and the arrival-postdates-the-stall rule is the whole separation), an
**ancient** row whose `first_seen_at` postdates its own `last_activity_at` (it predates the column, so pairing from it
would be pairing about an `ALTER TABLE`), and ids on different repos.

It stays a **candidate** pair, and that limit is load-bearing: whether the two ids are one agent or two is membership
knowledge, not store knowledge. The fleet list - which checkouts and sessions exist - lives on home-ops' side, and an
id in the store that is not on that list is reported as retired-unknown rather than as drift. Expecting an agent to be
active is a fact about the fleet, and this query never pretends to hold it.

### Why a `0` needs its surroundings before anyone reads it

The drift timeline run against an empty store prints `(0 rows)`, which is a true reading of a store the live suite has
just cleaned out and a false reading of a sweep pointed at the wrong database - and the two are indistinguishable from
the timeline alone. `storeReadingSanityStatement()` is exported so that the surroundings live in this repository, next
to the `search_path` warning they belong to:

```sql
select current_database() as database, current_user as role,
       (select setting from pg_settings where name = 'search_path') as session_search_path,
       (select rolconfig from pg_roles where rolname = current_user) as role_config,
       exists (select 1 from information_schema.schemata where schema_name = 'memory') as memory_schema_present,
       to_regclass('memory') as unqualified_memory_resolves_to,
       to_regclass('memory.memory') as memory_schema_table,
       to_regclass('public.memory') as public_memory_table,
       to_regclass('memory.writer_heartbeat') as heartbeat_table;
```

In this store: `database pi_ed`, `role pi_ed`, `role_config {search_path=memory, public}`, `memory_schema_present t`,
`memory_schema_table memory`, `public_memory_table NULL`, `heartbeat_table writer_heartbeat`. Against the other
database in the same pod (`postgres`), the same statement answers `memory_schema_present f` with both regclass columns
NULL - so a misconfigured sweep has a shape, and it is not "empty result". The live suite runs that negative case
rather than describing it.

It deliberately contains no counts. A statement that counts `memory.memory` cannot tolerate the table being absent -
Postgres resolves relation names while parsing, before any `case` could skip the branch - so counts live in
`storeShapeCountsStatement()`, which is *allowed* to fail, and failing with `relation ... does not exist` is the good
direction: an error naming a missing relation is a reader standing in the wrong place, whereas a `0` is only a fact
about a place the reader has already proven they are in. Run the sanity row first, then the counts.

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

What "down" costs in time is now measured rather than guessed, and the numbers are home-ops' (`481085a`) on an
embeddings pod five hours old with `restarts = 0` - warm by every definition: `GET /health` answered in **0.081 s**
(0.052 s of that was DNS) while `POST /embedding` with **one short string** took **2.15 s**. Health answers about 26
times faster than the work a caller actually cares about, so a budget calibrated against a health endpoint is calibrated
against the wrong thing, and warm-and-slow is a normal reading of a healthy service. Warm trivial embedding here is
about 2 s; the cold path is minutes (home-ops finding 12); anything between those two is a statement about *load*, not
about liveness.

`embedTimeoutMs` is **30 s**, and that is a deliberate trade rather than a measurement of the service: roughly fifteen
times a warm call, and far short of a cold one. The choice follows from the writer's first rule - never block a turn on
a model - so a cold embedder is reported as a failed embed and the memory is written vectorless. Two consequences worth
naming, because neither is visible in the row:

- **nothing backfills a missing vector.** The row is findable by keywords forever and by meaning never, so a run of
  dreams written during an embedder outage remembers that period permanently at keyword quality; and
- **the number that shows it is a count, not a severity.** `vectorCoverageStatement()` is exported for exactly this:

```sql
select count(*)::int as memories,
       count(*) filter (where embedding is null)::int as without_vector,
       count(*) filter (where embedding is null and created_at > now() - interval '24 hours')::int as without_vector_24h,
       round(100.0 * count(*) filter (where embedding is null) / nullif(count(*), 0), 1) as without_vector_percent
from memory.memory;   -- optionally: where agent_id like '<pattern>'
```

`without_vector` rising while the embedder is up is a failing embedder; `without_vector` equal to `memories` means
embeddings are switched off in that checkout. The **ratio** is in the same row because a count cannot tell a small
cold store from a degrading one - 1 vectorless memory out of 3 and 1 out of 300 are different findings, and a sweep
that carries only the count cannot tell them apart - so the reported fact is a *rise* in `without_vector_percent`,
per agent id as well as fleet-wide. `nullif(count(*), 0)` is what makes that safe on an empty store: it reports "no
denominator" rather than dividing by zero, and `null` is a different fact from `0 percent`, which is what a healthy
store looks like. `test/retrieval-scoping.test.ts` asserts the ratio moves, that it agrees with the counts, and that a
pattern matching nothing yields `null` rather than an error.

This is my side of home-ops' cold-versus-gone problem, and it is
deliberately *not* a `writer_heartbeat` row: an embedder failure is not a store failure, the heartbeat table is the
store's pulse, and a reader of recall quality should read a count it can interpret rather than a new severity in a
table whose severities are frozen - see the contract at the end of the heartbeat section.

## Why every statement names its schema, and the typo that proved the point

home-ops asked which of three spellings the exported statements should use - `from writer_heartbeat`, `from memory`,
`memory.memory` - and the answer is a fourth thing: **every statement in `extensions/memory.ts` now names `memory.`
explicitly, writes included**. The inconsistency they spotted was one step short of the actual exposure.

The store's role has `search_path = memory, public` (set in `schema/001_init.sql`, a file the extension cannot see), so
unqualified names work today. They work by *inheriting a role setting*, and inheriting one fails quietly rather than
loudly: a `public` twin table, or a caller connecting as a different role, and the read - or the write - lands somewhere
plausible and wrong. Writes are the worse half of that. A reader that hits the wrong table shows up at the next sanity
check; a writer that hits the wrong table is what makes the sanity check necessary.

What each spelling does, measured against this store rather than reasoned about:

- unqualified `writer_heartbeat` in database `postgres`: errors, `relation "writer_heartbeat" does not exist`;
- qualified `memory.writer_heartbeat` in database `postgres`: errors, `relation "memory.writer_heartbeat" does not exist`;
- a `public` twin present in the *right* database: **no error in either spelling**, which is the only case the wrong
  database was ever a proxy for, and the case qualification removes outright.

The `ON CONFLICT` column-qualifier form resolves through `search_path` too - `failures = writer_heartbeat.flushes + 1`,
`array_cat(agent.repos, ...)`, `greatest(session.last_activity_at, ...)` - and is invisible to a keyword-shaped grep for
`from <table>`. The qualified forms were verified in that exact position (`begin; … ; rollback;` against the live store,
so nothing was written):

```sql
on conflict (agent_id) do update set flushes = memory.writer_heartbeat.flushes + 1, spool_rows = 0, spool_since = null
```

`storeReadingSanityStatement` is the one deliberate exception, and it is on a named exemption list in the test rather
than an accident of the pattern: its whole job is to report what an unqualified name *resolves to*, so qualifying it
would destroy the thing it measures. The rule itself is enforced by subtraction across all 19 exported statement
builders - delete every `memory.<table>` reference from the SQL and whatever table name is left over is an offender -
which also catches the column-qualifier shape that a `from`-anchored check misses (`test/memory.test.ts`).

### The typo, because it is the part worth keeping

While applying the rule, a bulk edit turned the session insert into:

```sql
insert into memory.session (id, agent_id), repo, cwd, source, started_at, last_activity_at)
```

one stray parenthesis, on the main write path of every session this store records. Three layers let it through:

- **TypeScript**, because SQL in this codebase is a string and the compiler has no opinion about strings.
- **The unit suite**, because the assertions compare SQL text to expected SQL text, and an expected string copied from
  the same source agrees with the bug instead of catching it - the failure mode written up in the statistics section,
  now with a second worked example.
- **The live suite**, which is the uncomfortable one. A failed flush is deliberately caught, spooled to disk, and
  reported on the heartbeat, because a memory system has to survive the store being unreachable. That is the right
  behaviour for the product and a poor property for a test harness: the statement was failing against a real store, the
  heartbeat row was the thing that would eventually admit it, and the suite stayed green.

Two guards close the gap, both in `test/statements-prepare.test.ts`:

1. **Parenthesis balance and parameter-count agreement, with no database involved** - the cheapest thing that would have
   caught the typo, and the only half CI can run. Re-running the test against the broken line reports `sessionStatement`
   as an offender; reverting it goes green. (Checked, not assumed.)
2. **`PREPARE` against the real store, every exported builder, nothing executed.** `PREPARE` parses the SQL, resolves
   every table and column name against the actual schema, checks the parameter numbers against the real column list,
   and writes no rows. It is also what makes schema qualification testable rather than a preference: a name that
   resolves only through `search_path` and a name that is not there at all fail the same way, in the same place.
   This sentence previously said "19 statements" and the assertion behind it said `>= 18`, which is how the file
   ended up preparing **18** while claiming 19: `heartbeatFailureStatement` needs a fourth argument and
   `eventStatement` needs a rows array, and neither shape existed, so the two most write-shaped statements in the
   extension went unvalidated on a green run. The live test now asserts the invariant instead of a floor - no
   exported builder may be absent from the prepared set - and the frozen name list below is what catches it.
3. **The name list is frozen, and its one exception is named.** `eventStatement` assembles its value tuples in a loop,
   so no *static* extraction can reach its SQL, and a sweep that only reads the source has to report it as information
   rather than as a validation. Home-ops' runner reaches it the better way, by supplying a real rows array: the SQL is
   dynamic, the statement is not untestable, and this file now does the same (`argShapes` carries a two-row case).
   All 19 names are therefore asserted exactly, and the split is 18 statically extractable plus one
   dynamic, which is the strongest signal available: a builder that leaves
   the reachable set shows up as a diff in a list somebody reviews, instead of as a count in a table of results that
   quietly dropped by one. The 19/18/1 split was measured independently by home-ops (`395bf54`) from their runner
   discovering the list from this source, and the numbers agree.

Both halves are free against the statistics window, which is worth saying before anyone declines the technique on the
assumption that it pollutes the view. Measured on both sides: a `PREPARE` that is never executed leaves **no row at
all** in `pg_stat_statements` - the probe labels were absent afterwards and `stats_reset` was unmoved. Validation that
parses, resolves and type-checks against the real schema costs nothing observable; it is `EXECUTE` that writes, and
that is the half the sweep does only against names it can clean up. When it does execute, the row is keyed by the hash
of the **inner** statement, not of the label, and the text stored is whatever was submitted first - so a row can
appear in the view wearing a prepare's label while the calls on it belong to a different shape entirely. That is the
mechanism behind `hack/pg-statement-traces.mjs` refusing to reset any row that predates the run it is auditing.

Which leaves a rule wider than SQL:

> **A statement nobody executes is a statement nobody has tested, and a system that swallows its own write failures -
> correctly, for the right reasons - will not test them either.** Resilience and testability are the same axis, and a
> suite that runs against a live store inherits the product's error handling whether it means to or not.

### One cost consequence of a rename

For anyone reading cost out of `pg_stat_statements` - home-ops, in this case - **renaming a statement does not migrate
its statistics.** Both spellings of the matview refresh are in the view right now, as a result of this change:

```text
queryid 2356047425803286870  18 calls  279.97 ms total  refresh materialized view subject_index
queryid 7120494974204833812   1 call   19.73 ms total  refresh materialized view memory.subject_index
```

Same physical work, two `queryid`s, `calls` not merged. The old row goes on sitting in the view looking like a live cost
while the statement that actually runs restarts its own counter from 1. Budget arithmetic keyed on
`query like '…%'`, or on a remembered `queryid`, has to be re-taken after a rename; the *mean* is the number that
survives the discontinuity (`15.55 ms` and `19.73 ms`, both inside the window that began `19:27:33Z`).

And the standing note about this file's SQL blocks, which home-ops already solved better than I did: **they are a
reading aid, not the authority.** The canonical text is `extensions/memory.ts`. home-ops' `hack/check-pied-statements.py`
extracts the statements from the source, resolves the window constants from the code, refuses anything with an
unresolved `${…}` left in it, and runs the result - which is the shape that cannot drift, as against a runbook that
copies prose and slowly stops describing the system it documents.

My own half of that discipline is now enforced rather than intended: `test/memory.test.ts` checks that every reader
statement quoted in this file matches what the code exports. It found one immediately. The sweep block printed here had
lost `flushes, failures, spool_rows` from its select list at some point earlier, so a reader copying this page got a
slightly different query than the one the writer actually runs - not wrong enough to fail, which is the dangerous
distance.

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

## What a store failure is called

Every failure this extension reports is prefixed with one word that names its kind - `dns:`, `refused:`, `timeout:`,
`slots:`, `auth:`, `sql:`, `error:` - and the original text follows verbatim. The tag exists because of a trap
home-ops hit while proving the sweep job: the probe connected to `-h pi-ed-postgres`, the *Deployment's* name, and
died with `could not translate host name`. That is a configuration fault, and it presents to a reader exactly like an
unreachable store - which is the one distinction the heartbeat pairing with `pg_isready` is supposed to make. So the
name matters on both sides:

- **the in-cluster Service is `memory`** (`memory.pi-ed.svc.cluster.local:5432`, ClusterIP `10.43.5.96`). The
  Deployment is `pi-ed-postgres` and that name does not resolve to anything. `kubectl exec deploy/pi-ed-postgres`
  works because it targets a pod, not a host.
- `dns:` means something is pointing at the wrong place. `refused:` means the place exists and nothing is listening.
  `slots:` means the store is up and full. `sql:` means the store answered and disagreed - the `array_concat` class
  of bug lands there. `error:` is honest about not knowing.

Classification is done on the message text, not on exception types, because Node raises string-coded errors here and
Postgres raises SQLSTATE-prefixed text there, and text is the only common ground. `classifyStoreError` and
`describeStoreError` are exported, and `test/memory.test.ts` asserts the classification against real messages -
including home-ops' trap, quoted word for word - plus the end-to-end case, where the CI DSN points at a closed port
on `127.0.0.1:1` and the tool must answer `memory_search failed: refused: connect ECONNREFUSED 127.0.0.1:1` rather
than a mystery.

## What the statistics look like from outside

`pi_ed` will look strange in `pg_stat_*` and it is worth writing down why before someone spends an evening worrying:

- **Counts that dwarf the table.** `subject_index` is a materialized view and every dream ends with `refresh
  materialized view memory.subject_index`, which is a truncate plus a bulk insert. Postgres reports those as large
  `n_tup_ins` numbers, and the rows it removed are invisible: `0` live and `0` dead next to a few hundred inserts is
  this view behaving normally, not rows being lost.
- **Deletes with no rows left.** The live check writes under the agent name `memory-live-check` and deletes everything
  it wrote at the end of a run, on the failure path as well as the success path. That is where `n_tup_del` comes from
  while the tables sit near empty.
- **Rollbacks.** Every flush is a transaction, so a rejected statement is a rollback - the `22` rolled back against
  `2807` commits was the live check's own failing statements, not a write path silently breaking. When that did happen
  for real (the `array_concat` bug above), the symptom was visible: every row went to the spool and the check said so.
- **`n_live_tup` is an estimate, not a count.** Measured on this store: `pg_stat_user_tables` reported
  `memory | 24 ins | 23 upd | 1 del | 24 live` in the same minute that `select count(*) from memory.memory` returned
  `0`. The visibility map had not been brought up to date after the prune. Quoting that number as residue would have
  reported rows that do not exist. The honest external read is `relkind` plus `count(*)`, with `pg_stat_database`'s
  `xact_rollback` as the database-wide signal.
- **Read `relkind` before believing anything about a "table".** Join `pg_stat_user_tables` to `pg_class` and look:
  `m` is a materialized view, `r` is a table. home-ops read `subject_index` as a table with vanished rows, and every
  real `r` table here has deletes nearly equal to inserts (`agent 14/13`, `event 264/264`, `session 23/22`), which is
  the probe writing and then cleaning up. Their side of this is `MAINTENANCE.md` (home-ops `7ce76ac`), with the
  `relkind` query tested against this live store rather than written from memory.

- **Cumulative counters.** `pg_stat_database` counts since the statistics were last reset, not since the last vacuum:
  `3068` inserts and `1054` deletes against a store holding a handful of rows is a testing history, not a leak.

If a future incident needs real statement-level visibility, ask for `pg_stat_statements` in the Deployment's
`shared_preload_libraries` plus `log_min_duration_statement = 250ms`. It costs a Postgres restart, and a restart is
safe by design: the writer spools to disk while the store is unreachable and replays on the next flush. A clean
restart also preserves the statistics window - clean and crash stops both, on an `emptyDir` and on a Longhorn volume -
so the cost is downtime rather than lost history. What a crash *may* damage is the view's contents, observed once and
not reproduced on a volume-backed run. See the cost section below.

## Writer visibility: the heartbeat table

### What things actually cost here

Measured from `pg_stat_statements` (on since home-ops `9325af4`, `track = all`) after a full live-check run:

| statement | calls | mean | max |
| --- | --- | --- | --- |
| `insert into event (…)` | 53 | 0.28 ms | 7.69 ms |
| `refresh materialized view subject_index` | 6 | 16.01 ms | 21.72 ms |
| `select * from memory_search($1, $2::vector, …)` | 5 | 4.34 ms | 17.11 ms |
| `insert into writer_heartbeat (…)` | 6 | 0.29 ms | 0.54 ms |

Read those numbers the way the view produces them, or a future comparison invents a regression. `pg_stat_statements`
is **cumulative since its `stats_reset`**, so `calls` is a running total, not a measurement of anything that happened
today: home-ops read this same view earlier in the same evening as my run above and got `4 calls, 14.78 ms mean,
17.77 ms max` for the matview refresh where I read `6 calls, 16.01 ms mean, 21.72 ms max`, and their next reading was
`6 calls, 96.08 ms total, 16.01 ms mean` - which is not a second measurement of my number, it *is* my number, the
same accumulated state seen later. **Compare means and maxima across time; never compare `calls`.** A third reading of
the same refresh, an hour and a half on and 18 calls deep, came back `15.55 ms mean, 22.70 ms max`: the mean held, the
call count grew because other agents were working.

### The window has a start time, and exactly one known thing moves it

`select stats_reset from pg_stat_statements_info` in this store reads **`2026-11-07 19:27:33.116+00`**, and it has
read that since the extension existed. What that timestamp marks is the first load of `pg_stat_statements`: the pod
that was recreated to preload it has `status.startTime = 19:27:17Z`, the manifest's `postStart` hook runs
`CREATE EXTENSION IF NOT EXISTS pg_stat_statements` a few seconds later, and the view's own rows include that
statement at 143.89 ms. A first-load stamp, not a restart stamp.

| what happened | effect on `stats_reset` | how it is known |
| --- | --- | --- |
| first load of the extension | starts the window | this store: stamp 19:27:33.116Z, 16 s after `status.startTime` 19:27:17Z, with the `CREATE EXTENSION` in the view |
| clean stop and a genuinely new postmaster | **unchanged**, counters keep accumulating | home-ops `b3e16d7`, throwaway Postgres 16 in dev: postmaster `20:34:56` to `20:35:28` with `stats_reset` fixed at `20:34:56.355296` and probe `calls` continuing rather than restarting at 1. `pg_stat_statements.save = on` there, and `show pg_stat_statements.save` reads `on` in this store too |
| crash stop - `pg_ctl -m immediate`, restart showing `redo starts at 0/19AC538` | **unchanged**, counters keep accumulating | home-ops `5a26b08` on an `emptyDir` (`stats_reset` held at `21:21:15.410482+00` across *two* crash stops while `pg_postmaster_start_time` moved `21:21:15 → 21:23:44 → 21:27:44 → 21:31:12 → 21:34:38`), then home-ops `83ab606` variant A on a **Longhorn PVC**, where a crashed restart with `redo starts at 0/19AC488` left the stamp *and* a marker's `5 calls / 0.035 ms` identical. The anchor survives a crash, not just a clean stop, and it survives the volume this store actually uses |

The middle row is a correction of this file, and it is worth keeping in the history rather than quietly editing out.
An earlier version of this section said a restart resets the view on its own, "sixteen seconds after the container
started", and read that as the manifest doing it silently. That was home-ops' inference plus my coincidence - the
rollout *was* the extension's first load, so the two explanations were indistinguishable in that store and both
narratives fit. home-ops measured it on a scratch database instead of arguing about it, and the claim was wrong.
Their sweep design got better at the same time: since a clean restart cannot move the stamp, a stamp that moves has
one known cause, someone calling `pg_stat_statements_reset()` in a database another reader is measuring. A movement
with nobody saying so *is* the finding, with no restart noise to argue past.

The third row was this file's open gap, and home-ops measured it rather than waiting for an incident to do it. The
result does not just fill the gap, it invalidates a rule this file was about to recommend. An earlier draft of the
norm here said "assume a reset at every start, unless someone says otherwise", which the clean-stop measurement had
already made too cautious; the crash measurement kills it outright, **in the direction that matters most**: a window
that is quietly still accumulating gets under-read, so a reader discounts history that is actually there and treats a
long-running store as if it had just been restarted. The rule that survives is narrower and stronger: **a stamp that
moves has one known cause, someone calling `pg_stat_statements_reset()`; a stamp that has not moved is not evidence
of anything about how the postmaster stopped.**

What a crash *does* cost is the other half of the view, and home-ops reported it as observations rather than a
mechanism, which is the right way to write it down:

- a marker statement run just before an explicit `checkpoint`, and another just after it, were both absent from the
  view after a crash, while a row created before an earlier *clean* restart survived;
- in a second crash run, a statement executed immediately after recovery never appeared in the view at all;
- and a surviving row reported **2 calls for a statement that had been executed once**.

Those three were on an `emptyDir`, and home-ops' later `pg_ctl -m immediate` crash on a **volume-backed** Postgres
came back the other way: the marker row survived with `5 calls / 0.035 ms` identical before and after, stamp unmoved.
So contents damage after a crash is **observed but not reliable**, and it is worth stating it that way rather than as
a rule - the operational conclusion does not change (a `calls` figure from a post-crash window is not safe for
arithmetic, and absence of a row is not proof a statement did not run) but the *prediction* is weaker than the first
probe made it look.

Weaker, and pointed in a different direction: home-ops re-ran the crash with markers chosen by **structure** rather
than by alias (home-ops `12fa5e9`) - `select 901 as m_alpha` and friends replaced, the marker rows untouchable by
whatever merges around them - and the crash then took nothing. Same store, `stats_reset 22:25:57.124131+00`, marker
`calls` 2 and 2; `pg_ctl -m immediate` with `database system was not properly shut down; automatic recovery in
progress`, `redo starts at 0/196B018`, exit 137; afterwards a new postmaster at `22:28:14.558`, both marker texts
intact, calls still 2 and 2, and the next execution continued them to 3. Nothing lost, nothing doubled. Which means
the three bullets above - absent markers, and especially "2 calls for a statement that ran once" - were most likely
**the merging described in the next section**, not crash damage: statements whose counters had been folded into
another statement's row look missing when you search by text, and look doubled when you count them by alias.

So a sweep can read an intact, long window over a **partly missing** view: `stats_reset` says "107.9 minutes of
history" while some statements in it are absent and another's `calls` is inflated. Two consequences for anyone reading
this view after a crash:

- absence of a statement after a crash is not evidence the statement did not run, so a "who is hammering this
  database" question cannot be answered by the view alone in that window; and
- `calls` after a crash is not safe for arithmetic (doubling a count in a cumulative counter is exactly the kind of
  number a threshold argument gets built on), while a *mean* over recurring statements degrades far more gracefully.

### The view merges statements, and a row's text is not a record of what it counted

The most load-bearing property of `pg_stat_statements` is not a crash behaviour at all. Constants are normalised to
`$1`, `$2`…, and the identity of a row is a **jumble hash of the parse tree**, which does not include column aliases.
So these are not three statements:

```sql
select 7001 as stat_probe_alpha;
select 7002 as stat_probe_beta;
select 7003 as stat_probe_gamma;
```

One row, one counter, and its text is whichever variant happened to arrive first. Measured here, in the
Longhorn-backed store, by `test/statistics-view.test.ts`: three aliases, one row, `calls >= 3`, and the two aliases
that never appear in the view ran exactly as many times as the one that does. home-ops reached the same row from the
other side with nine probes - three `m_*`, three `sentinel_*`, three `uniq_*` - held by one row reading `calls` 3,
then 6, then 9 as each batch landed (home-ops `12fa5e9`).

The part that makes it a trap rather than a curiosity: **both sides computed the same `queryid`,
`6865378226349601843`**, for `select $1 as m_alpha` in their scratch store and `select $1 as probe_alpha`,
`select $1 as reset_order_probe`, `select $1 as seq_probe_alpha` in mine. The alias is not part of the identity, so
*any* `select <constant> as <anything>` in a shared store lands on one row, whatever it is named, and my earlier
"two of four marker statements vanished" note was this merge rather than anything being lost.

Structure does separate them - and only structure. What has been measured separating: a bare constant select versus a
select with a `from` and a `where`. What has been measured **not** separating: a more creative alias, a different
literal, and - the half that reads like advice until you run it - **a table clause on a relation other readers also
query**. `select count(*) as sweep_probe_shape from pg_stat_activity` and `select count(*) as
shape_from_clause_a from pg_stat_activity` landed on one row in two separate scratch stores, and three probes named
`readme_demo_alpha`, `readme_demo_beta`, `readme_demo_gamma` against one shared relation landed on one row with three
calls. Literals merge, aliases merge, shared relations merge.

The mirror of that sentence is what broke a baseline in *another* repository, and it is the reason the shared
instrument reports a statement's siblings. The **expressions** of the target list are inside the hash even though
their aliases are not: measured on this store against a temp relation, `select a, b` and `select a, b, cc` are two
rows with two counters, and `select a as zzz, b` adds its call to the first of them. So pi-ed `79b0202` - adding one
column, `never_attempted`, to the heartbeat sweep's select list - re-baselined that statement's cost with nothing in
the reading repository's diff to warn about it. home-ops found five rows of the sweep with identical first 70
characters, 78 calls on the pre-change text and 7 on the new one, and the trap is that summing the siblings is not a
statement count either: a generation also absorbs calls from other variants of its own shape. A baseline read off
this view is **per-generation, not per-statement**, and the only place that notices a re-baseline is the sweep
reading the view. `assert` therefore reports a sibling group for every `--statement` the run passes, matched by
relation clause (which catches a target-list change) or by the leading 40 characters of the text (which catches a
`where`-clause change, which the clause key cannot). Neither key is a verdict, and the report says which one fired.

Both keys were kept after one live run showed each of them lying in the opposite direction. The heartbeat sweep is
`select * from ( ... ) x`, so its relation clause contains the whole subquery and every generation of it differs
there: the report found five rows for the sweep by leading text and **none** by clause. The coverage statement, a
flat select, found six rows by clause - two of which are genuinely different statements that read `memory.memory`
and are not its generations at all. The clause key is a flat-statement heuristic, and the group is a signal.

The same run showed why a name scope is not attribution: `assert --name pi_ed_` reported a leftover that was not
mine, a home-ops statement whose second alias is `pi_ed_rows_after`, because `pi_ed` is the name of the database and
a peer will reasonably use it as an identifier. `remove` refused the row - it predates the run - which is the only
thing standing between a marker like that and a reset of someone else's counter. A marker has to be a name no other
writer would choose, which is why the run above re-asserted with `pi_ed_prepare_probe`, `stat_probe_`, `merge_probe_`
and the rest of its own relation names, and reported zero leftovers.

One more way to make an absence check lie, and it is the one home-ops hit: interpolate the run's name into the SQL
that looks for it, and the checking statement's own stored text carries the name, so it can never report zero about
itself. Binding the pattern as a parameter (`where query like $1`) makes the checker's text `... where query like $1`
with no name in it, and `position($1 in query) > 0` versus `like $1` is then irrelevant - the trap is the
interpolation, not the operator.

Prepared statements are the sharpest version of this, and the one that makes a name-scoped cleanup quietly wrong.
Measured on this store, against a relation only the run queries:

- `prepare X as Q` that is never executed is **not tracked at all** - which is why the validation sweep in
  `test/statements-prepare.test.ts` is free against a shared view.
- Once `Q` is executed, the row is keyed by the hash of **`Q`**, not of the `prepare` text, and the text stored on it
  is whatever was submitted first - the whole `prepare X as Q` string. So the label is outside the hash, the alias is
  outside the hash, and the name a name-scope can see is only the first thing that ever ran the shape.
- Executing the same `Q` directly, or under a second label, or under a third alias, adds calls to that one row. The
  row home-ops watched accumulating - `prepare pi_ed_prepare_probe_13_vectorCoverageStatement as select count(*)::int
  ...` - was that: a row keyed by an inner SELECT, wearing a label as its first-seen text. The current sweep never
  executes, so it creates no such row; the calls came from experiments that did.

The consequence for cleanup is the whole point: a name scope can only remove a row the run *created*, and what
creates a row is the relation in the hash, never the name in the text. `hack/pg-statement-traces.mjs` is the shared
instrument for that - `snapshot` before, `assert` after (read-only: named leftovers, a moved `stats_reset`, a landing
delta that grades a row whose calls grew without naming the run as "likely a merged landing", and the sibling groups
that say when one statement is several rows), and `remove`,
which will only reset a row whose `queryid` is absent from the before-snapshot. Resetting a row that predates the run
is not cleanup; it is somebody else's lost baseline.

Three rules follow, and the first two are rewrites of crash-scoped caveats into ordinary-operation ones:

- **`calls` is unsafe for arithmetic in ordinary operation**, not only after a crash. Two agents using the same
  constant-select shape share a counter, and neither sees it.
- **Absence from the view is weak evidence in both directions, always** - a statement that ran may be folded into a
  row whose text names a different statement, and a row can also *leave*. Capacity eviction at
  `pg_stat_statements.max` (a setting, not a column of the view: `select max from pg_stat_statements` fails with
  `errorMissingColumn`, which is why this file used to say "the view evicts" without checking) is real but does not
  fit these numbers: 334 rows against a ceiling of 5000, and home-ops watched rows vanish with no crash and no full
  reset. The cause that fits is much closer to home - **a scoped reset**, because a targeted
  `pg_stat_statements_reset(userid, dbid, queryid)` removes exactly one row and leaves `stats_reset` untouched, which
  is the whole design of the cleanup helper above. Both agents in this fleet run such a cleanup, so a vanishing row
  is most likely a peer, not capacity. `test/statistics-view.test.ts` performs the removal deliberately and asserts
  the pair: the row is gone, `stats_reset` is byte-identical, and the view is nowhere near full.
- **A scoped reset can erase more than one row, and `stats_reset` will not show it.** The function is declared
  `userid oid DEFAULT 0, dbid oid DEFAULT 0, queryid bigint DEFAULT 0`, and **0 means all**. home-ops measured it on
  a scratch database in this very store: `reset(0, 17680, 0)` took that database from 31 tracked rows to 1 (its own
  reset row) while `pi_ed`'s 323 rows were untouched and `stats_reset` came back byte-identical. So the window is not
  proof of a quiet store - it only rules out the *full* reset. The corollary is that this store's stamp equals
  `pg_postmaster_start_time` (`2026-11-07 19:27:33`, one restart, `restartCount 0`), which tells you nobody has
  reset everything since the extension loaded and nothing whatsoever about scoped resets. `hack/pg-statement-traces.mjs`
  now validates all three ids before sending them and refuses any zero, because the value can only arrive from a
  snapshot file that was edited or truncated - and it counts the rows that are *gone from the view* afterwards rather
  than the calls that returned success, because the function is `STRICT` (`proisstrict = true`): a NULL argument
  makes it do nothing and still report success. The reset calls themselves are visible - 15 rows carrying 378 calls
  whose text contains `pg_stat_statements_reset(` - but the scope of each is a parameter, so the count proves resets
  happened and never says what they removed.
- **A row's text is a label, not a record.** Attribute by `queryid`. A probe earns its own counter by being
  structurally distinctive - a different relation, a join, a filter that references a column rather than a constant -
  not by a more creative alias, a more unusual literal, or a `from` clause everybody else already uses. In a shared
  store the practical fence is **a relation only you query**: a temp table named for the run, which is what
  `test/statistics-view.test.ts` now uses, and the reason is cleanup as much as attribution - see the bucket note
  below.
**A `count(*)` with no `from` is not a count of anything.** It is valid SQL and answers over the implicit one-row
relation, so `select count(*) || '@@' || (select ...)` reports `1` and reads like an emptied store when the number is
a fact about the expression, not the data. home-ops shipped that shape in a cost tool as a **hard gate** on the same
commit that added the feature it was measuring, and it printed `1` for two consecutive runs. The fix is a scalar
sub-select over the real relation, and the rule generalises past counts: **any number that cannot be `0` is not
measuring what it claims.** `hack/pg-cost-snapshot.mjs` was grepped on the strength of the finding and has no such
query - the only `select` in this repo without a `from` is the reset call itself, which is a function and should be one.

**A filter that matches the word "probe" is measuring its own vocabulary, not the litter.** Measured on this store:
the view holds 13 rows whose text contains `probe`, and **0** of them are leaked probes - every marker this repo has
ever used (`stat_probe_`, `probe_sibling`, `merge_probe_`, `readme_demo`, `remove_dogfood`, and home-ops' `zz_homeops`)
returns zero rows on a `position(...)` check. The thirteen are verification queries that *count* probes, and the
largest of them by a wide margin is the counter itself: `select count(*) as probe_rows_before from
pg_stat_statements where query like $1`, 17 calls. `hack/memory-live-check.mjs` plants the word as a *data value* too
(`'probe'` as a session source, `{"probe": true}` in notes), so its statements match any word filter forever. This is
the third face of the same self-reference: the pure `select count(*) from pg_stat_statements` is constant because the
row adds both the call and the count; the `like '%name%'` absence check can never report zero about itself; and a word
filter counts the queries that talk about filtering. Count by marker, and treat a word count as a claim about the
language of whoever ran the last check.

`hack/pg-cost-snapshot.mjs` prints `queryid` on every line and marks the merge-prone shapes. The demo below was run
through it, on the shape this file now recommends, and every row it created was removed afterwards:

```text
before: 243 tracked statements, window 270.2 min since stats_reset

  0.01 ms total | 0.01 ms per call | 3 call(s) | 1 row(s) | queryid -908891960061494335 | select $1 as readme_demo_alpha from readme_demo_bucket_1794095894426  [merge-prone: alias and literals are not in the hash, so anything structurally identical shares this counter]
  0.01 ms total | 0.01 ms per call | 1 call(s) | 1 row(s) | queryid 4515918211241393326 | select count(*) as readme_demo_count from readme_demo_bucket_1794095894426  [merge-prone: alias and literals are not in the hash, so anything structurally identical shares this counter]
  0.00 ms total | 0.00 ms per call | 2 call(s) | 0 row(s) | queryid -3295388679701045428 | select $1 as readme_demo_shape_unused from readme_demo_bucket_1794095894426 where $2  [merge-prone: alias and literals are not in the hash, so anything structurally identical shares this counter]
```

Read the first line with the trap in mind: three statements were executed - `readme_demo_alpha`, `readme_demo_beta`,
`readme_demo_gamma` - all three against one relation, and **the relation did not separate them**. One row, three calls,
text naming only the variant that arrived first. That is why the earlier version of this example used a bare
`select 7401 as readme_demo_alpha` and why home-ops was right to object to it: a worked example that demonstrates the
trap while reading like the recommendation is worse than no example. The fixed version demonstrates the trap *and* the
fence in the same run - the third line is a different structure (a filter clause) and it got its own row.

Note what the demo's two runs also show. The same statement text against two run-unique temp tables produced two
different `queryid`s (`-908891960061494335` here, `-5413042537995390208` in the run before it), because the resolved
relation is inside the hash. Cross-store comparison by `queryid` is sound for statements whose relations agree
structurally, and unsound for anything reading a table whose column list differs - which is the `select *` split below
seen from the other end.

and warns when the view shrank between its two snapshots without anyone resetting it, because a missing "before" row
makes that run's delta a lower bound rather than a measurement. The same script now also flags the *other* direction of
label trouble, described below.

### Identical text, two rows: what a `select *` does to its own history

Three rows in this store's view with byte-identical text - same `md5`, same length, same everything a reader would
compare:

```text
queryid -2433359789966523996   48 calls   md5 8d1104499e66b7024017aa51fcc2f4f4   select * from writer_heartbeat where agent_id = $1
queryid   617268224990037792   36 calls   md5 8d1104499e66b7024017aa51fcc2f4f4   select * from writer_heartbeat where agent_id = $1
queryid  6140839715704859818   24 calls   md5 8d1104499e66b7024017aa51fcc2f4f4   select * from writer_heartbeat where agent_id = $1
```

The obvious explanations fail. All three are the same `userid` (`pi_ed`), the same `dbid` (`pi_ed`) and the same
`toplevel`, so the view's `(userid, dbid, queryid, toplevel)` key does not separate them, and they are not merged rows
of different texts - the texts are identical.

A temp-table experiment settles it (`test/statistics-view.test.ts`, run against the live store with the probe rows
removed again afterwards by targeted reset, `stats_reset` unmoved):

- `select * from <probe> where agent_id = 'split-probe'`, run once, then **after `alter table … add column`**, run
  again: **two rows, one text** (`md5` matches), each with its own `calls`.
- `select agent_id from <probe> where agent_id = 'split-probe'`, run before and after the same `alter`: **one row, two
  calls**.

The mechanism is that `queryid` is computed from the *analysed* tree, and `select *` has been expanded into concrete
columns by then. Adding a column to the table changes the structure the hash sees, so the same SQL text earns a new
`queryid` and its counter starts again from 1. Nothing in the statement changed; the table did.

Three consequences, in the order they bite:

1. **A statement that runs all day should name its columns.** The rows above are not from a scheduled reader - they
   came from a test's `select *`, which is throwaway and costs nothing but view clutter. The extension's own heartbeat
   reader (`heartbeatReadStatement`) already names its columns, and home-ops' sweep statements do too, which is why
   neither is exposed to this. The exposure is any monitoring statement written for convenience.
2. **A schema change silently re-baselines the history of every `select *` statement that touches the table.** If a
   budget is keyed on `calls`, the honest move is to sum the generations and say so, or to keep the mean and drop the
   counts - `15.55 ms` and `16.76 ms` mean for the two matview spellings agree while their call counts (18 and 2) do
   not describe the same world.
3. `hack/pg-cost-snapshot.mjs` now labels `select *` lines **split-prone** - "a column added to the table, or a rename,
   gives this identical text a new queryid and a counter starting at 1" - next to the existing **merge-prone** label.
4. **A change to the select list splits the same way, and the split is invisible in the reader's own diff.** pi-ed
   `79b0202` added one column, `never_attempted`, to the heartbeat sweep, and that statement's cost went from one row
   to five: 78 calls on the pre-change text, the new generation starting at 1. The expressions are in the hash and
   only their aliases are not, which makes bullet 2 and this bullet one sentence. `assert --statement` reports the
   siblings of any statement a run names, and the rule for a probe that can fail is that its cleanup goes in a
   `finally` - a failed assertion skips every line after it, and six rows in this store were the result of a probe
   whose cleanup was the last line of its test. Verified by breaking an assertion on purpose: the run fails, the view
   holds nothing.

This is the rename split above seen from the other side, and the two together give the rule: **what holds a counter
together is the analysed structure, not the text you wrote.** Text is how a reader identifies a statement; `queryid` is
how the view identifies it, and those two are not the same thing.

**Cleaning a probe up is its own contract.** `pg_stat_statements` is a view over shared memory and is not deletable
in this build (`cannot delete from view "pg_stat_statements"`), so the only surgical route is
`pg_stat_statements_reset` with its three-argument form - and this build declares the arguments as **(`userid`,
`dbid`, `queryid`)**, read from `pg_proc.proargnames` rather than assumed from a manual page. Passing the first two
the other way round is a **silent no-op**: no error, `stats_reset` unmoved, counters unchanged, nothing in the
response saying the cleanup did not happen. In the declared order it removes the row outright - not merely zeroes it
- and leaves `stats_reset` and the window's length untouched, which is what makes it safe: a probe can be removed
without disturbing the window another reader is measuring against. Both halves are asserted live, including the
no-op, and the live file refuses to finish unless the stamp it started with is the stamp it ends with.

**Surgical about the window, blunt about the bucket.** One targeted call clears *every* variant that merged into that
`queryid`, and there is no way to remove one variant alone - home-ops measured it as three statements' counts vanishing
from a single call. In a shared store that turns cleanup into a scope question: a reset aimed at your probe's row also
takes whoever else happened to write the same shape, and nobody can reconstruct their counts afterwards. Two rules
follow, and both are structural rather than careful. (1) **Probe a relation only you query**, so a merged bucket is
yours by construction - `test/statistics-view.test.ts` creates a temp table named for the run and cleans every
statement carrying that name, its own `create`/`alter`/`drop` included. (2) **Name-scope the marker you reset on**, so a
reset can only ever reach statements the resetting reader invented. `stat_probe` belongs to this repository's suite,
home-ops' markers are `sweep_probe`, and neither reads the other's counters - which is the difference between cleanup
and "cleanup, plus whatever else was standing in the same shape".

**`queryid` is bigint, and text is the only form of it that survives being read.** The ids in this store are around
1e19, and 2^53 - the largest integer a JS number represents exactly - is 9.007e15. Measured on a probe run here: all
five ids it produced fail `String(Number(id)) === id`, so rounding is not an edge case here, it is the default fate of
any id that passes through a number. The driver is the safe half (node-postgres returns `bigint` as a string); the
danger is what a reader does next - `Number(id)` in a driver, or an id pasted into source as a numeric literal. The
consequences, measured by home-ops on this store (`0baf3ec`): `-6049891011141795458` became `-6049891011141796000`,
`pg_stat_statements_reset(0, dbid, <rounded>)` removed nothing, and the follow-up `where queryid = <rounded>` found no
row **for an id that never existed**, so every "assert absent" line printed `absent` while the probe rows sat there at
1 and 2 calls. A cleanup aimed at a corrupted identity passes its own absence check. So: read `queryid::text` out of
the view, hand it back as a string parameter (cast `$n::bigint` where the position needs a type), and assert absence by
**name scope** (`where query like '%<run-name>%'` → 0 rows) rather than by the id you meant. This repository encodes it
as a live test that performs the rounding on purpose and asserts that the row survives, that the corrupted-id lookup
finds nothing, and that the name-scoped lookup is the one that reports the truth.

**A probe's name scope must cover the relation it created, not only the aliases it used.** The cleanup pass on one of
the demo runs above removed the six alias-named rows it was looking for and left six more in the view - `create temp
table readme_fence_…`, `insert into readme_fence_…`, `drop table readme_fence_…` - because they carry the relation
name, not the alias. Name the relation, and clean by that name.

**Name scope works on identifiers, not on values.** The view normalises constants, and this was measured the hard way on
a demo run: `insert into memory.writer_heartbeat (agent_id, repo, last_activity_at) values ('heartbeat-probe-demo',
'pi-ed', now() - interval '5 days')` is stored as `values ($1, $2, now() - interval $3)`, and
`where query like '%heartbeat-probe-demo%'` returns nothing - the cleanup reported "0 rows removed, 0 leftovers" for a
run that had definitely written to the store. A run whose name appears only in a *value* therefore has no name-scoped
trace, and the counter it lands on is the shared one for that shape, which is not its to reset. Relation names, aliases
and prepared-statement labels are *identifiers*, and they survive in the stored text - which is why the fence recipe
and the cleanup recipe both work off them rather than off data. One live statement asserts both halves of the
distinction: a unique alias and a unique literal in the same `select`, and only the alias is findable afterwards.

**A statement that merged is not yours to remove, and cleanup should say so out loud.** "Clean every statement you
ran" has a limit the view imposes. Measured here: `prepare pi_ed_trace_probe_<run> as select count(*)::int as
trace_alpha from memory.memory` plus two executes created **no row**, and instead added 2 calls to the row already
stored as `select count(*)::int as n from memory.memory` - the label and the alias are outside the hash, so the run was
attributed to somebody else's counter and left nothing name-scoped behind. In a shared store, resetting that row is not
cleanup, it is deleting another writer's history along with yours. So `test/statements-cleanup.ts` removes the rows the
view is willing to label with the run's name, reports the count, and asserts a second sweep finds nothing - and it says
nothing about the merged remainder, because the honest claim is "nothing labelled with my name survives", not "the view
is as I left it". The way to keep the two kinds small is the fence recipe above: probe a private relation with a novel
aggregate argument, and almost everything the run does stays attributable to it.

**A display width is a fence that hides fences.** This script used to print `left(query, 70)`, and that hid the very
clause doing the fencing: `select count(*) as fence_probe_alpha from homeops_fence_probe_20261108` and the same
statement with `where agent_id = $1` printed identically while carrying different `queryid`s. A reader comparing the
printed texts would have concluded the view was inconsistent. Filters had always read the untruncated text; the print
now matches it, and truncation is opt-in (`--max-text N`), with a capped line saying it is capped.

The same rule has a JavaScript edge that was hit while cleaning up after these measurements. `console.log(a, b, c)`
treats `a` as a *format string*: printing the pattern `%stat_probe%` alongside another argument substituted `->` for its
`%s`, and `%fence_demo%` printed as `NaNence_demo%`, because `%f` with no argument is `NaN`. The printed text disagreed
with the text the query had filtered on, and one of the arguments was silently consumed - the exact defect this section
is about, arriving from the logging call rather than from the database. With a single argument `console.log` prints
verbatim (verified), and `process.stdout.write` never interprets. Any string that came from a query belongs in an
argument, never in the format position.

**`create temp table … on commit drop` under an autocommitting client drops the table inside the transaction that
created it** (home-ops' first probe died with `relation … does not exist`). This repository's probes create plain temp
tables and drop them explicitly at the end of the run, which is also what makes the DDL rows above visible to cleanup.

**Rank by mean over recurring statements** is therefore not a style preference, and home-ops' live counter-example is
the cleanest demonstration of why: ordering this store's view by `total_exec_time` puts `CREATE EXTENSION` at
143.89 ms on **one call** on top, with the extension script's internals behind it at 10.05 ms mean / 32.25 ms max -
which is precisely how a threshold gets argued down from the wrong row. The number the `log_min_duration_statement =
250ms` tripwire is argued from is the recurring one: `refresh materialized view subject_index`, currently 18 calls at
**15.55 ms mean / 22.70 ms max**.

The gap that followed - `emptyDir` is not how this store is attached - was closed by the same teammate, on a
**PVC-backed** scratch Postgres: 1 Gi Longhorn RWO, `postgres:16.15`, `shared_preload_libraries=pg_stat_statements`,
`track=all`, `save=on`, in `default`, 21:52-22:12Z, everything deleted afterwards (home-ops `83ab606`, finding 17).
Baseline `stats_reset 21:52:32.817365+00`, `pg_postmaster_start_time 21:52:33.318554+00`, marker `select $1 as
probe_alpha`.

| variant | before | after | what it proves |
| --- | --- | --- | --- |
| **A** unclean stop, same volume, container boundary (`pg_ctl -m immediate`, log shows `database system was not properly shut down; automatic recovery in progress`, `redo starts at 0/19AC488`, `restartCount=1`, new postmaster `21:58:27.543761+00`) | `5 calls / 0.035 ms` | `5 calls / 0.035 ms / 0.0071 ms mean`, stamp **identical** | an unclean stop preserves the window *and* the counters on a Longhorn volume |
| **B** graceful `kubectl delete pod`, replacement on the **same node**, log `database system was shut down at 21:59:35 UTC` | `6 calls / 0.041 ms` | `6 calls / 0.041 ms`, stamp unmoved | the most likely thing to happen to this store keeps its window |
| **C** `kubectl delete pod --grace-period=0 --force` while running | `8 calls / 0.050 ms` | `8 calls / 0.050 ms`, stamp unmoved, rows 34 → 35 - but the replacement's first log line was `database system was shut down at 22:00:27 UTC` | **`--force` is a scheduling model, not a node-loss model**: the node still shut Postgres down cleanly three seconds before the new pod started. Anyone building an incident drill on `--force` is drilling the wrong thing |
| **C′** crash with no shutdown, then a pod boundary that lands on a **different node** | - | **never measured, because the pod never started** | the statistics question is still open, and what blocked it is the interesting result |

**The cost clause therefore needs no unclean caveat.** A rollout, a crash, or a pod boundary on this store does not
end the statistics window, and a window that has not moved in days is ordinary rather than suspicious.

**What is actually reachable, and it is not a Postgres problem.** C′ was blocked by Longhorn: `FailedAttachVolume …
Multi-Attach error … Volume is already exclusively attached to one node`, then `SuccessfulAttachVolume`, then
`MountVolume.MountDevice failed … mount failed: exit status 32` **eleven times over 7m6s**. Longhorn's own plugin gave
the words kubelet hides - `/dev/longhorn/pvc-… is in use.` and `… already mounted or mount point busy.` - while its
`volumeattachments.longhorn.io` object held exactly one ticket, `Satisfied`, for the *new* node, and a debug pod on
that node found the device in `/dev/longhorn/` with **no mount of it in the host mount table** and a manual
`mount -o ro` failing with the same exit 32. The busy state was inside CSI staging, not a visible host mount.

That sequence - crash with no shutdown → pod deleted while the container had already exited → scheduler free to move
nodes → volume will not stage on the new node - is reachable for `pi-ed-postgres`: single replica, `strategy:
Recreate`, and a `nodeSelector` of only `kubernetes.io/arch: amd64`, so nothing pins it to a node. Its volume
(`pvc-4b1dccc5-…`) currently holds one attachment ticket, `Satisfied`, for `k3s-bee-2`, which is the thing to read
first if a restarted pod sits in `ContainerCreating`. The recovery levers - force-detach, restarting
`longhorn-csi-plugin` or an instance-manager on that node - are **Ed's call**, not something to try from an agent
session on a production volume; the containment lesson home-ops found for a scratch volume was that deleting the
Deployment and the PVC released the stuck staging immediately.

### Reading an attachment without lying to yourself

`hack/pi-ed-attach-state.sh` prints the attachment views side by side and is read-only, so the reason it exists is a field
layout that produces a confident wrong answer if it is guessed. In `volumeattachments.longhorn.io`, the object holds a
request half and an answer half:

```text
spec.attachmentTickets.<id>.nodeID                                     the REQUEST: who is being asked to mount it
status.attachmentTicketStatuses.<id>.satisfied                         the ANSWER: whether that mount happened
status.attachmentTicketStatuses.<id>.conditions[].lastTransitionTime   when the answer last changed
```

**`nodeID` is not a field in the answer half.** Reading it there succeeds, prints nothing, and a shell assembles that
into "attached to no node, but satisfied" on a volume that is fine - the same class of mistake as querying a
Deployment's name where a Service resolves, and the same consequence: a query that works, an answer that is wrong, and
a node-side fix nobody needed. home-ops found it in their own runbook (home-ops `51e4ea4`) while corroborating this
baseline, and it is worth saying plainly that a wrong read here is dangerous rather than merely untidy, because the
response a wrong "not attached to any node" invites is exactly the force-detach that is not an agent's to pull.

The healthy reading, taken now rather than described:

| object | field | value |
| --- | --- | --- |
| k8s `volumeattachment` | `attacher`, `nodeName`, `attached` | `driver.longhorn.io`, `k3s-bee-2`, `True`, created `19:27:20Z` |
| Longhorn `volumeattachments.longhorn.io` | `spec.attachmentTickets.<id>.nodeID`, `type` | `k3s-bee-2`, `csi-attacher` - **one ticket** |
| the same object's status half | `satisfied`, `conditions[0]` | `True`, `Satisfied=True since 19:27:25Z` |
| Longhorn `volume` | `spec.nodeID`, `status.state`, `status.robustness`, `numberOfReplicas` | `k3s-bee-2`, `attached`, `healthy`, `2` |

The timestamps line up into a story, which is what makes them useful as a baseline: pod created `19:27:17Z`, attach
requested `19:27:20Z`, answer satisfied `19:27:25Z`, and this store's `stats_reset` is `19:27:33Z` - volume,
database, extension, in that order, eight seconds apart.

**The script classifies the volume rather than leaving `robustness` for a human to interpret.** `status.state:
detached` with an empty `spec.nodeID` and `robustness: unknown` is the *ordinary* reading of a volume that simply is
not attached - a dump scratch volume between CronJob runs - and home-ops found it being read as damage across ten
volumes (home-ops `19599d1`). It is the same invitation to go pull something that is not stuck as a wrong `nodeID`
read, so the tool now prints an explicit verdict for each shape and the fields that separate them: `Scheduled=True`
with `WaitForBackingImage`, `TooManySnapshots`, `Restore` and `OfflineRebuilding` all `False`. Measured on
`woodpecker/woodpecker-pgdump`, which is a real detached volume on this cluster:

```text
state detached  robustness unknown  spec.nodeID ''  replicas 2
  Scheduled=True  WaitForBackingImage=False  TooManySnapshots=False  Restore=False  OfflineRebuilding=False
verdict: detached and nothing is blocking it. This is NOT a stuck mount and NOT a fault -
         `robustness: unknown` and an empty nodeID are the ordinary reading of a detached volume.
```

It prints that volume's backup coverage in the same output, which for `woodpecker-pgdump` is `status.lastBackupAt:
(never)` despite carrying `recurring-job-group.longhorn.io/backup-daily: enabled` - the silent skip, sitting next to
the "not stuck" verdict, because the two are read together and neither one alone is the story.

**What has never been recorded is which of those fields flips in the stuck shape.** Finding 17's stranded staging was
diagnosed from kubelet events and Longhorn plugin logs (`is in use.`, `already mounted or mount point busy.`), not
from these fields, so "compare against the healthy baseline" is currently a wish rather than a method. The ask -
which costs nothing, because it applies to the *accidental* stuck attach, the kind that actually happens - is to run
`hack/pi-ed-attach-state.sh` and keep its output at the first moment a pod sits in `ContainerCreating` with
`MountVolume.MountDevice … exit status 32`, **before** anything is detached or restarted. Detaching first destroys
the only measurement that would close this gap.

Worth knowing that this store does not do the multi-attach damage to itself: `pg-backup` mounts a *different* claim
(`pi-ed-pgdump`) and reaches Postgres over the Service, so a backup run can't contend for the data volume.

Two probe traps, so nobody re-learns them: `kill -9 1` from `kubectl exec` in a `postgres` container does nothing
(you land as the `postgres` user, `restartCount` stays 0, the postmaster never moves - the reachable unclean lever
from inside is `pg_ctl -m immediate`), and mounting a Longhorn volume root at `PGDATA` CrashLoops with `initdb: error:
directory "/var/lib/postgresql/data" exists but is not empty … It contains a lost+found directory, perhaps due to it
being a mount point` - Longhorn formats the volume, so `PGDATA` has to be a subdirectory.

And one observation with no mechanism attached, which is how it stayed: **`$PGDATA/pg_stat/` was empty at every check
while the postmaster ran** - baseline, after crash recovery, after the pod boundary - while
`pg_stat_tmp/pgss_query_texts.stat` existed after recovery (8049 bytes, 21:59). Counters kept accumulating with no
stats file in the directory you would expect. The practical reading is that **you cannot reason about statistics
durability from the filesystem on this image**; ask the view (`pg_stat_statements_info`) and not the directory.

`hack/pg-cost-snapshot.mjs` prints the window's age on its before line, so if a rollout happens to be underway
anyway, the pair of readings that would close the C′ gap costs nothing extra:

```sql
select stats_reset, round(extract(epoch from (now() - stats_reset)) / 60.0, 1) as window_minutes
from pg_stat_statements_info;
select calls, mean_exec_time, max_exec_time from pg_stat_statements
where queryid is not null and query like 'refresh materialized view%subject_index%';
-- the `%` in the middle is not slack: since the extension began naming its schema, the view holds both
-- `refresh materialized view subject_index` (the old text, with its accumulated calls) and
-- `refresh materialized view memory.subject_index` (the statement that actually runs now, starting from 1 call).
-- One pattern that matches both is how you see the discontinuity instead of tripping over it.
```

Closing the *last* gap - no shutdown at all, then a new node - needs a node-loss drill, which is a different kind of
permission than a scratch Deployment.

Three consequences that did not change:

- **A "this got slower" claim has to quote `stats_reset` and the window's length.** Means are comparable only
  *within* one window, and every number in this file - `4 / 14.78 / 17.77`, `6 / 16.01 / 21.72`, `18 / 15.55 / 22.70`
  - sits inside the single window that began at 19:27Z. Quote the stamp *and* `round(extract(epoch from (now() -
  stats_reset)) / 60.0, 1)`, because a 40-minute window and a 3-day window are not the same measurement, and because
  a stamp that has not moved in days is now known to be ordinary rather than suspicious.
- **It is per database.** `pg_stat_statements_info` does not exist in this pod's `postgres` database - the extension
  is installed in `pi_ed`. A sweep that measures one database and reads the window from another is reading nothing.
- **Rank by mean, not by total, and drop the one-offs.** The same reading contains `CREATE EXTENSION IF NOT EXISTS
  pg_stat_statements` at 143.89 ms and the extension script's own internals at 10.05 ms mean / 32.25 ms max - single
  events at init. Ranked by `total_exec_time`, they look like the worst thing this database does, and that is how a
  threshold argument gets built from the wrong row. The recurring statements are the ones in the table above.

If a run genuinely needs per-run counts, do not reset the view - now with a sharper reason, since resetting it is the
one thing known to move a stamp other readers are relying on: `hack/pg-cost-snapshot.mjs` snapshots
`pg_stat_statements`, runs a command, snapshots again, and prints per-statement deltas with per-call means, excluding
its own queries from the result. `pg_stat_statements_reset()` clears a shared window other agents are reading; a
before/after diff reads a slice of it. Nothing is lost, nothing needs announcing, and a concurrent writer shows up as
extra rows you can see rather than as a ruined baseline. If a run genuinely needs a probe statement of its own, give
it structure rather than a distinctive name, and clean it with `pg_stat_statements_reset` in the declared argument
order - see the merge contract above.

```
PI_MEMORY_DSN="$DSN" node ./hack/pg-cost-snapshot.mjs -- npx vitest run test/writer-heartbeat.test.ts
before: 133 tracked statements, window since stats_reset 2026-11-07 19:27:33Z
during the run (15 distinct statements, deltas not totals):
  0.16 ms total | 0.16 ms per call | 1 call(s)  | insert into writer_heartbeat (agent_id, repo) values ($1, $2…
  0.13 ms total | 0.04 ms per call | 3 call(s)  | select * from ( select agent_id, …
  0.11 ms total | 0.06 ms per call | 2 call(s)  | insert into writer_heartbeat (agent_id, repo, last_error, spool_rows)…
```

Reset remains available, and remains a thing to say out loud first rather than slip into a measurement script.

The matview refresh is the most expensive routine thing this store does, and it costs twenty milliseconds - which is
also why `log_min_duration_statement = 250 ms` is defensible as a number rather than a preference: it sits roughly
**twelve times above the priciest recurring statement here**, so anything that clears it is pathological by
definition. The check home-ops added to the daily sweep follows from that directly and has a counter-intuitive
healthy reading: `kubectl logs deploy/pi-ed-postgres --since=24h | grep duration:` should print **nothing**, and a
line is the finding. Two
consequences worth recording so nobody re-derives them:

- **`log_min_duration_statement = 250ms` logs nothing normal, on purpose.** It is a tripwire for a statement that has
  gone pathological, not a way to see ordinary cost - `pg_stat_statements` is where ordinary cost lives, without
  writing statement text into logs the fleet scrapes. Statement text here is agent-authored content, so logging at
  10 ms to catch a 16 ms refresh trades a store's reasoning for a number that is already available in the view.
  Defended in git now, in the manifest comment where the setting lives (home-ops `e23a14d`), with the twelve-times
  ratio as the justification so a future sweep cannot "optimise" the threshold down by intuition.
- **Event inserts are one row per statement (53 calls, 53 rows) and stay that way.** Batching them into one statement
  per flush would save roughly fifteen milliseconds in a whole run - real, and not worth losing the ability to name
  which statement a failed transaction failed on. If a future session ever does batch them, it should say which
  number made it worth it.

`74b2818` made failures *quieter* on purpose - a rejected batch rolls back, the rows go to the local spool, the dream
says so to the agent, and the store is pruned clean afterwards. Nothing cluster-visible remains. `writer_heartbeat`
(`schema/003_writer_heartbeat.sql`) is the fix for that: the writer stamps the store on its way out, in its own
implicit transaction, never inside the batch's transaction - a stamp that rolls back with the failure it is meant to
report is not evidence of anything.

Two timestamps, and the pair is the whole design:

| column | meaning |
| --- | --- |
| `last_activity_at` | a writer was here - a session opened, or a flush was attempted, successfully or not |
| `last_flush_at` | a writer *committed* a batch |

Plus `flushes`, `failures`, `spool_rows` (how deep the backlog on local disk is), `last_error`, `last_error_at`.

The reason both exist is that "the watermark is old" is not a signal: an agent that is not running has an old
watermark too. Activity without a commit is the signal, and it only appears when the store is reachable and refusing -
which is exactly the `array_concat` shape: every flush rolled back, every row went to the spool, and the only trace
was `xact_rollback` climbing while the tables stayed empty.

`schema/003_writer_heartbeat.sql` - the table itself, including `spool_since` (created with the table for a fresh
store, and carried onto an existing one by `alter table ... add column if not exists`); `heartbeatPageAlertStatement` and
`heartbeatAdvisoryAlertStatement` in `extensions/memory.ts` - the two queries, exported from the writer so the
documentation and the alerts cannot drift apart; `test/writer-heartbeat.test.ts` - the proof, which runs only against
a store (`PI_LIVE_DSN=... npx vitest run test/writer-heartbeat.test.ts`) and fabricates each shape: stale without a
commit, healthy, recently refused, refused long ago:

```sql
-- page someone when a writer is working and not committing
select agent_id, repo, last_activity_at, last_flush_at, failures, spool_rows, last_error
from memory.writer_heartbeat
where (last_flush_at is null and last_activity_at < now() - interval '2 hours')
   or (last_flush_at is not null and last_activity_at - last_flush_at > interval '2 hours')
order by last_activity_at desc;

-- note it, do not page anyone, when a writer was refused recently or has rows stranded
select agent_id, repo, failures, last_error, last_error_at, spool_rows
from memory.writer_heartbeat
where (failures > 0 and last_error_at > now() - interval '24 hours')
   or (spool_rows > 0 and last_activity_at > now() - interval '2 hours')
order by last_error_at desc nulls last;
```

If a maintenance sweep only gets to run **one** statement, run the sweep variant - `heartbeatSweepStatement()` - which
is both conditions in one result set, page rows first, with the number a human actually reads:

```sql
select * from (
            select
              agent_id,
              repo,
              case when (last_flush_at is null and last_activity_at < now() - interval '2 hours')
             or (last_flush_at is not null and last_activity_at - last_flush_at > interval '2 hours') then 'page' else 'note' end as severity,
              case
                when last_flush_at is null then round(extract(epoch from (now() - last_activity_at)) / 60.0, 1)
                else round(extract(epoch from (last_activity_at - last_flush_at)) / 60.0, 1)
              end as minutes_without_commit,
              flushes,
              failures,
              spool_rows,
              (flushes = 0 and failures = 0 and spool_rows = 0 and last_flush_at is null) as never_attempted,
              spool_since,
              round(extract(epoch from (now() - spool_since)) / 86400.0, 1) as spool_days,
              last_error,
              last_error_at,
              last_activity_at,
              last_flush_at
            from memory.writer_heartbeat
            where (last_flush_at is null and last_activity_at < now() - interval '2 hours')
             or (last_flush_at is not null and last_activity_at - last_flush_at > interval '2 hours')
               or (failures > 0 and last_error_at > now() - interval '48 hours')
               or (spool_rows > 0)
          ) as flagged
          order by (severity = 'page') desc, last_activity_at desc nulls last;
```

### "Registered, never attempted" is a reading, and the column that makes it nameable

The page half has two shapes, and only one of them is falsifiable from the store. `last_flush_at is not null and
last_activity_at - last_flush_at > interval '2 hours'` is a writer whose turns kept arriving while its commits did not:
healthy writers flush on a debounce measured in seconds, so a two-hour gap between the two watermarks cannot come from
a session that ended cleanly. The other shape, `last_flush_at is null and last_activity_at < now() - interval '2
hours'`, says something weaker: this writer has been seen active and has never committed anything. That is a real
finding when there was something to commit, and it is nothing at all when there was not.

The store can get closer than it did, because `flush()` returns before it touches Postgres when the batch is empty -
so `flushes` counts committed batches that carried at least one row, and `failures` counts refusals the store itself
saw. The sweep therefore exports the discriminator as a column rather than as a new severity:

```sql
(flushes = 0 and failures = 0 and spool_rows = 0 and last_flush_at is null) as never_attempted
```

`true` means the store has no evidence this writer ever had anything accepted or refused, and nothing stranded: the
absence of a watermark, not the presence of a failure. `minutes_without_commit` on such a row is measured from
arrival, so it answers "how long since we saw it", not "how long has it been failing", and the two have to travel
 together for a reader to tell them apart.

It is a column and not a severity change on purpose, and this repository's own live test is the measurement of why:
`heartbeat-probe-stale` is a row with nothing but `last_activity_at` three hours old, and it comes back
`severity = 'page'` with `flushes = 0`, `failures = 0`, `spool_rows = 0`. The fleet contract is that an existing
severity's meaning is never narrowed and a new condition is named at birth, because the dedup key is (`agent_id`,
severity) - so quietly removing those rows from `page` would reclassify history that is already open. `memory.test.ts`
asserts the page condition is still the alert statement's condition clause for clause, which is the guard against a
future "improvement" that narrows it while looking like a column addition. If a carrier lands and never-attempted ids
page in practice, the birth is a new severity - `unattempted`, advisory, aged on `last_activity_at` - keyed on this
column, and only afterwards does anyone decide whether `page` should widen.


### Windows that match how often someone actually looks

The sweep variant's advisory half is **wider** than `heartbeatAdvisoryAlertStatement`, deliberately, because of a rule
that applies whenever one system reports on another's database:

> a report window has to be comfortably wider than the interval at which it is read, or the condition stops
> describing what happened and starts describing when you happened to look.

home-ops' sweep runs once a day at 01:30 Perth. A 24 h failure window read once a day can only see a refusal that is
still inside its own window when the sweep fires, so a refusal 25 hours old is invisible forever - window and cadence
cancel each other out. The sweep therefore looks back 48 h, two sweep intervals, which is the smallest margin that
makes the gap impossible. `spool_rows` loses its recency guard entirely, for the same reason aimed the other way:
"spooled within the last two hours" is effectively dead on a daily cadence and hides the case a daily reader most
wants - a spool sitting there for days because a laptop closed and nothing replayed it. `spool_rows` returns to zero
by exactly one route (a successful replay by the writer that wrote it), so a nonzero value is a finding at any age,
and the age is already in the output as `last_activity_at` rather than being used to filter it away.

The real-time pair keeps its narrow windows because a real-time evaluator has nothing to widen: `heartbeatAdvisoryAlertStatement`
is the 24 h / 2 h version, and `test/writer-heartbeat.test.ts` proves both readings on the same fabricated rows - a
refusal 30 hours old is outside the alert set and inside the sweep, and a writer that stranded 7 rows three days ago
is missed by both alert queries and caught by the sweep.

### The age of a finding is in the store, not in the report

`spool_since` records when a stranded backlog began, and only a transition from "no backlog" starts it: a failure
that repeats does not reset the clock, and `heartbeatFlushStatement` sets both `spool_rows = 0` and `spool_since =
null`, so the next stranding measures from then rather than inheriting an old measurement. The sweep returns
`spool_days` alongside it.

That column exists because home-ops' report design needs an age and the heartbeat previously could only give the age
of the *last* failure. A finding that reappears every morning as a fresh discovery trains a reader to skim past it -
their own precedent for what that looks like is `cert-manager-startupapicheck`, `Failed` in dev for 105 days,
contributing a permanent series nobody reads any more. "Still open, 4 days" is only honest if something measured the
4 days. The dedup key is `agent_id` with `severity`, and the age anchors are different per finding: `last_error_at`
for a refusal, `spool_since` for a backlog. The live suite proves the non-resetting directly, by backdating a
backlog four days, running another refusal against it, and asserting the timestamp did not move.

One consequence of the page query that a test nearly made me get wrong, so it is written down: **a page row can be
late without being wrong.** A healthy writer's asymmetry is a few seconds, because it flushes on a debounce measured
in seconds, so a one-day gap between last commit and last turn cannot come from a session that ended cleanly - it can
only come from turns that failed to commit. A writer that failed, kept taking turns for a day, and then had its
machine close three days ago still pages, and the reader distinguishes "happening now" from "nobody has fixed this"
by `last_activity_at`, which is printed in every row.

The severity column is the point of this variant: a daily sweep should not depend on which query the operator
remembered to run. It also exists because a sweep has to read an *empty* result honestly - **zero rows means no
writers are active**, not no problem - so the same sweep should check `pi-ed-postgres` readiness alongside it, and
treat "no rows" and "app unhealthy" as one finding rather than two clean ones. `minutes_without_commit` is measured
against the last commit when there is one and against arrival when there is none, which is why the column is a `case`
rather than a subtraction: the two page shapes have different clocks available.

One trap worth naming here, because it cost a test run: Postgres comments start with `--` or a slash-star, never a
pair of slashes. A `//` comment written neatly inside a SQL template string parses as division and fails at the first
word of the sentence, with the typechecker completely uninvolved. The sweep statement carries no comments for that
reason.

**Two hours** is the page window, chosen for the failure mode rather than for the fastest possible detection: a normal
session flushes every few seconds, so a writer that is functioning does not go two hours without a commit, while two
hours is long enough that a laptop session that was closed, a checkout that was moved, or a Postgres restart that the
pool rode out does not page anyone. The advisory query's 24 hours is deliberately a *record* window rather than an
alert threshold - a planned restart produces exactly one refused batch, and an alert that fires on every planned
restart is an alert that gets muted the first time it is right.

What is *not* covered, and is worth saying plainly: a store that cannot be reached at all leaves no stamp anywhere,
and an absent stamp is indistinguishable from nobody working. That is a property of option (b) - a watermark written
by the writer - and it is why the page query looks for asymmetry between two columns rather than for age. Whether a
`pi-ed-postgres` exporter is scraped by vmagent on top of this is a separate decision for Ed, not something to settle
by inference from the heartbeat.

### Which side failed, read from the row alone

`last_error` starts with a kind on purpose, and the kinds are not symmetric: some of them name my writer, some name
whoever is doing the reading, and one is genuinely ambiguous. home-ops' sweep reads these rows, so the mapping is part
of the contract rather than an implementation detail.

| prefix | whose side it names | what it means in practice |
| --- | --- | --- |
| `dns:` | the reporting side | the name does not resolve where the writer is running. In-cluster this is almost always a writer that used the Deployment name `pi-ed-postgres` instead of the Service `memory` |
| `refused:` | the reporting side, usually | nothing listening at that address yet: wrong port, wrong host, or a flush that started before the Service had endpoints. A harness racing a restart produces this legitimately |
| `timeout:` | undecided | an impatient harness *or* a store accepting connections and not answering. Resolve it with the counters below, not with the prefix |
| `slots:` | the store | the connection limit is reached, which is a capacity fact about the database |
| `auth:` | the reporting side | role, password or `sslmode`. Configuration drift, not outage |
| `sql:` | pi-ed's writer | a bad statement or schema drift. Never the network, never the harness. A new `sql:` shape is a bug report against this repo, and it is the one kind that should page the store's owner rather than anyone reading a dashboard |

The counters settle what the prefix cannot. `failures` climbing while `flushes` keeps climbing and
`minutes_without_commit` stays small is a writer that retried and got through - transient, harness-shaped, worth
noticing and not worth paging. `failures` climbing while `flushes` sits still is the actual failure shape, and it is
the one the page condition asks for.

**The severities and the kinds are frozen, and that is a contract rather than a preference.** home-ops' report
deduplicates on (`agent_id`, severity), with `last_error_at` as the age anchor for a refusal and `spool_since` for a
backlog. A new *condition* therefore arrives as a new named severity or kind - which is what keeps a new finding from
being swallowed by an already-open one. Renaming the meaning of an existing severity is the failure mode the contract
exists to prevent: two different findings would silently merge into one open row in somebody else's report, and nothing
in this repository would ever show it. Anyone adding a heartbeat condition reads this paragraph before writing SQL.

That structure is also the answer to a question home-ops raised: can an impatient harness manufacture a `page` row by
killing a flush mid-flight? Not through the page query. The condition is *sustained activity without a commit*, so one
interrupted flush cannot satisfy it - it can appear at most as an advisory row, which is where a single refused batch
belongs anyway. The live suite holds that boundary rather than asserting it in prose: "reports a refused batch without
claiming it committed", "gives a daily sweep one result set, page rows first" (which asserts the fabricated refusal
comes back `note`), and "keeps a writer that arrived and never committed visible for hours" for the page shape.

The caution attached to widening a budget - mine in test timeouts, home-ops' in scrape windows - is that a generous
budget removes the manufactured alarm *and* the detector that was hiding inside it. My fix kept a deadline, but the
deadline states the property rather than the fastest observed case: a spooled row must reach disk within N seconds,
and the failure text names the precondition that went missing. If a scrape budget widens to survive a cold model, the
check needs a second discriminator for cold-versus-gone - readiness, or the latency of the first success - or warm and
dead become the same reading, and the check reports silence instead of a finding.

home-ops went and found that second discriminator in their own stack, and the obvious candidate was the trap: on that
warm embeddings pod, `/health` took 0.081 s and the work a caller actually cares about took 2.15 s. A health endpoint
is not a proxy for latency, and a 26× gap is why. What their sweep reports for a cold-model target is now the triple -
pod readiness, the latency of the first real-work success after a restart, and the budget itself - with the honest
limit stated in the report rather than discovered later: the first-success term is only meaningful where a restart is
observable (`restartCount` plus container start time), so for a pod that has never restarted there is warm-versus-slow
and not cold-versus-gone, and the report names which of the two it is claiming. Naming which claim a check is making is
the general form of this rule, and it is the same discipline as a heartbeat row that cannot manufacture a page.

## Backups, and the window not to roll in

Two copies exist and they are not equally trustworthy. The nightly `pg_dump` CronJob - alpine, no kubectl, mounts the
NFS share directly and writes `pi-ed-dump-<utc>.sql` to romulus - is the copy worth restoring from. The Longhorn
`backup-daily` group in dev also carries `pvc-4b1dccc5`, and that is the copy to hope is never needed: Longhorn
silently skips a volume that is *detached* when the job fires - labelled, selected, reported as handled,
`lastBackupAt: none`. Not hypothetical, and not a one-off either: `woodpecker-pgdump` carries the `backup-daily` label
and has **never** produced a backup, because its only writer is a CronJob that runs at 03:00Z and detaches the volume
between runs. It is silent by configuration, not by failure.

**Coverage is read from the volume, and `lastBackupAt` is the half that cannot be inferred from a label.** This
volume's own record: `recurring-job-group.longhorn.io/backup-daily: enabled` and `status.lastBackupAt
2026-11-07T18:00:34Z`, corroborated at byte level by home-ops (`0bc2d1a`, `faf1bf6`) through a read-only in-cluster
mount of the backup export - `backupstore/volumes/35/9f/pvc-4b1dccc5…`, 52 objects, newest `18:00Z`,
`backup-10d7529b14bc43ec` at `snapshotSize 247463936`. The label is the weaker of the two readings:
`recurring-job-group.longhorn.io/default` on a volume is Longhorn's *default-group marker*, not a job, and home-ops
found ten volumes across the two clusters labelled while the cluster's only recurring job (`backup-daily`,
`groups: [backup-daily]`, cron `0 18 * * *`) selects a different group. A sweep asks the volume -
`spec.recurringJobSelector`, `status.lastBackupAt` - and asks the target - `spec.backupTargetURL`, **not** `spec.url`,
which is empty even on a cluster that backed up eight volumes ninety minutes earlier - and it carries the condition
type name with its status, because a healthy target reports `type: Unavailable`, `status: "False"`.

**The mechanism of the skip, and why it leaves no evidence.** `allow-recurring-job-while-volume-detached` is `false` in
both clusters, and the value lives at top-level `.value` on the setting object - `spec.value` and `status.value` are
both absent there, so reading either prints nothing and looks like "unset". With it off, a recurring job fires only if
the volume is attached at the cron minute, and a skip **creates no Backup object and no error**: this cluster returns
5 `backup.longhorn.io` records and none of them is in an error state, while `woodpecker-pgdump` - labelled
`backup-daily`, and detached between its 03:00Z dump runs - has never produced one. So "no failed backups" is
byte-for-byte the output of "nothing was ever attempted", and a coverage sweep cannot infer the difference from the
absence of errors. A job's own counters are not coverage either: `recurringjob.status.executionCount` is per object
lifetime (home-ops reset theirs by recreating the job during a backup-target fix), and a job's `status.history`
cannot answer "did it run every night" at any retention: `recurring-successful-jobs-history-limit` and
`recurring-failed-jobs-history-limit` are both `1`, and home-ops measured that in **dev and prod alike**, so the
object physically holds one success and one failure of evidence and no more. Coverage is per-volume `lastBackupAt`
plus attach state at the cron minute, or nothing.

**Attributing a backup to a volume reads the answer half again.** `spec.volumeName` does not exist on the Backup CRD;
the volume is `status.volumeName`, the snapshot name corroborates it (`backup-d-…` from the daily job, `backup-v-…`
from a verification job), and `created` reads `backupCreatedAt` - there is no `status.startTimestamp` on a Backup at
all, which is how a runbook column literally named `CREATED` printed `<none>` for every object since the day it was
written (home-ops `384862b`). Same request/answer asymmetry as the attachment tickets' `nodeID`, and the same failure
mode: read the wrong half and the field is simply empty.

**And the job label is not a complete attribution.** Prod `backup-e04d35e3ff0d4347` is `Completed`, has a real
`backupCreatedAt`, belongs to a volume with three backup objects, and carries **no `spec.labels.RecurringJob`** - it
is identified only by `metadata.labels` (`backup-volume`, `backup-target`). So a count that reads the job label
undercounts the backups a volume started itself, and the reader of that count is making a coverage decision. The
script names the absent case on the line and prints how many of them there are, rather than leaving `job=None` to be
read as "not a recurring backup".

`hack/pi-ed-attach-state.sh` now prints both readings, and classifies the volume rather than leaving `robustness`
for a human to interpret - because `robustness: unknown` with an empty `spec.nodeID` is the *ordinary* reading of a
volume that is merely detached, and has been misread as damage. This store's own record, live:

```text
state attached  robustness healthy  spec.nodeID 'k3s-bee-2'  replicas 2
volume recurring labels: {"backup-daily": "enabled"}
status.lastBackupAt: 2026-11-07T18:00:34Z   (the only per-volume coverage there is)
Backup objects for this volume: 1 of 5 in the cluster
  backup-10d7529b14bc43ec  job=backup-daily  state=Completed  snapshot=backup-d-e0808e27…  created=2026-11-07T18:00:37Z  uploaded 11626797 newly of 247463936 backup bytes (4.7%; volumeSize 5368709120)
```

That last field is the affordability argument for a single backup target, stated as a number: the daily backup moved
**11.6 MB of a 247.5 MB backup**, 4.7%, because the rest of the blocks were already in the target. The denominator
matters twice over - against `volumeSize` (the 5 GiB volume) the same figure reads 0.2% and understates the ratio
20-fold, and `size` is the backup payload. Both numbers are on the same object, and only one of them is the answer.

One backup, because the store is ~17 hours old and that is one daily cycle. "One" is the right number here and would
be the wrong number next week; the assertion is the pair, not the count.

**And both copies are on one device.** Measured, not assumed:

| copy | where it actually lives |
|---|---|
| the SQL dumps | PV `pvc-0b2861fa…`, `nfs.csi.k8s.io`, `server 192.168.1.25`, `share /storage-hdd`, `subdir pvc-0b2861fa…` |
| the Longhorn backups | dev backup target `nfs://192.168.1.25:/storage-hdd/longhorn-backup-dev` |

Same host, same export, different subdirectory. So the protection this store actually has is: **Longhorn's two
replicas** survive a bee node dying (`numberOfReplicas 2`, healthy, on `k3s-bee-2`); **neither copy** survives
romulus's `storage-hdd` export dying, being unmounted badly, or being `rm -rf`'d - which is also true of the pi session
histories home-ops keeps on an RWX share of the same export. A `longhorn-csi-plugin` restart cannot strand the dump
volume (it never touches it) and a Longhorn volume restore would not restore the dumps, so the two copies are not two
failure domains. Whether that is acceptable - a second backup target on different hardware, or a stated decision that
one NAS is the floor this store is willing to sit on - is Ed's call, not something a runbook should quietly assume away
by listing two copies.

So nothing detaches this volume between 17:55Z and 18:10Z - and the reason is now a mechanism rather than a superstition:
with the setting above at `false`, being detached at 18:00Z is not a failed backup, it is a *skipped* one that leaves
no object, no error, and no line anywhere. No `kubectl rollout restart deploy/pi-ed-postgres`, no
scale to zero, no cordon that evicts it. A manifest change that alters the pod template - `shared_preload_libraries`
for `pg_stat_statements`, an image bump - belongs at some other hour, because Argo rolls the pod whenever the sync
wave lands and a pod rolled at 18:00Z is a volume detached exactly when the backup job enumerates it. A rollout
outside that window is safe for the writer too: the pool fails, spools to disk, and replays on the next flush, and -
now measured - it is safe for the statistics window as well, clean or crash.

One qualifier on "safe", from the same set of measurements. A rollout *is* a pod boundary, and `Recreate` plus a
`nodeSelector` of only `kubernetes.io/arch: amd64` means the replacement is free to land on another node. That is the
reachable route to the stuck-attachment failure above, which is worse than a slow rollout: the pod sits in
`ContainerCreating` with `MountVolume.MountDevice … exit status 32` and the database is not down, it is *unattachable*.
So roll `pi-ed-postgres` deliberately - at an hour outside the backup window, and watched - rather than letting a sync
wave land it at an arbitrary minute; if it does stall, the first read is the volume's `volumeattachments.longhorn.io`
ticket and the Longhorn CSI plugin's own logs, and the fix from there is Ed's call.

Assert presence and mtime when checking a backup, never size. A few hundred bytes is the correct output of a healthy
store the live check has just cleaned out; a `Complete` CronJob with no new file is the failure mode.

## Apply

Apply them in filename order - `001` is the store, `002` added `event.source_entry_id`, `003` added
`writer_heartbeat`:

```sh
for f in memory/schema/*.sql; do
  kubectl --context home-dev -n pi-ed exec -i deploy/pi-ed-postgres -- \
    psql -U pi_ed -d pi_ed -v ON_ERROR_STOP=1 < "$f" || break
done
```

The live check waits on a real model deciding to call tools, so a full run can take several minutes; its budgets are
generous on purpose. A timeout from that script names the phase it was waiting for, and a timeout waiting for a tool
to *start* is model latency, not a broken store - the check's own comment says why an impatient budget manufactures
the failure it exists to detect.

Each is idempotent - `create table if not exists`, `create or replace function`, `create index if not exists`,
`create schema if not exists` - so re-applying them after a restore is a no-op rather than an event, and applying
them out of order fails loudly on a missing dependency rather than half-building a schema.

### The one setting the writer depends on

`001_init.sql` carries `alter role pi_ed set search_path = memory, public`, and the writer's table names are
unqualified, so that line is load-bearing rather than tidy: `insert into event` means `memory.event` only because the
role says so. The failure mode if it ever changes is not an error - if `public` moves first, or something creates a
same-named table in `public`, the writes silently split between two tables and the store reports exactly the row
counts a healthy store would. Two rules follow, and both are worth stating before someone "just reorders" a line:
keep `memory` first in that role's `search_path`, and if it ever has to move, qualify every name in
`extensions/memory.ts` first.

home-ops' copy in `MAINTENANCE.md` spells the sweep query `memory.writer_heartbeat`, and that is the right difference
rather than drift: a report run by someone else should not inherit a setting it does not own, because a sweep that
reads the wrong schema does not fail, it reports "no writers active".
