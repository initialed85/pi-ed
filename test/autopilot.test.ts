import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createFakePi, createContext, type FakePi, type FakeUi } from "./harness.ts";

const MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../extensions/autopilot.ts");

// Duplicated on purpose. If a test reads the constant out of the extension, it cannot catch the
// extension changing the number that the header comment and the README both promise.
const DEFAULT_MAX_HOPS = 128;
const MAX_HOPS_CEILING = 1024;

async function load(): Promise<FakePi> {
  vi.resetModules();
  const mod = await import(MODULE);
  const pi = createFakePi();
  mod.default(pi as any);
  return pi;
}

describe("autopilot hop limit", () => {
  let pi: FakePi;
  let ui: FakeUi;
  let context: any;

  /** Run `/autopilot <args>` and return what it told the user. */
  async function run(args: string): Promise<string[]> {
    const before = ui.notifications.length;
    await pi.commands.get("autopilot")!.handler!(args, context);
    return ui.notifications.slice(before).map((n) => n.message as string);
  }

  beforeEach(async () => {
    // autopilot's state is module-level, so each test needs a fresh copy of the module.
    pi = await load();
    ({ ui, context } = createContext());
  });

  it("arms with the documented default", async () => {
    expect(await run("")).toEqual([`autopilot: armed (max ${DEFAULT_MAX_HOPS} hops). Stop with /autopilot stop, Escape, or by typing.`]);
    expect(ui.statuses.get("autopilot")).toBe(`⏩ autopilot hop 0/${DEFAULT_MAX_HOPS}`);
  });

  it("reports off before it is armed", async () => {
    expect(await run("status")).toEqual(["autopilot: off. arm with /autopilot [goal]"]);
  });

  // The regression this file exists for. `/autopilot max` allowed 1024 while the flag path silently
  // clamped to 50, so `--autopilot-max 100` started a session capped at 50 hops.
  it("accepts any limit up to the ceiling, from either input", async () => {
    expect(await run(`max ${MAX_HOPS_CEILING}`)).toContain(`autopilot: hop limit is ${MAX_HOPS_CEILING}.`);
    expect(await run("max 500")).toContain("autopilot: hop limit is 500.");
    expect(await run("max 100")).toContain("autopilot: hop limit is 100.");
  });

  it("clamps above the ceiling rather than rejecting or wrapping", async () => {
    expect(await run("max 99999")).toContain(`autopilot: hop limit is ${MAX_HOPS_CEILING}.`);
  });

  it("refuses a limit that is not a positive number and keeps the current one", async () => {
    await run("max 300");
    await run("");
    for (const bad of ["max", "max 0", "max -3", "max two", "max  "]) {
      expect(await run(bad), bad).toEqual(["autopilot: usage: /autopilot max <n>"]);
    }
    expect(await run("status")).toEqual(["autopilot: armed, hop 0/300"]);
  });

  it("reads a mixed limit as its leading digits, which is parseInt and not a bug it guards", async () => {
    // Number.parseInt stops at the first non-digit, so "1.5x" is 1 and "12 hops" is 12. Recorded so
    // that if the input parser is ever tightened, this test says which behaviour changed.
    expect(await run("max 1.5x")).toContain("autopilot: hop limit is 1.");
    expect(await run("max 12 hops")).toContain("autopilot: hop limit is 12.");
  });

  it("applies the same ceiling to --autopilot-max", async () => {
    pi.setFlag("autopilot", true);
    pi.setFlag("autopilot-max", "100");
    await pi.emit("session_start", {}, context);
    expect(ui.notifications.map((n) => n.message)).toContain(`autopilot: armed (max 100 hops).`);

    ui.notifications.length = 0;
    pi.setFlag("autopilot-max", String(MAX_HOPS_CEILING * 4));
    await pi.emit("session_start", {}, context);
    expect(ui.notifications.map((n) => n.message)).toContain(`autopilot: armed (max ${MAX_HOPS_CEILING} hops).`);
  });

  it("falls back to the default when the flag is not a number", async () => {
    pi.setFlag("autopilot", true);
    pi.setFlag("autopilot-max", "lots");
    await pi.emit("session_start", {}, context);
    expect(ui.notifications.map((n) => n.message)).toContain(`autopilot: armed (max ${DEFAULT_MAX_HOPS} hops).`);
  });

  it("keeps the configured limit when arming with a goal", async () => {
    await run("max 77");
    ui.notifications.length = 0;
    expect(await run("ship the release")).toEqual([
      "autopilot: armed (max 77 hops), goal: ship the release. Stop with /autopilot stop, Escape, or by typing.",
    ]);
  });

  // What this file does NOT cover: the loop past this point. Reaching the limit needs hops to
  // accumulate, which needs a provider answering the side call, so enforcement lives in the settle
  // handler untested and is verified by hand in a real session. The limit's *value* is what drifted
  // here, and that is what these tests hold still.

  it("disarms", async () => {
    await run("max 9");
    expect(await run("stop")).toEqual(["autopilot: stopped after 0 hop(s)."]);
    expect(ui.statuses.get("autopilot")).toBeUndefined();
  });

  it("offers completions that all carry a value", async () => {
    // Not cosmetic: pi's getBestAutocompleteMatchIndex calls item.value.startsWith(prefix) unguarded,
    // so a completion item with no value takes down the TUI.
    const complete = pi.commands.get("autopilot")!.getArgumentCompletions!;
    for (const prefix of ["", "m", "max", "max ", "g", "goal ", "stop", "zzz"]) {
      const items = complete(prefix) as Array<{ value: string; label: string }> | null;
      for (const item of items ?? []) {
        expect(typeof item.value, `prefix "${prefix}" -> ${JSON.stringify(item)}`).toBe("string");
        expect(item.value.length, `prefix "${prefix}" -> ${JSON.stringify(item)}`).toBeGreaterThan(0);
      }
    }
    expect(complete("zzz")).toBeNull();
  });
});
