import { beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { Text as RealText } from "@earendil-works/pi-tui";

import { createFakePi, fakeTheme, painted, type FakePi } from "./harness.ts";

const EXTENSIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../extensions");

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
  "autopilot.ts": {
    events: ["session_start", "session_shutdown", "input", "agent_before_settle"],
    tools: [],
    commands: ["autopilot"],
    flags: ["autopilot", "autopilot-max", "autopilot-goal"],
    messageRenderers: ["autopilot"],
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
  "queue-reload.ts": {
    events: [],
    tools: [],
    commands: ["queue-reload"],
    flags: [],
    messageRenderers: [],
    entryRenderers: [],
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
  const restore = { ...process.env };
  process.env = previousEnv as NodeJS.ProcessEnv;
  vi.resetModules();
  try {
    const mod = await import(path.join(EXTENSIONS_DIR, name));
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
    expect(readdirSync(EXTENSIONS_DIR).sort()).toEqual([...FILES].sort());
  });

  it("holds no file that something else manages", () => {
    // ~/.pi/agent/extensions also holds integrations that other tools write and overwrite on update
    // (herdr's pi integration is one). Those belong to their own project: copying one here means the
    // next upstream install silently diverges from this repo, and "our copy" stops being true. The
    // markers below are how such a file announces itself.
    const managed = /installed by|managed by|@ts-nocheck|INTEGRATION_ID/i;
    for (const name of FILES) {
      const head = readFileSync(path.join(EXTENSIONS_DIR, name), "utf8").slice(0, 2000);
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
