import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createFakePi, createContext } from "./harness.ts";

const MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../extensions/queue-reload.ts");

async function load() {
  vi.resetModules();
  const mod = await import(MODULE);
  const pi = createFakePi();
  mod.default(pi as any);
  return pi;
}

/**
 * What Pi actually hands a tool `execute()`.
 *
 * `createContext()` is command-capable: it carries `waitForIdle` and `reload`, because a command handler needs
 * them. A tool context does not have them at all - they are members of `ExtensionCommandContext`, not
 * `ExtensionToolContext` - and a tool that reaches for one gets `ctx.waitForIdle is not a function` at runtime
 * while the compiler stays silent, which is exactly how `queue_reload` shipped broken: it cast the tool context
 * to the command context, threw on the first call, and reported success. So the tool half of this extension is
 * tested against a context with those members physically removed.
 */
function createToolContext(options: Parameters<typeof createContext>[0] = {}) {
  const record = createContext(options);
  for (const member of ["waitForIdle", "reload", "newSession", "fork", "navigateTree", "switchSession", "getSystemPromptOptions"]) {
    delete record.context[member];
  }
  return { ...record, context: record.context as Omit<typeof record.context, "waitForIdle" | "reload"> };
}

const toolText = (result: { content: { text?: string }[] }) => result.content.map((part) => part.text).join(" ");

describe("/queue-reload", () => {
  let pi: Awaited<ReturnType<typeof load>>;

  beforeEach(async () => {
    pi = await load();
  });

  it("registers the command and the tool", () => {
    expect([...pi.commands.keys()]).toEqual(["queue-reload"]);
    expect([...pi.tools.keys()]).toEqual(["queue_reload"]);
  });

  it("waits for idle, then reloads", async () => {
    const { context, ui, state } = createContext();
    await pi.commands.get("queue-reload")!.handler!("", context);

    expect(ui.notifications.map((n) => n.message)).toEqual([
      "Reload queued; waiting for Pi to become idle.",
      "Pi is idle; reloading now.",
    ]);
    expect(state.reloads).toBe(1);
  });

  it("does not reload while the agent is still working, only once it settles", async () => {
    const { context, ui, state } = createContext({ idle: true });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    context.waitForIdle = async () => {
      await gate;
    };

    let done = false;
    const running = pi.commands.get("queue-reload")!.handler!("", context).then(() => {
      done = true;
    });

    await Promise.resolve();
    expect(done).toBe(false);
    expect(state.reloads).toBe(0);

    release();
    await running;
    expect(done).toBe(true);
    expect(state.reloads).toBe(1);
    expect(ui.notifications.at(-1)?.message).toBe("Pi is idle; reloading now.");
  });

  it("refuses to queue a second reload while one is pending", async () => {
    const { context, state } = createContext();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    context.waitForIdle = async () => {
      await gate;
    };

    const first = pi.commands.get("queue-reload")!.handler!("", context);
    await pi.commands.get("queue-reload")!.handler!("", context);

    expect(context.ui.notifications.map((n) => n.message)).toEqual([
      "Reload queued; waiting for Pi to become idle.",
      "A reload is already queued; it will run when Pi is idle.",
    ]);

    release();
    await first;
    expect(state.reloads).toBe(1);
  });

  it("clears the flag when the wait is cancelled, so a later call can queue again", async () => {
    const { context, state } = createContext();
    context.waitForIdle = async () => {
      throw new Error("aborted");
    };

    await pi.commands.get("queue-reload")!.handler!("", context);
    expect(state.reloads).toBe(0);
    expect(context.ui.notifications.map((n) => n.message)).toEqual([
      "Reload queued; waiting for Pi to become idle.",
      "Queued reload cancelled: aborted",
    ]);
    expect(context.ui.notifications.at(-1)?.level).toBe("error");

    // The failed wait must not leave the extension thinking a reload is still pending.
    context.waitForIdle = async () => {};
    await pi.commands.get("queue-reload")!.handler!("", context);
    expect(state.reloads).toBe(1);
  });

  it("still reloads with no UI, and stays silent", async () => {
    const { context, ui, state } = createContext({ hasUI: false });
    await pi.commands.get("queue-reload")!.handler!("", context);
    expect(ui.notifications).toHaveLength(0);
    expect(state.reloads).toBe(1);
  });

  it("does not report a cancelled wait as a reload when there is no UI", async () => {
    const { context, ui, state } = createContext({ hasUI: false });
    context.waitForIdle = async () => {
      throw new Error("cancelled");
    };
    await pi.commands.get("queue-reload")!.handler!("", context);
    expect(ui.notifications).toHaveLength(0);
    expect(state.reloads).toBe(0);
  });

  it("reports a reload that throws instead of going quiet about it", async () => {
    const { context, ui, state, calls } = createContext({ reloadError: "extension runtime rejected the reload" });
    await pi.commands.get("queue-reload")!.handler!("", context);
    expect(state.reloads).toBe(0);
    expect(calls.map((c: { name: string }) => c.name)).toContain("reload"); // the attempt happened; Pi is the one that refused
    expect(ui.notifications.at(-1)).toEqual({
      message: "Reload failed: extension runtime rejected the reload",
      level: "error",
    });
  });
});

