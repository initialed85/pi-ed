import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createFakePi, createContext, type FakeContext, type FakePi } from "./harness.ts";

const MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../extensions/loop-guard.ts");

const CWD = "/work";

async function load() {
  vi.resetModules();
  const mod = await import(MODULE);
  const pi = createFakePi();
  mod.default(pi as any);
  return pi;
}

interface ToolOutcome {
  id?: string;
  tool?: string;
  input?: unknown;
  cwd?: string;
  output?: string;
  isError?: boolean;
  parentToolCallId?: string;
}

let nextId = 0;

/**
 * One tool call through the guard, exactly as Pi would drive it: the `tool_call` event first
 * (whose verdict the test gets back), then the `turn_end` that carries the result and feeds the
 * guard's history.
 */
async function drive(pi: FakePi, context: any, options: ToolOutcome = {}) {
  const id = options.id ?? `call-${nextId++}`;
  const tool = options.tool ?? "bash";
  const [verdict] = await pi.emit(
    "tool_call",
    {
      type: "tool_call",
      toolCallId: id,
      toolName: tool,
      input: options.input ?? { command: "echo hi" },
      ...(options.parentToolCallId ? { parentToolCallId: options.parentToolCallId } : {}),
    },
    { ...context, cwd: options.cwd ?? CWD },
  );

  await pi.emit(
    "turn_end",
    {
      type: "turn_end",
      turnIndex: 0,
      message: { role: "assistant", content: [] },
      messageEntryId: `entry-${id}`,
      toolResults: [
        {
          toolCallId: id,
          toolName: tool,
          content: [{ type: "text", text: options.output ?? "ok" }],
          isError: options.isError ?? false,
        },
      ],
      toolResultEntryIds: [`result-${id}`],
    },
    { ...context, cwd: options.cwd ?? CWD },
  );

  return verdict;
}

/** A text-only turn (no tool results), which is what the repetition detector watches. */
async function say(pi: FakePi, context: any, text: string) {
  const [result] = await pi.emit(
    "turn_end",
    {
      type: "turn_end",
      turnIndex: 0,
      message: { role: "assistant", content: [{ type: "text", text }] },
      messageEntryId: `entry-${nextId++}`,
      toolResults: [],
      toolResultEntryIds: [],
    },
    context,
  );
  return result;
}

