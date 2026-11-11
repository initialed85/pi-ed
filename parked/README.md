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

## `memory.ts` — parked, un-parked, and parked again, all on 2026-11-10

The store is untouched. The reading room (`memory-ui`), the MCP server, the schema and the 139 migrated rows all stay
in service; what stopped is agents being *given* `memory_search` and `memory_dream`.

**The order.** Ed decided the fleet writes to a graph, not to Postgres: *"i told you to turn off memory … we're
pivoting to cognee"*. That was 2026-11-10; cognee itself was deleted from the cluster within a day (its ingest
stalled forever retrying schema-invalid graph output) and replaced by **Graphiti over Neo4j** in namespace `memory`,
so the door a session is given today is `extensions/graphiti.ts`. The parking is the same parking either way: which
store agents are handed, decided by Ed, not by whichever extension was last to work.

**Why it was un-parked for a few hours, since the reasoning is the useful part.** The fleet was mid-cutover, cognee
could not write, and I thought the safe answer was two doors. The measurements behind that call, taken on home-dev:

1. **Cognee could not write at all.** `POST /api/v1/remember` answered **409 after ~31 s** — "Embedding connection
   test timed out after 30s. Check that your embedding endpoint is reachable." — because `embeddings-nvidia` cannot
   schedule (`0/1`; `gpu-size: medium` labels only hermes, NotReady since 2026-11-10T12:13:33Z). A background write of
   the same note answered **200 in 135 ms and stored nothing**: the live check's row-count assertion read `0 → 0`.
2. **Its retrieval missed a fact it demonstrably had.** home-ops measured a fact plainly present in the stored raw
   document that **`CHUNKS` did not return** after the `chunkSize: 400` rebuild, and `RAG_COMPLETION` refused it too.
3. **Cognee reads what it already holds.** With the embedder down and no schedulable GPU anywhere, unscoped `CHUNKS`
   recall answered **200 in 250–480 ms with relevant chunks on three separate questions**. So cognee-only is blind to
   *the future*, not the past — which is why the interim being asked for was tolerable, and why the end condition below
   is about writes and retrieval quality rather than availability.
4. **Postgres answers too, by design.** `memory_search` runs vector recall when the embedder replies and otherwise
   falls back to keyword/full-text (`parked/memory.ts`, the recall section) — so it worked through the outage.

**What "cognee only" costs while the embedder is unschedulable, stated plainly so nobody is surprised later:** every
`memory_remember` answers 409 in the foreground, or 200-and-stored-nothing in the background. Until home-ops lands a
reachable embedder, the fleet has a memory system that reads yesterday and cannot write today. That is not an
argument against the pivot; it is the thing to watch after it.

**End condition — what `hack/graphiti-live-check.mjs` now has to keep showing before anyone re-opens this file:** a
write becomes an episode *and* a retrievable fact rather than only a `202`; the stored episode carries the note
verbatim; and `--prove-delete` shows a credential literal is gone after `DELETE /group/{id}`. All three passed on
2026-11-11, eleven seconds after home-ops fixed the door's LLM URL — which is the same morning the door silently
stored a probe key as a fact, the measurement that found the missing `sk-` rule in `lib/redact.ts`.

**Also settled on the way:** the migration is not finished just because the tally looks finished. Anything Postgres
receives after the 139 exported rows needs a second pass, so home-ops' ledger wants an export watermark rather than a
count.

**To park something:** `git mv extensions/<name>.ts parked/<name>.ts`, add the name to `PARKED` in
`test/packaging.test.ts` and `PARKED_EXTENSIONS` in `hack/check-package-shape.mjs`, and write the reason in this file
before the reason is forgotten. **To bring one back:** the same `git mv` in the other direction, remove the name from
those two lists, and say why in the section above. `pi update --extensions`, or a container restart, is what carries
the change into a running session; a session already up keeps the tools it loaded at startup until it restarts or
`/reload`s.
