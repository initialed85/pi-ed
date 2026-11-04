# pi-ed

Eight [Pi](https://github.com/earendil-works/pi) extensions I wrote to stop my agents doing the things
that were wasting my time, plus the tests that keep them honest.

They live in `~/.pi/agent/extensions/` on my machines. This repository is the source of truth: the
installed files are symlinks into a clone of it, so there is exactly one copy of each to edit. Pi's
discovery accepts symlinked extension files (`loader.js`: `entry.isFile() || entry.isSymbolicLink()`),
and `/reload` follows them.

```
extensions/   the eight extensions
test/         vitest suite, 166 tests, no Pi runtime and no network needed
hack/         check-package-shape.mjs, the CI gate on the package manifest
.woodpecker/  CI: workflow lint + typecheck + tests
```

## Install

Clone it where Pi discovers packages — a directory under `~/.pi/agent/extensions/` with a
`package.json` carrying a `pi.extensions` field is one of the documented layouts:

```bash
git clone https://github.com/initialed85/pi-ed ~/.pi/agent/extensions/pi-ed
cd ~/.pi/agent/extensions/pi-ed && npm install
```

Or let Pi install it: `pi install git:github.com/initialed85/pi-ed`.

`/reload` inside a running session picks the files up.

Pi provides `@earendil-works/pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui` and `typebox` to
extensions itself, so they are `peerDependencies` here and only `devDependencies` for the test
run. They are deliberately **not** in `dependencies`: a bundled copy gives extensions duplicate
class registries.

## The extensions

### `autopilot.ts` — the model writes the next prompt from your shoes

When the agent is about to settle, a side call asks it to write the prompt *you* would send next, appends
that as a user message, and keeps going. Everything happens in one agent run, append-only, so the main
prompt prefix stays warm and cached.

The side call is deliberately cache-hostile (`cacheRetention: "none"`, fresh sessionId, reasoning off,
few-hundred-token brief): it never writes a provider cache entry, so the session keeps exactly one
growing cached prefix. That was measured, not hoped — side calls report `cacheRead=0 cacheWrite=0`.

Anti-drift: the brief always shows *the request you actually made*, and the human-voice has to measure
every candidate against it. It refuses prompts already sent, stops on shape similarity (it is repeating
itself), and stops when context usage passes 85%.

| | |
| --- | --- |
| Commands | `/autopilot [goal]` arm · `/autopilot stop` · `/autopilot status` · `/autopilot max <n>` · `/autopilot goal <text>` |
| Flags | `--autopilot`, `--autopilot-max <n>`, `--autopilot-goal <text>` |
| Env | `AUTOPILOT_DEBUG=<logfile>` to trace the loop |
| Knobs | `DEFAULT_MAX_HOPS` (128), `MAX_HOPS_CEILING` (1024, the one ceiling for `/autopilot max <n>` and `--autopilot-max`), `SIDE_CALL_MAX_TOKENS` (600), `CONTEXT_STOP_PERCENT` (85), `SHAPE_STOP` (0.7) |

### `loop-guard.ts` — catches a failing agent doing the same failing thing again

Watches tool calls and assistant text. When a *failing* action repeats — same command shape, same
failure — it blocks the repetition and tells the model to change approach. Repetition that is working is
left alone: a `git status` loop that is making progress is not a bug, and a guard that blocks it is.

Command shapes are normalised before comparison (`7.txt` and `8.txt` fold to the same token, `sleep 3`
and `sleep 30` fold to `sleep`, `| head -20` and `| tail -5` are stripped) so that an agent nudging a
timeout by ten seconds is still recognisably the same mistake. Text is compared by word-set similarity
above a threshold, with a minimum length so short confirmations never match each other.

| | |
| --- | --- |
| Knobs | `HISTORY_LIMIT` (32), `MAX_CYCLE_LENGTH` (4), `TEXT_SIMILARITY_THRESHOLD` (0.84), `MIN_TEXT_WORDS` (16), `FAILURE_MARKER` (the regex that decides what counts as a failure) |

### `compaction-summary-guard.ts` — auto-compaction stops failing on the token cap

The failure this fixes: `Auto-compaction failed: Summarization failed: generation hit the token cap and
the summary is incomplete`, repeating every turn, with context pinned at the ceiling.

The cause is local reasoning models. Pi caps the summarization response at `min(0.8 * reserveTokens,
model.maxTokens)` (~13k tokens), summarizes at the *session* thinking level — where `high` maps to
`xhigh`, an unbounded reasoning budget — and reasoning eats 1k–9k of those tokens. Each compaction merges
the previous summary forward, so summaries grew until every attempt hit the cap.

It keeps Pi's own `compact()` (same structured format, previous-summary merge, split-turn handling, cut
point) and only changes the summarization request: bounded response cap, reasoning off, a hard length
budget in the prompt, validation of the actual output, and up to two compressed retries when a summary
still comes back oversized. Worth ~1–2 minutes per compaction on a local model, purely because the budget
goes into the summary instead of into thinking.

