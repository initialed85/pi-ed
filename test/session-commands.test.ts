import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createFakePi, createContext } from "./harness.ts";

const MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../extensions/session-commands.ts");

/** The exact continuation prompt, pinned here as well as in the extension. */
const CONTINUE_PROMPT = `Continue the unfinished task in this session from the latest verified state. Do not simply repeat the previous answer or retry a cancelled/failed action unchanged. Identify what remains, choose a materially different next step when the last attempt failed, and either finish the task or state the specific blocker.`;

async function load() {
  vi.resetModules();
  const mod = await import(MODULE);
  const pi = createFakePi();
  mod.default(pi as any);
  return pi;
}

describe("/continue", () => {
  let pi: Awaited<ReturnType<typeof load>>;

  beforeEach(async () => {
    pi = await load();
  });

  it("sends the continuation prompt straight to the agent when idle", async () => {
    const { context } = createContext({ idle: true });
    await pi.commands.get("continue")!.handler!("", context);

    expect(pi.sentUserMessages).toEqual([{ content: CONTINUE_PROMPT, options: undefined }]);
    expect(context.ui.notifications).toHaveLength(0);
  });

  it("queues the prompt as a follow-up when the agent is still working", async () => {
    const { context } = createContext({ idle: false });
    await pi.commands.get("continue")!.handler!("", context);

    expect(pi.sentUserMessages).toEqual([
      { content: CONTINUE_PROMPT, options: { deliverAs: "followUp" } },
    ]);
    expect(context.ui.notifications.map((n) => n.message)).toEqual([
      "Continuation queued behind the current run.",
    ]);
  });

  it("appends the caller's direction to the prompt", async () => {
    const { context } = createContext({ idle: true });
    await pi.commands.get("continue")!.handler!("  check the logs first  ", context);

    const sent = pi.sentUserMessages[0]!.content as string;
    expect(sent).toBe(`${CONTINUE_PROMPT}\n\nAdditional direction: check the logs first`);
  });

  it("treats whitespace-only arguments as no direction", async () => {
    const { context } = createContext({ idle: true });
    await pi.commands.get("continue")!.handler!("   \n ", context);
    expect(pi.sentUserMessages[0]!.content).toBe(CONTINUE_PROMPT);
  });

  it("stays silent when it queues but there is no UI", async () => {
    const { context } = createContext({ idle: false, hasUI: false });
    await pi.commands.get("continue")!.handler!("", context);
    expect(context.ui.notifications).toHaveLength(0);
    expect(pi.sentUserMessages).toHaveLength(1);
  });
});

describe("/clear", () => {
  let pi: Awaited<ReturnType<typeof load>>;

  beforeEach(async () => {
    pi = await load();
  });

  it("starts a fresh session that keeps the current one as its parent and reuses its name", async () => {
    const { context, newSessionArgs } = createContext();
    pi.setSessionName("session from the pulse");
    await pi.commands.get("clear")!.handler!("", context);

    expect(context.ui.notifications.map((n) => n.message)).toEqual([
      "Starting a fresh session; the current session will remain available to resume.",
      "Fresh session started.",
    ]);

    expect(newSessionArgs).toHaveLength(1);
    const options = newSessionArgs[0]!.options;
    expect(options.parentSession).toBe("/home/user/.pi/agent/sessions/abc.jsonl");
    // The name is carried onto the new session through its setup callback, not by copying files.
    expect(typeof options.setup).toBe("function");
    await options.setup({ appendSessionInfo: (value: string) => {} });
    expect(newSessionArgs[0]!.setupCalls).toEqual(["session from the pulse"]);
  });

  it("falls back to the session file's name when the session manager has none", async () => {
    const { context, newSessionArgs } = createContext({ sessionName: undefined });
    pi.setSessionName("named by pi");
    await pi.commands.get("clear")!.handler!("", context);

    await newSessionArgs[0]!.options.setup({ appendSessionInfo: (value: string) => {} });
    expect(newSessionArgs[0]!.setupCalls).toEqual(["named by pi"]);
  });

  it("omits setup entirely when there is no name to carry over", async () => {
    const { context, newSessionArgs } = createContext({ sessionName: undefined });
    pi.setSessionName(undefined);
    await pi.commands.get("clear")!.handler!("", context);

    expect(newSessionArgs[0]!.options.setup).toBeUndefined();
    expect(newSessionArgs[0]!.options.parentSession).toBeDefined();
  });

  it("omits parentSession when the session manager reports no file", async () => {
    const { context, newSessionArgs } = createContext({ sessionFile: undefined, sessionName: "kept" });
    await pi.commands.get("clear")!.handler!("", context);

    const options = newSessionArgs[0]!.options;
    expect("parentSession" in options).toBe(false);
    expect(options.setup).toBeTypeOf("function");
  });

  it("does not report a fresh session when the new context has no UI", async () => {
    const { context } = createContext({ hasUI: false });
    await pi.commands.get("clear")!.handler!("", context);
    expect(context.ui.notifications).toHaveLength(0);
  });
});
