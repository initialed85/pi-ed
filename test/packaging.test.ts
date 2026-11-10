import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { Text as RealText } from "@earendil-works/pi-tui";

import { createFakePi, fakeTheme, painted, type FakePi } from "./harness.ts";

const EXTENSIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../extensions");
/** Parked extensions are compiled, tested and swept against the live store, but are not in Pi's load path. */
const PARKED_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../parked");
const PARKED = ["memory.ts"];

/**
 * The contract that holds for every extension in this directory, and the reason the directory can
 * be treated as a Pi package at all: each file is a module whose default export is
 * `function (pi: ExtensionAPI)`, and Pi discovers it by globbing this directory.
 *
 * Names are pinned here rather than discovered, so a file that disappears from the directory fails
 * the same way a file that never existed would.
 */
interface Surface {
  events: readonly string[];
  tools: readonly string[];
  commands: readonly string[];
  flags: readonly string[];
  messageRenderers: readonly string[];
  /** TUI-only renderers for custom entries, which are the ones the model never sees. */
  entryRenderers: readonly string[];
}

const EXPECTED: Record<string, Surface> = {
  "auto-resume.ts": {
    // It has to see a run begin, see each tool finish, see the run settle and see the process stop:
    // that is the evidence a later resume reads, and none of it can be reconstructed afterwards.
    events: ["session_start", "agent_start", "tool_result", "agent_settled", "session_shutdown"],
    tools: [],
    commands: ["auto-resume"],
    flags: ["auto-resume-off"],
    // The resume prompt is a message, so the model reads it. The markers are entries, so the model
    // never sees them and the transcript does not fill up with bookkeeping.
    messageRenderers: ["auto-resume-prompt"],
    entryRenderers: [],
  },
  "autopilot.ts": {
    events: ["session_start", "session_shutdown", "input", "agent_before_settle"],
    tools: [],
    commands: ["autopilot"],
    flags: ["autopilot", "autopilot-max", "autopilot-goal"],
    messageRenderers: ["autopilot"],
    entryRenderers: [],
  },
  "cognee.ts": {
    // A pure client: nothing here is lifecycle. It speaks when an agent asks, and asks nothing of the session.
    events: [],
    tools: ["memory_remember", "memory_recall"],
    commands: ["cognee"],
    flags: [],
    messageRenderers: [],
    entryRenderers: [],
  },
  "compaction-summary-guard.ts": {
    events: ["session_before_compact"],
    tools: [],
    commands: [],
    flags: [],
    messageRenderers: [],
    entryRenderers: [],
  },
  "loop-guard.ts": {
    events: ["input", "session_start", "session_tree", "tool_call", "turn_end"],
    tools: [],
    commands: [],
    flags: [],
    messageRenderers: [],
    entryRenderers: [],
  },
  "memory.ts": {
    // It has to see a session arrive, see each turn finish, see the agent go idle, see the harness about to throw
    // context away, and see the process stop. Those are the write points and the dream triggers, and none of them can
    // be inferred from the others. agent_start is here to cancel a pending dream rather than to record anything.
    events: ["session_start", "turn_end", "agent_start", "agent_settled", "session_before_compact", "session_shutdown"],
    tools: ["memory_search", "memory_dream"],
    commands: ["memory"],
    flags: [],
    // The dream instruction is a message the model reads. Nothing here is an entry renderer: the raw history lives in
    // Postgres, not in the session file, so there is no custom entry to draw.
    messageRenderers: ["memory:dream"],
    entryRenderers: [],
  },
  "queue-reload.ts": {
    events: [],
    tools: [],
    commands: ["queue-reload"],
    flags: [],
    messageRenderers: [],
    entryRenderers: [],
  },
  "schedule.ts": {
    events: ["session_start", "session_info_changed", "session_shutdown"],
    tools: ["schedule_jobs"],
    commands: ["at", "cron", "every", "schedule"],
    flags: ["schedules-off", "schedule-name", "schedule-tz", "schedule-tick"],
    // Two render paths on purpose: the injected prompt (a message the model sees) and the audit line (an
    // entry only the transcript shows).
    messageRenderers: ["schedule-run"],
    entryRenderers: ["schedule"],
  },
  "searxng.ts": {
    events: [],
    // The whole point of this file is that it replaces the built-in tool of the same name.
    tools: ["web_search"],
    commands: [],
    flags: [],
    messageRenderers: [],
    entryRenderers: [],
  },
  "session-commands.ts": {
    events: [],
    tools: [],
    commands: ["continue", "clear"],
    flags: [],
    messageRenderers: [],
    entryRenderers: [],
  },
  "session-markers.ts": {
    events: [],
    tools: [],
    commands: ["comment", "score"],
    flags: [],
    messageRenderers: [],
    // The one string the analysis pass greps for in the session JSONL.
    entryRenderers: ["model-marker"],
  },
  "turn-stats.ts": {
    // The row is written from a lifecycle context, so these are what it has to listen to in order to
    // time a provider call and name the model that answered it. agent_end rather than turn_end
    // because it is the sweep for a turn that ended without ever producing an answer.
    events: [
      "session_start",
      "session_tree",
      "turn_start",
      "before_provider_request",
      "after_provider_response",
      "provider_stream_event",
      "message_end",
      "turn_end",
      "agent_end",
    ],
    tools: [],
    commands: [],
    flags: [],
    messageRenderers: [],
    // A session entry, not a custom message: entries stay out of the model's context.
    entryRenderers: ["turn-stats"],
  },
  "tags.ts": {
    // Not bookkeeping for its own sake: the footer has to be rebuilt when the branch changes, because
    // tags are branch-relative and /tree and /resume move the branch out from under it.
    events: ["session_start", "session_tree"],
    tools: [],
    commands: ["tag"],
    flags: [],
    messageRenderers: [],
    // The one string the analysis pass greps for in the session JSONL.
    entryRenderers: ["tag"],
  },
} as const;