What it does when it still cannot get under budget: **uses the summary anyway.** A summary 30% over is
accepted on the spot rather than costing two more model calls; if all three attempts come back big, the
smallest one is kept (trimmed to budget at a line boundary if it is more than 2× over). Falling back to
Pi's default compaction is now the last resort, reached only when there is no usable summary at all —
because the default path is the thing that was failing, so it was never a safer option than a real
summary that happened to be a bit long.

| | |
| --- | --- |
| Knobs | `SUMMARY_OUTPUT_TOKENS` (8192), `SUMMARY_TARGET_TOKENS` (4000, so 16000 characters), `SOFT_OVERLIMIT_RATIO` (1.3, accept without retrying), `TRIM_OVERLIMIT_RATIO` (2, trim rather than pass through), `RETRY_POLICY` (`maxRetries: 2`, `baseDelayMs: 2000`, `maxAgentDelayMs: 15000`) |

### `searxng.ts` — web search through my own SearXNG

Registers a tool named `web_search`, which **replaces** Pi's built-in DuckDuckGo search (registering a
tool with a built-in's name replaces it entirely). Results are the same shape the built-in returns, so
nothing downstream notices.

```bash
SEARXNG_URL=https://searxng.dev.initialed85.cc   # default; override for a local container
```

Two things worth knowing if you fork this: the instance must have `json` in its SearXNG `formats` list,
or every call dies with a non-JSON error; and the endpoint is a homelab service behind a LAN/Tailscale
allowlist, so it answers 403 from anywhere else and the tool says so explicitly rather than pretending
there were no results.

### `queue-reload.ts` — `/queue-reload`

Queues a reload for when the agent is next idle, instead of dropping the runtime in the middle of a turn.
`/reload` while the agent is working interrupts it; this waits.

### `session-commands.ts` — `/continue` and `/clear`

- `/continue` re-arms a session with an explicit instruction to resume from the last *verified* state and
  to take a materially different step if the last one failed — rather than retrying the same dead end,
  which is what a plain "continue" tends to do.
- `/clear` starts a fresh session and carries the current session name over, so `--session-name` keeps
  working after you clear.

### `session-markers.ts` — `/comment` and `/score`

Marks on the session for reviewing model performance later. They go in the session history and the
model cannot see them.

- `/comment <text>` — a note.
- `/score <0|1|2> [note]` — a rating: 0 bad, 1 neutral, 2 good. `bad` / `neutral` / `ok` / `good` work
  too, so the intent never has to be remembered.

Each writes a `CustomEntry` with `pi.appendEntry()`. Custom entries are ignored by Pi's
`buildSessionContext()`, and an extension command is executed rather than sent as a prompt, so neither
the mark nor the text you typed reaches the model. `test/session-markers.test.ts` asserts that against
Pi's real context builder rather than against this sentence.

Pi stamps the entry with `id`, `parentId` and an ISO `timestamp`, so it is durable and sits in the tree
at the point you made it. The record also carries what cannot be recovered later: which model and
thinking level were in use (they change mid-session) and the entry id of the message being marked. That
target is the nearest *message* walking back from the leaf rather than the leaf itself, so two marks in
a row still rate the same turn instead of the second one rating the first.

A score of 1 is written, not skipped. If neutral meant "no entry", a reader could not tell a turn rated
neutral from a turn nobody rated, which is the difference between a rating scale and a count of
complaints.

Marks render in the transcript via `registerEntryRenderer`, so you can see what you marked without the
model seeing it.

```bash
jq -r 'select(.customType=="model-marker")
       | [.timestamp, .data.kind, .data.score, .data.text // .data.note] | @tsv' \
  ~/.pi/agent/sessions/*/*.jsonl
```

| | |
| --- | --- |
| Record | `customType: "model-marker"`, `data.v: 1` — the one string a reader should grep for |
| Score | `0` bad, `1` neutral, `2` good, stored as a number so it can be averaged |

### `tags.ts` — `/tag` hashtags on a turn, or on the session

Labels for later. A hashtag goes on the exchange you are looking at, or on the session as a whole, and
none of it reaches the model.

```bash
/tag                             what is tagged, anywhere
/tag message add #rooter #slow   this exchange: the prompt, its tool calls, its answer
/tag session add #wip #home-ops  this session, which also puts them in the footer
/tag message remove #slow
/tag session clear
/tag message list
```

