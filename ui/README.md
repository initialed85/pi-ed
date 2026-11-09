# the reading room

A read-only window onto the memory store: the dreams, the events they were drawn from, and the graph between them.

`server.mjs` is one file of Node with two dependencies — `pg` and nothing else. The page is three files of vanilla
JavaScript with no build step, including a hand-rolled force-directed SVG layout. There is deliberately no framework
here: the app has one job, it has no state of its own beyond what the store gave it, and every dependency added to it
is a dependency the image has to carry and someone has to audit.

## running it

```sh
export PI_MEMORY_DSN=$(kubectl --context home-dev -n slopyphus get cm config -o jsonpath='{.data.PI_MEMORY_DSN}')
node ui/server.mjs                      # http://127.0.0.1:8090
PORT=8080 node ui/server.mjs            # the port the Service and Ingress expect
node ui/server.mjs --help               # there is no --help; there is nothing to configure
```

Without `PI_MEMORY_DSN` the page loads and every API call answers 503. That is the intended shape of "not configured":
the app is reachable, and it says what is missing rather than pretending to be an empty store.

Locally the API answers `401` unless the request carries the gate's headers, because locally there is no gate. To look
at it from a laptop:

```sh
curl -H 'x-auth-request-email: you@example.com' localhost:8099/api/summary
```

…which is the honest way to admit that you are vouching for yourself.

## what it reads

| endpoint | what it answers |
| --- | --- |
| `GET /healthz` | is the store reachable (no identity required, so a port-forward can check) |
| `GET /api/summary` | counts on the header line |
| `GET /api/facets` | the agents, edge kinds, event kinds, tools and triggers the dropdowns and the legend are built from |
| `GET /api/memories` | memories, newest first, `agent` / `limit` / `offset` |
| `GET /api/search` | `mode=vector` (asks the embedder, ranked by cosine), `mode=text` (ILIKE over summary, subjects, feel), and a text fallback that names the reason it fell back |
| `GET /api/memory?id=` | one memory, its span's events, its edges, its `detail` |
| `GET /api/events` | raw event rows, `agent` / `kind` / `tool` / `q` |
| `GET /api/edges` | edges with both ends typed and named, as rows and as `{nodes, edges}` for the graph |

The edge half reads `memory.graph_edges`, the view the migration ships. Not because joining is expensive — because if
the UI resolved endpoint labels its own way, the graph and a `select` in psql would disagree about what the same edge
is called, and the reader would be auditing the app instead of the store.

## the four things that make it safe to put on a public hostname

1. **Nothing typed by a caller reaches SQL text.** Every filter is a `$n` placeholder. `test/memory-ui.test.ts` feeds a
   payload containing quotes and semicolons and asserts no fragment of it survives into the statement.
2. **Every list has a ceiling** (`MAX_ROWS`, 500), including the graph payload, so a page load is not an export.
3. **The pool is read-only at the session level.** `set session default_transaction_read_only = on` on connect, so a
   write added to this code later fails. Proved against the live store by the test suite with `PI_LIVE_DSN` set.
4. **The static handler cannot leave `ui/public`.** It normalises, then compares the resolved path against the
   directory it is allowed to serve, so `/%2e%2e%2f%2e%2e%2fetc/passwd` is a 404.

Identity comes from Traefik's forwardAuth (`X-Auth-Request-Email` / `-User`). The app does not authenticate anybody; it
checks that the gate did and returns `401` when nothing vouched for the request. `/` and `/healthz` are served without
one, because the page contains no memories and a health check you cannot run from a port-forward is a health check
nobody runs.

## the graph layout

Force-directed, ~70 lines, seeded so the same query draws the same picture on the next reload (`Math.random()` makes a
stable dataset look unstable). It animates rather than solving upfront, and it pulls different kinds to different
lengths: `room_*` and `dreamed_from` at ~70px, `memory_about` at ~55px, `shares_subject` at ~110px, because a popular
subject can legitimately match a hundred memories and squeezing them into one clump hides the structure you came to see.

Repulsion is O(n²) and that is fine: the payload is capped at 500 edges, and a Barnes–Hut tree for that many nodes is
more code than it saves.

## tests

```sh
npx vitest run test/memory-ui.test.ts                                    # offline
PI_LIVE_DSN="$DSN" npx vitest run test/memory-ui.test.ts                 # + read-only enforcement, live endpoints
npx vitest run test/memory-ui-client.test.ts                             # the client, mounted in jsdom
```

The client test is not a nicety. The first version of this UI shipped with tables that rendered as
`[object HTMLTableRowElement]` and a detail pane that rendered as `[object HTMLParagraphElement],[object
HTMLTableElement]`, and every test in the repository was green while it did so, because every test in the repository is
a server test. `test/memory-ui-client.test.ts` mounts the real `ui/public/index.html`, runs the real client against a
canned store, and asserts the blunt thing: a row is a row, and the string `[object ` appears nowhere in the rendered
document. `jsdom` rather than a hand-rolled DOM, because the whole defect was about how the real `Element.append`
treats a non-node and a stub would have been a second implementation of the thing under test.

That is also why `app.mjs` exports `boot()` instead of fetching at import time: a module that contacts the store the
instant it is loaded cannot be mounted by anything that wants to render it.

The live half is skipped by default and is deliberately skipped in the publish lane: a publish lane that can only pass
when the cluster is healthy is a publish lane that cannot publish a fix for the cluster.

## deploying it

`initialed85/pi-ed` `.woodpecker/build-ui.yaml` builds `ui/Dockerfile`, pushes
`initialed85/memory-ui:{sha,latest}`, and stamps the sha into home-ops
`clusters/dev/applications/memory-ui/kustomization.yaml`, which Argo CD syncs. The manifests, the auth gate and the
reason `auth` has to sync first are in `home-ops/clusters/dev/applications/memory-ui/README.md`.
