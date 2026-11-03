# pi-ed

Six [Pi](https://github.com/earendil-works/pi) extensions I wrote to stop my agents doing the things
that were wasting my time, plus the tests that keep them honest.

They live in `~/.pi/agent/extensions/` on my machines. This repository is the source of truth: the
copies here are what I edit, and the installed ones are the same bytes.

```
extensions/   the six extensions
test/         vitest suite, 101 tests, no Pi runtime and no network needed
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
| Knobs | `DEFAULT_MAX_HOPS` (128; `/autopilot max` accepts up to 1024, the positional form of `arm()` clamps to 50), `SIDE_CALL_MAX_TOKENS` (600), `CONTEXT_STOP_PERCENT` (85), `SHAPE_STOP` (0.7) |

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

| | |
| --- | --- |
| Knobs | `SUMMARY_OUTPUT_TOKENS` (8192), `SUMMARY_TARGET_TOKENS` (4000), `RETRY_POLICY` (`maxRetries: 2`, `baseDelayMs: 2000`, `maxAgentDelayMs: 15000`) |

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

## Tests

```bash
npm run check     # tsc --noEmit && vitest run
```

The suite drives each extension against a fake `ExtensionAPI` (`test/harness.ts`) that records every
registration, tool call, notification and session-manager operation, and fails loudly on anything an
extension has not been written against — a half-built code path shows up as a test failure instead of a
mystery in a live session. There is no Pi runtime, no provider and no network: `searxng.ts` is tested
against a stubbed `fetch`, and `test/packaging.test.ts` asserts each extension's whole registration
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
