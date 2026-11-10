# Parked extensions

A parked extension is a working extension that Pi is not loading. It is outside `extensions/` on purpose: `pi install
git:github.com/initialed85/pi-ed` discovers everything in `extensions/` through `package.json`'s `pi.extensions` field,
so the surest way to stop an extension reaching a session is to stop it being in that directory. A manifest exclusion
(`!./extensions/memory.ts`) was measured against a real Pi load and did not hold; a directory that Pi does not look in
does not need to be trusted.

It is not deleted, renamed to something a tool cannot load, or commented out, because all three make the return trip
worse. The file is typechecked (`tsconfig.json` includes `parked/**/*.ts`), its tests still run (`test/memory.test.ts`,
`test/edges.test.ts`, `test/dream-thin-span.test.ts`), and its exported statements are still swept against the live
store by home-ops' `hack/check-pied-statements.py`. A parked extension that is never compiled or tested is an extension
that has quietly rotted.

## `memory.ts` — parked 2026-11-10

**Why:** Ed is cutting the fleet over to **mem0** (shipped from home-ops) for a while, and `memory_search` /
`memory_dream` must not be offered to an agent while that cutover runs. Two agents answering from two different memory
systems is worse than one agent answering from none.

**What is unaffected:** the Postgres store (`pi-ed-postgres`), its schema and its existing rows; the reading room at
`memory.dev.initialed85.cc`; the `pi-memory` MCP server; every test in this repository. Parked means not loaded, not
erased — the old memories stay exactly where they are and stay searchable through the reading room and the MCP server
while mem0 warms up.

**Bring it back:**

```sh
git mv parked/memory.ts extensions/memory.ts && git commit -m "memory: back in the load path"
```

Nothing else needs touching: `test/packaging.test.ts` and `hack/check-package-shape.mjs` both pin the parked set by
name, so moving the file makes them fail until the parked list is emptied — which is the intended order of operations,
not a trap. `pi update --extensions` (or a container restart) is what carries the change into a running session; a
session that is already up keeps the tools it loaded at startup until it restarts or `/reload`s.