const FILES = Object.keys(EXPECTED);

/**
 * Where a file lives decides whether Pi loads it, and that is the whole difference between these two directories -
 * `pi.extensions` points at `./extensions` and nothing else, so a file moved to `parked/` stops reaching sessions
 * without anything having to remember to exclude it.
 */
const dirFor = (name: string): string => (PARKED.includes(name) ? PARKED_DIR : EXTENSIONS_DIR);

/**
 * Some extensions are inert unless they are configured, and "inert" is the behaviour worth pinning - test/memory.test.ts
 * asserts it. The packaging contract is about what an extension registers when it *is* configured, so those files are
 * loaded with a placeholder that configures them. No credentials here: this DSN points at a closed port.
 */
const LOAD_ENV: Record<string, Record<string, string>> = {
  "memory.ts": { PI_MEMORY_DSN: "postgres://packaging:packaging@127.0.0.1:1/packaging" },
  // A key that is not a key, set the way a laptop would set it. The pod path (a mounted file) is exercised in
  // test/cognee.test.ts against a scratch file, so nothing here reads a real Secret.
  "cognee.ts": { COGNEE_API_KEY: "packaging-not-a-real-key-000000000000000000" },
};

function loadModuleEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  // A developer's own herdr session sets these; the extensions here must not read them.
  delete env.HERDR_ENV;
  delete env.HERDR_SOCKET_PATH;
  delete env.HERDR_PANE_ID;
  return env;
}

async function load(name: string): Promise<FakePi> {
  const previousEnv = loadModuleEnv();
  Object.assign(previousEnv, LOAD_ENV[name] ?? {});
  const restore = { ...process.env };
  process.env = previousEnv as NodeJS.ProcessEnv;
  vi.resetModules();
  try {
    const mod = await import(path.join(dirFor(name), name));
    const pi = createFakePi();
    expect(typeof mod.default, `${name} default export`).toBe("function");
    mod.default(pi as any);
    return pi;
  } finally {
    process.env = restore;
  }
}