describe("queue_reload (the tool)", () => {
  let pi: Awaited<ReturnType<typeof load>>;

  beforeEach(async () => {
    pi = await load();
  });

  const call = async (context: ReturnType<typeof createToolContext>["context"]) =>
    pi.tools.get("queue_reload")!.execute!("call-1", {}, undefined, undefined, context);

  it("never touches waitForIdle or reload, because its context has neither", async () => {
    const tool = createToolContext();
    // The old implementation did `ctx as unknown as ReloadContext` and called them, which is a runtime TypeError
    // with no compile-time warning. Asserting on the returned text is not enough: a tool that threw here would
    // fail before the assertion, and a tool that returned a lie would pass it.
    expect(tool.context.waitForIdle).toBeUndefined();
    expect(tool.context.reload).toBeUndefined();

    const result = await call(tool.context);
    expect(tool.state.reloads).toBe(0);
    expect(tool.ui.notifications).toHaveLength(0);
    expect(toolText(result)).toContain("Reload queued");
  });

  it("says plainly what will happen, and does not claim a reload has been queued on the command path", async () => {
    const tool = createToolContext();
    expect(toolText(await call(tool.context))).toBe(
      "Reload queued. Pi reloads its extensions when this run settles.",
    );
    // Nothing has been dispatched yet, so it is not true that a reload is in flight.
    expect(pi.sentUserMessages).toHaveLength(0);
    expect(tool.state.reloads).toBe(0);
  });

  it("dispatches this extension's own command when the run settles, and that is what reloads", async () => {
    const tool = createToolContext();
    await call(tool.context);

    await pi.emit("agent_settled", {}, tool.context);

    expect(pi.sentUserMessages).toEqual([{ content: "/queue-reload", options: { expandPromptTemplates: true } }]);

    // Pi then runs a command handler, in a context that does have the session-control members. The tool path is
    // only honest if this hop exists; before the fix it did not, and every tool call was a no-op that reported
    // success.
    const command = createContext();
    await pi.commands.get("queue-reload")!.handler!("", command.context);
    expect(command.state.reloads).toBe(1);
  });

  it("sends as a command rather than as a prompt, because a plain user message would reach the model", async () => {
    const tool = createToolContext();
    await call(tool.context);
    await pi.emit("agent_settled", {}, tool.context);
    const sent = pi.sentUserMessages[0]!;
    expect(sent.options?.expandPromptTemplates).toBe(true);
    expect(sent.options?.deliverAs).toBeUndefined();
  });

  it("does not dispatch anything when no reload was requested", async () => {
    const tool = createToolContext();
    await pi.emit("agent_settled", {}, tool.context);
    expect(pi.sentUserMessages).toHaveLength(0);
    expect(tool.state.reloads).toBe(0);
  });

  it("does not dispatch twice for one request, but queues again after the dispatch", async () => {
    const tool = createToolContext();
    await call(tool.context);
    await pi.emit("agent_settled", {}, tool.context);
    await pi.emit("agent_settled", {}, tool.context);
    expect(pi.sentUserMessages).toHaveLength(1);

    // The request flag is cleared by the dispatch, so a later turn can ask again.
    expect(toolText(await call(tool.context))).toContain("Reload queued");
    await pi.emit("agent_settled", {}, tool.context);
    expect(pi.sentUserMessages).toHaveLength(2);
  });

  it("distinguishes a second call from a first one, which is how two pending reloads got believed", async () => {
    const tool = createToolContext();
    const first = toolText(await call(tool.context));
    const second = toolText(await call(tool.context));
    expect(first).not.toBe(second);
    expect(second).toBe("A reload is already requested; it fires when this run settles.");
    expect(pi.sentUserMessages).toHaveLength(0); // still nothing dispatched until the run settles
  });

  it("says when the command path is already mid-wait rather than pretending it queued a new one", async () => {
    const command = createContext();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    command.context.waitForIdle = async () => {
      await gate;
    };
    const running = pi.commands.get("queue-reload")!.handler!("", command.context);

    const tool = createToolContext();
    expect(toolText(await call(tool.context))).toBe(
      "A reload is already queued by /queue-reload; it fires when Pi becomes idle.",
    );
    expect(pi.sentUserMessages).toHaveLength(0);

    release();
    await running;
    expect(command.state.reloads).toBe(1);
  });
});