Two scopes, because there are two different things worth labelling. A message tag is about one exchange;
the footer would be the wrong place for it, because a status line is a slot the next turn overwrites — a
turn tag shown there reads as though it belongs to whatever you are doing now. Session tags go in the
footer because they describe the session, and nothing about the next turn can make them stale.

**A message tag is keyed on the turn, not on the leaf.** The record carries both ends of the span:
`turnId` is the nearest user prompt walking back from the leaf, `messageId` is the last message at the
time. Tag mid-turn (after the third tool result) and tag again after the answer, and both join up on the
same exchange; key on the leaf instead and the second tag would describe the first. System entries are
skipped — a `message` entry with role `system` is the prompt and tool loadout being patched, not something
anybody said, and it is often the newest entry in the tree.

**The log is append-only, because that is all the session tree allows.** One record is one operation on
one scope, and what is tagged is what the operations leave behind when replayed along the current branch.
That has three consequences worth knowing: tags are **branch-relative** (navigate to an earlier point with
`/tree` and the tags made after it are not there); tags **survive compaction** (the replay reads the raw
branch, not the compacted context); and an operation that would change nothing **writes nothing**, because
a record that does nothing makes the log read as though something had been applied.

**Names are normalized so one idea cannot become two tags.** The leading `#` is optional and stripped,
`#Prod`, `PROD` and `prod` are the same tag, and the stored list is sorted. Letters and numbers from any
script, then `_ . : / -`, which covers `#home-ops`, `#2026-11-04`, `#v3.0` and `#pi/agent` without allowing
anything that could be mistaken for another part of the grammar. Tags are separated by spaces or commas.

**Completions cover the grammar only** — the scope, then the verb. `getArgumentCompletions` is handed the
text typed so far and nothing else: no session, no branch. Offering tag names would mean caching the tags
this extension last wrote, and that cache goes stale across `/resume`, `/tree` and `/fork`, so it would
start proposing tags that are no longer there. Typing a hashtag yourself cannot be stale.

Like `/comment` and `/score`, these are `CustomEntry` values written with `pi.appendEntry()`, so Pi's
`buildSessionContext()` ignores them and `test/tags.test.ts` asserts that with Pi's own context builder.
A record that names no tags on a `clear` is still rendered, because the log then says the scope was emptied
rather than showing an empty tag list.

```bash
jq -r 'select(.customType=="tag")
       | [.timestamp, .data.scope, .data.op, (.data.tags | join(",")),
          .data.target.turnId // "session"] | @tsv' \
  ~/.pi/agent/sessions/*/*.jsonl
```

| | |
| --- | --- |
| Record | `customType: "tag"`, `data.v: 1` — the one string a reader should grep for |
| Scopes | `message` (one exchange, keyed on its prompt) · `session` (the whole session, shown in the footer) |
| Ops | `add` · `remove` · `clear`, each one record, replayed along the branch |
| Knobs | `TAG_VERSION` (1), `MAX_TAG_LENGTH` (64), `MAX_TAGS_PER_SCOPE` (64), `STATUS_KEY` (`tags`) |

## Tests

```bash
npm run check     # tsc --noEmit && vitest run
```

The suite drives each extension against a fake `ExtensionAPI` (`test/harness.ts`) that records every
registration, tool call, notification and session-manager operation, and fails loudly on anything an
extension has not been written against — a half-built code path shows up as a test failure instead of a
mystery in a live session. There is no Pi runtime, no provider and no network: `searxng.ts` is tested
against a stubbed `fetch`, `test/autopilot.test.ts` holds the hop-limit surface still,
`test/session-markers.test.ts` proves the marks do not reach the model using Pi's own context builder,
`test/tags.test.ts` holds the tag grammar and the branch-relative replay of the append-only log, and
`test/packaging.test.ts` asserts each extension's whole registration
surface, so a file that quietly registers nothing cannot pass.

`npm install` pulls `@earendil-works/*` at 1.5.0 for the typecheck. When Pi updates, bump those versions
and re-run; the tests are pinned to the API surface they were written against.

## CI

[Woodpecker](https://woodpecker.dev.initialed85.cc) runs `.woodpecker/lint.yaml` (the house workflow
linter, which is the same plugin every repo on that server runs) and `.woodpecker/ci.yaml`
(`npm ci` → `tsc --noEmit` → `vitest run`).

## Not included

`herdr-agent-state.ts` is excluded on purpose. It sits in the same extensions directory, but its own header
says it is installed and overwritten by [herdr](https://github.com/initialed85/herdr)'s Pi integration. A
copy of someone else's generated file is not a source of truth, and the next `herdr` update would silently
diverge from this repo. `test/packaging.test.ts` fails if a file with those markers appears here.

## License

MIT. These are my working files; they are tuned for my models, my clusters and my habits, and the comments
say which numbers came from measurement rather than from a guess. Take what is useful.