describe("extensions directory", () => {
  it("contains exactly the files this suite knows about", () => {
    expect(readdirSync(EXTENSIONS_DIR).sort()).toEqual(FILES.filter((name) => !PARKED.includes(name)).sort());
  });

  it("keeps the parked set parked, and says why in the file Pi will not load", () => {
    // The reason matters as much as the state here: a directory someone cannot explain gets moved back "while we are
    // in there", and the memory extension is parked because a fleet is being cut over to cognee, not because it broke.
    expect(readdirSync(PARKED_DIR).filter((name) => name.endsWith(".ts")).sort()).toEqual([...PARKED].sort());
    const why = readFileSync(path.join(PARKED_DIR, "README.md"), "utf8");
    expect(why).toContain("cognee");
    for (const name of PARKED) {
      expect(existsSync(path.join(EXTENSIONS_DIR, name)), `${name} is in extensions/ and therefore loaded`).toBe(false);
      expect(readFileSync(path.join(PARKED_DIR, name), "utf8"), name).toContain("PARKED");
    }
  });

  it("holds no file that something else manages", () => {
    // ~/.pi/agent/extensions also holds integrations that other tools write and overwrite on update
    // (herdr's pi integration is one). Those belong to their own project: copying one here means the
    // next upstream install silently diverges from this repo, and "our copy" stops being true. The markers
    // below are how such a file announces itself.
    const managed = /installed by|managed by|@ts-nocheck|INTEGRATION_ID/i;
    for (const name of FILES) {
      const head = readFileSync(path.join(dirFor(name), name), "utf8").slice(0, 2000);
      expect(head.match(managed), name).toBeNull();
    }
  });

  for (const name of FILES) {
    describe(name, () => {
      let pi: FakePi;

      beforeEach(async () => {
        pi = await load(name);
      });

      it("registers the expected surface", () => {
        expect([...pi.tools.keys()].sort()).toEqual([...EXPECTED[name].tools].sort());
        expect([...pi.commands.keys()].sort()).toEqual([...EXPECTED[name].commands].sort());
        expect([...pi.flags.keys()].sort()).toEqual([...EXPECTED[name].flags].sort());
        expect([...pi.messageRenderers.keys()].sort()).toEqual([...EXPECTED[name].messageRenderers].sort());
        expect([...pi.entryRenderers.keys()].sort()).toEqual([...EXPECTED[name].entryRenderers].sort());
        expect([...new Set(pi.lifecycleEvents)].sort()).toEqual([...EXPECTED[name].events].sort());
      });

      it("has a description and a handler for every command", () => {
        for (const [command, options] of pi.commands) {
          expect(typeof options.handler, `${name}: ${command} handler`).toBe("function");
          expect(options.description, `${name}: ${command} description`).toBeTruthy();
        }
      });

      it("has a complete tool definition for every tool", () => {
        for (const [tool, definition] of pi.tools) {
          expect(definition.label, `${name}: ${tool} label`).toBeTruthy();
          expect(definition.description, `${name}: ${tool} description`).toBeTruthy();
          expect(definition.parameters, `${name}: ${tool} parameters`).toBeDefined();
          expect(typeof definition.execute, `${name}: ${tool} execute`).toBe("function");
        }
      });

      it("only registers events that exist in Pi's lifecycle", () => {
        // Not a copy of the upstream list: a typo'd event name is accepted by Pi and silently never
        // fires, which is the failure worth catching here.
        const known = new Set([
          "session_start",
          "session_info_changed",
          "session_before_switch",
          "session_before_fork",
          "session_before_compact",
          "session_compact",
          "session_compact_failed",
          "session_shutdown",
          "session_tree",
          "session_before_tree",
          "input",
          "agent_start",
          "agent_before_settle",
          "agent_settled",
          "agent_end",
          "before_agent_start",
          "turn_start",
          "turn_end",
          "tool_call",
          "tool_result",
          "tool_execution_start",
          "tool_execution_update",
          "tool_execution_end",
          "message_start",
          "message_update",
          "message_end",
          "context",
          "user_bash",
          "model_select",
          // The provider-facing events. They are the only place a client can see response headers, and
          // the only honest way to time a call and hear which model a stream actually used.
          "before_provider_request",
          "after_provider_response",
          "provider_stream_event",
        ]);
        for (const event of new Set(pi.lifecycleEvents)) {
          expect(known.has(event), `${name}: unknown event "${event}"`).toBe(true);
        }
      });
    });
  }
});

describe("harness", () => {
  it("labels theme fragments so renderer tests can see which colour produced them", () => {
    expect(fakeTheme.fg("accent", "x") + fakeTheme.bold("y")).toBe("[accent]x[/accent]*y*");
  });

  it("reads real pi-tui Text/Box trees", () => {
    // The extensions render with the real Text/Box classes, so painted() has to work against them
    // rather than against a stub of the thing being rendered.
    expect(painted(new RealText("hello", 0, 0))).toBe("hello");
  });
});

describe("ci shape", () => {
  // 2026-11-08: four pi-ed pipelines in a row died with exit 134 and `Ineffective mark-compacts near heap limit`
  // while every home-ops pipeline passed. No test was broken. Woodpecker's kubernetes backend sized the step pod at
  // cpu 1 / 512Mi, os.cpus() inside that pod reported the host node's cores, vitest forked per host core, and the
  // suite's measured peak (~650 MB of vitest main + forks + the npm wrapper) walked straight through the limit. An
  // OOM and a failing test look identical from a badge, so the two decisions that fixed it are pinned here rather
  // than left as configuration someone can tidy away.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  it("pins the worker count instead of letting it follow the host's cores", () => {
    const config = readFileSync(path.join(root, "vitest.config.ts"), "utf8");
    expect(config).toMatch(/maxWorkers:\s*\d+/);
    expect(config, "os.cpus() reports the node a CI pod landed on, not the quota that pod is limited to").not.toMatch(/maxWorkers:[^\n]*os\.cpus\(/);
  });

  it("gives the test step a pod big enough for the suite it runs", () => {
    const ci = readFileSync(path.join(root, ".woodpecker", "ci.yaml"), "utf8");
    const testStep = ci.slice(ci.indexOf("- name: test"), ci.indexOf("- name: package-shape"));
    expect(testStep, "the k8s backend only takes resources under backend_options.kubernetes").toContain("backend_options:");
    // Comments are stripped before matching rather than excluded by the pattern. A key and its value being separated
    // by an explanation is normal YAML and the thing this repository is made of; a guard that forbids it would punish
    // documentation, which is a worse outcome than a slightly looser match.
    const declarations = testStep.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
    const limit = /limits:\s*memory:\s*(\d+)Mi/.exec(declarations);
    expect(limit, "a step whose memory limit is inherited from a backend default is a step that fails as an OOM").toBeTruthy();
    // Measured peak with maxWorkers 2 is ~390 MB; the pod limit also has to cover the heap caps the step hands out.
    expect(Number(limit![1]), "measured peak RSS of the test step is ~390 MB at node 22, with two 768 MB heap caps").toBeGreaterThanOrEqual(1024);
  });
});