describe("loop-guard", () => {
  let pi: FakePi;
  let context: FakeContext;

  beforeEach(async () => {
    pi = await load();
    context = createContext({ cwd: CWD }).context;
  });

  it("watches the lifecycle it needs", () => {
    expect([...new Set(pi.lifecycleEvents)].sort()).toEqual([
      "input",
      "session_start",
      "session_tree",
      "tool_call",
      "turn_end",
    ]);
  });

  it("lets a first call through", async () => {
    expect(await drive(pi, context)).toBeUndefined();
  });

  it("blocks the third identical call when the second produced the same failure", async () => {
    expect(await drive(pi, context, { input: { command: "npm test" }, output: "command exited with code 1" })).toBeUndefined();
    expect(await drive(pi, context, { input: { command: "npm test" }, output: "command exited with code 1" })).toBeUndefined();
    const blocked = await drive(pi, context, { input: { command: "npm test" }, output: "command exited with code 1" });

    expect(blocked.block).toBe(true);
    expect(blocked.terminate).toBe(false);
    expect(blocked.reason).toContain("Loop guard blocked this bash call");
    expect(blocked.reason).toContain("the last 1-call sequence repeated twice with the same result,");
    expect(blocked.reason).toContain("Repeated failure evidence: command exited with code 1");
    expect(blocked.reason).toContain("Do not replay it unchanged");
  });

  it("does not block a repeated call that kept succeeding", async () => {
    // Deliberate: two identical successes are not a loop, only a loop that is failing.
    for (let i = 0; i < 6; i++) {
      expect(await drive(pi, context, { input: { command: "git status" }, output: "nothing to commit" })).toBeUndefined();
    }
  });

  it("blocks on an error result even when the text carries no failure marker", async () => {
    await drive(pi, context, { input: { command: "deploy" }, output: "nope", isError: true });
    await drive(pi, context, { input: { command: "deploy" }, output: "nope", isError: true });
    const blocked = await drive(pi, context, { input: { command: "deploy" }, output: "nope", isError: true });
    expect(blocked.block).toBe(true);
    // The evidence is the whole normalised output when there is no single error line to quote.
    expect(blocked.reason).toContain("Repeated failure evidence: nope");
  });

  it("does not block when the result changes", async () => {
    await drive(pi, context, { input: { command: "npm test" }, output: "command exited with code 1" });
    await drive(pi, context, { input: { command: "npm test" }, output: "command exited with code 2" });
    expect(await drive(pi, context, { input: { command: "npm test" }, output: "command exited with code 2" })).toBeUndefined();
  });

  it("does not block when the input changes", async () => {
    await drive(pi, context, { input: { command: "npm test" }, output: "command exited with code 1" });
    await drive(pi, context, { input: { command: "npm test" }, output: "command exited with code 1" });
    expect(
      await drive(pi, context, { input: { command: "npm test -- foo" }, output: "command exited with code 1" }),
    ).toBeUndefined();
  });

  it("folds sleep and timeout durations, so waiting longer is not a new attempt", async () => {
    const commands = [
      "sleep 5; curl -s localhost:8080/healthz",
      "sleep 30; curl -s localhost:8080/healthz",
      "sleep 120s; curl -s localhost:8080/healthz",
      "timeout 5 curl -s localhost:8080/healthz; sleep 3; curl -s localhost:8080/healthz",
    ];
    await drive(pi, context, { input: { command: commands[0] }, output: "connection refused" });
    await drive(pi, context, { input: { command: commands[1] }, output: "connection refused" });
    const blocked = await drive(pi, context, { input: { command: commands[2] }, output: "connection refused" });
    expect(blocked.block).toBe(true);
    // The reason names the failure it saw, which is what the agent has to act on.
    expect(blocked.reason).toContain("Repeated failure evidence: connection refused");
  });

  it("normalises timing noise in the result, so a slow retry is the same loop", async () => {
    const outputs = [
      "\u001b[31mFAIL\u001b[0m curl: (7) Failed to connect to localhost port 8080 after 12 ms\nlisten EADDRINUSE from 127.0.0.1 port 41234\nTook 1.2s\nTPS 12.5",
      "\u001b[31mFAIL\u001b[0m curl: (7) Failed to connect to localhost port 8080 after 3.9 seconds\nlisten EADDRINUSE from 127.0.0.1 port 55111\nTook 3.9s\nTPS 9.1",
      "\u001b[31mFAIL\u001b[0m curl: (7) Failed to connect to localhost port 8080 after 12000 ms\nlisten EADDRINUSE from 127.0.0.1 port 39999\nTook 12.0s\nTPS 3.4",
    ];
    for (const output of outputs.slice(0, 2)) {
      await drive(pi, context, { input: { command: "npm run serve" }, output });
    }
    const blocked = await drive(pi, context, { input: { command: "npm run serve" }, output: outputs[2]! });
    expect(blocked.block).toBe(true);
  });

  it("treats a second block of the same loop as terminal", async () => {
    const input = { command: "kubectl get pods" };
    const output = "error: the server doesn't have a resource type \"pod\"";
    await drive(pi, context, { input, output, isError: true });
    await drive(pi, context, { input, output, isError: true });
    expect((await drive(pi, context, { input, output, isError: true })).terminate).toBe(false);
    // The blocked call is not recorded in the history, so the same shape is still a loop.
    const second = await drive(pi, context, { input, output, isError: true });
    expect(second.block).toBe(true);
    expect(second.terminate).toBe(true);
    expect(context.ui.notifications.map((n) => n.message)).toContain(
      "Loop guard stopped a repeated tool-call loop; the agent needs a different approach.",
    );
  });

  it("ignores tool calls made by another tool", async () => {
    const input = { command: "ls" };
    await drive(pi, context, { input, parentToolCallId: "parent-1" });
    await drive(pi, context, { input, parentToolCallId: "parent-1" });
    await drive(pi, context, { input, parentToolCallId: "parent-1" });
    expect(context.ui.notifications).toHaveLength(0);
  });

  it("keeps the working directory in the fingerprint", async () => {
    const input = { command: "npm test" };
    const output = "command exited with code 1";
    await drive(pi, context, { input, cwd: "/a", output });
    await drive(pi, context, { input, cwd: "/a", output });
    // Same command, same output, different project: not the same loop.
    expect(await drive(pi, context, { input, cwd: "/b", output })).toBeUndefined();
  });

  it("does not care about key order in non-bash inputs", async () => {
    const a = { path: "src/index.ts", offset: 1 };
    const b = { offset: 1, path: "src/index.ts" };
    const output = "command exited with code 1";
    await drive(pi, context, { tool: "read", input: a, output });
    await drive(pi, context, { tool: "read", input: b, output });
    expect((await drive(pi, context, { tool: "read", input: a, output })).block).toBe(true);
  });

  it("detects a two-call cycle", async () => {
    const failure = "command exited with code 1";
    await drive(pi, context, { tool: "read", input: { path: "a.ts" }, output: failure });
    await drive(pi, context, { tool: "edit", input: { path: "a.ts" }, output: "done" });
    await drive(pi, context, { tool: "read", input: { path: "a.ts" }, output: failure });
    await drive(pi, context, { tool: "edit", input: { path: "a.ts" }, output: "done" });
    const blocked = await drive(pi, context, { tool: "read", input: { path: "a.ts" }, output: failure });
    expect(blocked.block).toBe(true);
    expect(blocked.reason).toContain("the last 2-call sequence repeated twice with the same results,");
  });

  it("forgets the loop when the user takes over", async () => {
    const input = { command: "npm test" };
    const output = "command exited with code 1";
    await drive(pi, context, { input, output });
    await drive(pi, context, { input, output });
    await pi.emit("input", { type: "input", text: "try this instead", source: "user" }, context);
    expect(await drive(pi, context, { input, output })).toBeUndefined();
  });

  for (const event of ["session_start", "session_tree"]) {
    it(`forgets the loop on ${event}`, async () => {
      const input = { command: "npm test" };
      const output = "command exited with code 1";
      await drive(pi, context, { input, output });
      await drive(pi, context, { input, output });
      await pi.emit(event, { type: event }, context);
      expect(await drive(pi, context, { input, output })).toBeUndefined();
    });
  }

  it("caps the history it remembers", async () => {
    const input = { command: "npm test" };
    const output = "command exited with code 1";
    await drive(pi, context, { input, output });
    await drive(pi, context, { input, output });
    // 32 observations are kept; anything older cannot be part of a cycle.
    for (let i = 0; i < 32; i++) {
      await drive(pi, context, { tool: "read", input: { path: `f-${i}.ts` }, output: `x${i}` });
    }
    expect(await drive(pi, context, { input, output })).toBeUndefined();
  });

  describe("text-only repetition", () => {
    const REPLY =
      "The deployment is still failing because the image pull error persists and the pod has not come up; I have checked the events and the logs and the situation is unchanged from last time.";

    it("nudges on the third near-duplicate reply", async () => {
      expect(await say(pi, context, REPLY)).toBeUndefined();
      expect(await say(pi, context, REPLY)).toBeUndefined();
      const third = await say(pi, context, REPLY);

      expect(third.continue).toBe(true);
      expect(third.entries).toHaveLength(1);
      expect(third.entries[0]).toMatchObject({
        type: "custom_message",
        customType: "loop-guard",
        display: true,
      });
      expect(third.entries[0].content).toContain("near-duplicates");
      expect(third.entries[0].content).toContain(REPLY.toLowerCase().slice(0, 40));
    });

    it("reports once after the nudge, then stops repeating itself", async () => {
      await say(pi, context, REPLY);
      await say(pi, context, REPLY);
      await say(pi, context, REPLY);
      const fourth = await say(pi, context, REPLY);
      expect(fourth).toBeUndefined();
      expect(context.ui.notifications.map((n) => n.message)).toEqual([
        "Loop guard: the text-only repetition continued after its one automatic nudge.",
      ]);
      const fifth = await say(pi, context, REPLY);
      expect(fifth).toBeUndefined();
      expect(context.ui.notifications).toHaveLength(1);
    });

    it("does not fire on genuinely different replies", async () => {
      await say(pi, context, REPLY);
      await say(pi, context, REPLY);
      expect(
        await say(
          pi,
          context,
          "Different angle: the storage class is missing, so I am creating it now and then re-running the rollout.",
        ),
      ).toBeUndefined();
    });

    it("ignores short replies", async () => {
      for (let i = 0; i < 5; i++) await say(pi, context, "still failing");
      expect(context.ui.notifications).toHaveLength(0);
    });

    it("counts only text parts of the assistant message", async () => {
      for (let i = 0; i < 3; i++) {
        const [result] = await pi.emit(
          "turn_end",
          {
            type: "turn_end",
            turnIndex: 0,
            message: {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "same reasoning over and over" },
                { type: "toolCall", id: "t", name: "bash", arguments: {} },
                { type: "text", text: "The deployment is still failing because the image pull error persists and the pod has not come up; I have checked the events and the logs and the situation is unchanged from last time." },
              ],
            },
            messageEntryId: `entry-${nextId++}`,
            toolResults: [],
            toolResultEntryIds: [],
          },
          context,
        );
        if (i === 2) expect(result).toBeDefined();
      }
    });

    it("clears the text history when a turn runs tools", async () => {
      await say(pi, context, REPLY);
      await say(pi, context, REPLY);
      await drive(pi, context, { input: { command: "git status" }, output: "clean" });
      expect(await say(pi, context, REPLY)).toBeUndefined();
    });
  });
});
