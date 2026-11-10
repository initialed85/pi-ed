# Parked extensions

A parked extension is a working extension that Pi is not loading. It is outside `extensions/` on purpose: `pi install
git:github.com/initialed85/pi-ed` discovers everything in `extensions/` through `package.json`'s `pi.extensions` field,
so the surest way to stop an extension reaching a session is to stop it being in that directory. A manifest exclusion
(`!./extensions/memory.ts`) was measured against a real Pi load and did not hold; a directory that Pi does not look in
does not need to be trusted.

A parked extension is not deleted, renamed to something a tool cannot load, or commented out, because all three make
the return trip worse. The file stays typechecked, its tests keep running, and its exported statements are still swept
against the live store by home-ops' `hack/check-pied-statements.py`. A parked extension that is never compiled or
tested is an extension that has quietly rotted.

**Nothing is parked today.** This directory is kept with its reasoning intact because an unexplained `parked/` gets
tidied away, and with it the record of why something was taken out of the fleet and what measurement put it back.

## `memory.ts` — parked 2026-11-10, returned to service the same evening

**Why it was parked:** Ed was cutting the fleet over to **cognee** (`extensions/cognee.ts`, talking to Cognee 1.6.7 in
namespace `cognee` on home-dev), and `memory_search` / `memory_dream` were not to be offered to an agent while that
cutover ran. Two agents answering from two different memory systems is worse than one agent answering from none.

The first version of this note said mem0. That was true at the moment it was written and wrong within hours: mem0 was
turned down in favour of cognee because mem0's FOSS build dropped the knowledge graph and the graph was the whole point
("a filing cabinet is fine but I wanted to test the graph" — home-ops `clusters/dev/applications/cognee/README.md`).

**Why it returned to service, on measurements rather than on a change of heart, all of them taken on home-dev on
2026-11-10:**

1. **Cognee could not write at all.** `POST /api/v1/remember` answered **409 after ~31 s** — "Embedding connection
   test timed out after 30s. Check that your embedding endpoint is reachable." — because `embeddings-nvidia` cannot
   schedule (`0/1`; "0/12 nodes are available: 1 node(s) were unschedulable, 4 node(s) didn't match Pod's node
   affinity/selector, 7 node(s) had untolerated taints", and `gpu-size: medium` labels only hermes, NotReady since
   2026-11-10T12:13:33Z). A background write of the same note answered **200 in 135 ms and stored nothing**: the
   live check's own row-count assertion reported `0 → 0 row(s)`.
2. **Cognee's retrieval is the weak axis, not its composing.** home-ops measured that a fact plainly present in the
   stored raw document was **not returned by `CHUNKS`** after the `chunkSize: 400` rebuild, and `RAG_COMPLETION`
   refused it too. A memory system that cannot retrieve what it stored is not a memory system yet.
3. **Both stores read; only one of them writes.** During the same outage the Postgres store answered a lexical query
   with recent dreams (139 of 139 rows carry a vector), and cognee's `CHUNKS` door also answered — unscoped, 250–480 ms
   per query, relevant chunks on three separate questions — even with no embedder anywhere in the cluster. The
   assumption that cognee would be entirely dark was wrong, and the honest version is narrower and worse for cognee:
   it can read what it already stored, it cannot store anything new, and the one retrieval test that mattered — a fact
   plainly present in the stored document — it failed.

**The interim, and its end condition.** Both doors are loaded, with distinct tool names and no ambiguity:
`memory_remember` / `memory_recall` / `/cognee` for cognee (the intended write path and the graph), and
`memory_search` / `memory_dream` for Postgres (the recall of record, still writable precisely because writing is what
cognee currently cannot do). Cognee becomes the only door when `hack/cognee-live-check.mjs` shows three things: a
marker written now is retrievable from `CHUNKS`; `/data/count` moves when a write is accepted; and `--prove-delete`
shows a delete removes the credential the note carried. Until then, an agent that gets nothing from cognee is told to
try the other door rather than told the fleet never wrote it down.

**Also settled on the way back:** the migration is not finished even though the tally looks finished. Anything
`extensions/memory.ts` writes after the 139 exported rows needs a second pass, so home-ops' ledger wants an export
watermark rather than a count.

**To park something again:** `git mv extensions/<name>.ts parked/<name>.ts`, add the name to `PARKED` in
`test/packaging.test.ts` and `PARKED_EXTENSIONS` in `hack/check-package-shape.mjs`, and write the reason in this file
before the reason is forgotten. `pi update --extensions`, or a container restart, is what carries the change into a
running session; a session already up keeps the tools it loaded at startup until it restarts or `/reload`s.
