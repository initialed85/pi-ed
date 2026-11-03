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

describe("/queue-reload", () => {
  let pi: Awaited<ReturnType<typeof load>>;

  beforeEach(async () => {
    pi = await load();
  });

  it("registers a single command", () => {
    expect([...pi.commands.keys()]).toEqual(["queue-reload"]);
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
});
