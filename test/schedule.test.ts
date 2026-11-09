import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { callTool, createFakePi, createContext, fakeTheme, type FakePi } from "./harness.ts";
import {
  formatDuration,
  isoUtc,
  isValidZone,
  nextOccurrence,
  occurrenceKey,
  parseCron,
  parseWhen,
  readDeliverAs,
  previousOccurrence,
  wallToInstant,
  type Schedule,
} from "../extensions/schedule.ts";

const MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../extensions/schedule.ts");
const ENTRY_TYPE = "schedule";
const RUN_TYPE = "schedule-run";

// The two zones this extension exists for. Perth is the repository's own clock (no DST anywhere in its
// year); Sydney is the one that proves the wall-clock arithmetic was done rather than approximated.
const PERTH = "Australia/Perth";
const SYDNEY = "Australia/Sydney";
const HOUR = 3_600_000;

const T = (iso: string): number => Date.parse(iso);
const cron = (expression: string, tz: string): Schedule => ({ kind: "cron", cron: expression, tz });
const every = (everyMs: number, anchor: number): Schedule => ({ kind: "interval", everyMs, anchor, tz: PERTH });

/** A wall time as a reader would write it, for the assertions that are about local time. */
function wall(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));
}

// --- the calendar ---------------------------------------------------------

describe("wall-clock arithmetic", () => {
  it("maps a wall time to the instant it means in that zone", () => {
    // Perth is UTC+8 all year, so 02:00 Perth on 6 Nov is 18:00Z on 5 Nov.
    expect(wallToInstant({ y: 2026, mo: 11, d: 6, h: 2, mi: 0 }, PERTH)).toBe(T("2026-11-05T18:00:00Z"));
    expect(wall(T("2026-11-05T18:00:00Z"), PERTH)).toBe("06/11/2026, 02:00");
  });

  it("skips a wall time the spring-forward erased, instead of sliding it an hour", () => {
    // Sydney springs forward at 02:00 on 4 Oct 2026, so 02:30 that night does not exist.
    expect(wallToInstant({ y: 2026, mo: 10, d: 4, h: 2, mi: 30 }, SYDNEY)).toBeNull();
    const schedule = cron("30 2 * * *", SYDNEY);
    const next = nextOccurrence(schedule, T("2026-10-03T14:00:00Z"));
    expect(next).toBe(T("2026-10-04T15:30:00Z"));
    expect(wall(next!, SYDNEY)).toBe("05/10/2026, 02:30");
  });

  it("keys a fall-back morning by its wall time, so a repeated hour is still one run", () => {
    // Sydney falls back on 5 Apr 2026: local 02:00 happens twice, at 15:00Z (+11) and 16:00Z (+10).
    const schedule = cron("0 2 * * *", SYDNEY);
    const earlier = T("2026-04-04T15:00:00Z");
    const later = T("2026-04-04T16:00:00Z");
    expect(wall(earlier, SYDNEY)).toBe("05/04/2026, 02:00");
    expect(wall(later, SYDNEY)).toBe("05/04/2026, 02:00");
    // The dedupe unit is the occurrence, not the instant, so both instants share one lease.
    expect(occurrenceKey(schedule, earlier)).toBe(occurrenceKey(schedule, later));
    expect(occurrenceKey(schedule, earlier)).toBe("w2026-04-05T0200");
    expect(previousOccurrence(schedule, T("2026-04-04T18:00:00Z"), 6 * HOUR)).toBe(later);
  });

  it("steps a daily cron by the zone's own clock", () => {
    const schedule = cron("0 2 * * *", PERTH);
    // 19:00Z on 5 Nov is 03:00 Perth on 6 Nov, so the next 02:00 Perth is 18:00Z on 6 Nov.
    expect(nextOccurrence(schedule, T("2026-11-05T19:00:00Z"))).toBe(T("2026-11-06T18:00:00Z"));
    expect(occurrenceKey(schedule, T("2026-11-06T18:00:00Z"))).toBe("w2026-11-07T0200");
    // And the occurrence that just passed is the one catch-up considers.
    expect(previousOccurrence(schedule, T("2026-11-05T19:10:00Z"), 3 * HOUR)).toBe(T("2026-11-05T18:00:00Z"));
    expect(previousOccurrence(schedule, T("2026-11-05T19:10:00Z"), 30 * 60_000)).toBeNull();
  });

  it("keeps an interval on the grid its anchor set, across a restart", () => {
    const schedule = every(6 * HOUR, T("2026-11-05T00:00:00Z"));
    expect(nextOccurrence(schedule, T("2026-11-05T07:00:00Z"))).toBe(T("2026-11-05T12:00:00Z"));
    expect(previousOccurrence(schedule, T("2026-11-05T07:00:00Z"), HOUR)).toBe(T("2026-11-05T06:00:00Z"));
    // Nothing is due yet: `every 6h` means the first run a period away, not at the moment of creation.
    expect(nextOccurrence(schedule, T("2026-11-05T00:30:00Z"))).toBe(T("2026-11-05T06:00:00Z"));
    expect(previousOccurrence(schedule, T("2026-11-05T05:00:00Z"), 6 * HOUR)).toBeNull();
    // A session that was down for a day lands back on the same grid.
    expect(previousOccurrence(schedule, T("2026-11-06T07:05:00Z"), 24 * HOUR)).toBe(T("2026-11-06T06:00:00Z"));
  });

  it("handles the dates cron cannot fake", () => {
    expect(nextOccurrence(cron("0 0 29 2 *", "UTC"), T("2026-01-01T00:00:00Z"))).toBe(T("2028-02-29T00:00:00Z"));
    const weekdays = cron("0 0 * * fri-mon", "UTC");
    // From a Tuesday the next match is Friday; a wrapped range must not match Tuesday.
    expect(nextOccurrence(weekdays, T("2026-11-03T00:30:00Z"))).toBe(T("2026-11-06T00:00:00Z"));
  });

  it("rejects an out-of-range cron field instead of guessing", () => {
    expect(parseCron("61 * * * *", "UTC")).toBeNull();
    expect(parseCron("0 0 * *", "UTC")).toBeNull();
    expect(parseCron("0 0 * * 8", "UTC")).toBeNull();
    expect(parseCron("@daily", "UTC")).not.toBeNull();
    expect(parseCron("*/15 * * * *", "UTC")).not.toBeNull();
  });

  it("spells instants and durations the way a log line wants them", () => {
    expect(isoUtc(T("2026-11-05T18:00:00Z"))).toBe("2026-11-05T18:00:00.000Z");
    expect(isoUtc(T("2026-11-05T18:00:00Z"))).toBe(new Date(T("2026-11-05T18:00:00Z")).toISOString());
    expect(formatDuration(20 * 60_000)).toBe("20m");
    expect(formatDuration(90 * 60_000)).toBe("1h 30m");
    expect(formatDuration(26 * HOUR)).toBe("1d 2h");
  });
});

// --- reading what a person typed -----------------------------------------

describe("reading a when", () => {
  const NOW = T("2026-11-05T09:00:00Z"); // 17:00 Perth

  it("reads `in 20m` as one shot away from now", () => {
    const parsed = parseWhen(["in", "20m", "refresh", "the", "checkout"], PERTH, NOW);
    expect(parsed).not.toBeNull();
    expect(parsed!.schedule).toEqual({ kind: "once", at: NOW + 20 * 60_000, tz: PERTH });
    expect(parsed!.rest).toBe(2);
    expect(parsed!.summary).toBe("once in 20m");
  });

  it("reads a bare wall time as the next one, once", () => {
    const parsed = parseWhen(["2am", "perth", "pull", "home-ops"], PERTH, NOW);
    expect(parsed!.schedule.kind).toBe("once");
    expect(parsed!.schedule.tz).toBe(PERTH);
    // 17:00 Perth now, so the next 02:00 Perth is 18:00Z the next day.
    expect((parsed!.schedule as { at: number }).at).toBe(T("2026-11-05T18:00:00Z"));
    expect(parsed!.rest).toBe(2);
  });

  it("reads back a cron string it printed itself, which is the whole point of a round trip", () => {
    // The five loose tokens of a cron schedule were accepted, but not the shape `list` and `show` render. A summary
    // comes out as `cron 0 10 * * *`, an agent copies it into `at`, and `add` rejected it - and rejected it
    // confusingly, because `cron 0 6 * *` (the first five tokens) looks parseable: letters are legal in a
    // day-of-week field, so the shape test waved the keyword through and the expression died in parseCron.
    const loose = parseWhen(["cron", "0", "6", "*", "*", "1", "pull", "the", "repo"], PERTH, NOW);
    expect(loose).not.toBeNull();
    expect(loose!.schedule).toEqual(cron("0 6 * * 1", PERTH));
    // `rest` counts the keyword too, or the prompt that follows would be read as part of the time.
    expect(loose!.rest).toBe(6);
    expect(loose!.summary).toBe("cron 0 6 * * 1 " + PERTH);
    // The quoted form works for free, because the prefix is stripped and the parser re-entered.
    expect(parseWhen(["cron", '"0 6 * * 1"'], PERTH, NOW)!.schedule).toEqual(cron("0 6 * * 1", PERTH));
    // And a bare expression still parses exactly as it did before - the keyword is tolerated, not required.
    expect(parseWhen(["0", "6", "*", "*", "1"], PERTH, NOW)!.schedule).toEqual(cron("0 6 * * 1", PERTH));
    // The keyword alone is not a schedule, and must not be mistaken for one.
    expect(parseWhen(["cron"], PERTH, NOW)).toBeNull();
  });

  it("stamps a delivery mode it could not read instead of letting the default look like a choice", () => {
    // The CLI refuses `--deliver bogus`, but the storage layer cannot - a job file outlives the code that reads it,
    // and one bad value must not brick every other schedule. So it falls back, and the trap was that the fallback
    // was silent: an operator who believed a job was set to `steer` was getting `followUp` with no indication.
    expect(readDeliverAs("steer")).toEqual({ deliverAs: "steer" });
    expect(readDeliverAs("nextTurn")).toEqual({ deliverAs: "nextTurn" });
    expect(readDeliverAs("followUp")).toEqual({ deliverAs: "followUp" });
    // Absent is the default, not a mistake, and must not be reported as one.
    expect(readDeliverAs(undefined)).toEqual({ deliverAs: "followUp" });
    expect(readDeliverAs("")).toEqual({ deliverAs: "followUp" });
    // Unreadable is still the safe fallback, but it says so.
    expect(readDeliverAs("steer" + "r")).toEqual({ deliverAs: "followUp", deliverAsUnread: "steerr" });
    expect(readDeliverAs("immediate")).toEqual({ deliverAs: "followUp", deliverAsUnread: "immediate" });
  });

  it("turns a recurrence phrase into a cron in the named zone", () => {
    const parsed = parseWhen(["every", "day", "at", "2am", "perth", "pull", "home-ops"], PERTH, NOW);
    expect(parsed!.schedule).toEqual(cron("0 2 * * *", PERTH));
    expect(parsed!.rest).toBe(5);
    const weekdays = parseWhen(["every", "mon,wed,fri", "at", "4pm"], "UTC", NOW);
    expect(weekdays).not.toBeNull();
    // Behaviour over spelling: from a Tuesday 09:00Z the next match is Friday 16:00Z.
    expect(nextOccurrence(weekdays!.schedule, NOW)).toBe(T("2026-11-06T16:00:00Z"));
  });

  it("reads `every 6h` as an interval anchored now", () => {
    const parsed = parseWhen(["every", "6h", "check", "the", "fleet"], PERTH, NOW);
    expect(parsed!.schedule).toEqual({ kind: "interval", everyMs: 6 * HOUR, anchor: NOW, tz: PERTH });
    expect(parsed!.rest).toBe(2);
  });

  it("accepts a cron expression quoted, or as five loose tokens", () => {
    const quoted = parseWhen(["\"0 2 * * *\"", "flush", "the", "cache"], PERTH, NOW);
    expect(quoted!.schedule).toEqual(cron("0 2 * * *", PERTH));
    expect(quoted!.rest).toBe(1);
    const loose = parseWhen(["0", "2", "*", "*", "*", "flush", "the", "cache"], PERTH, NOW);
    expect(loose!.schedule).toEqual(cron("0 2 * * *", PERTH));
    expect(loose!.rest).toBe(5);
    // Five words that are not cron fields stay a prompt.
    expect(parseWhen(["one", "in", "two", "the", "three"], PERTH, NOW)?.rest ?? 0).not.toBe(5);
  });

  it("knows the aliases a human types, including the inverted Etc ones", () => {
    expect(parseWhen(["2:30pm", "pt", "ship", "it"], PERTH, NOW)!.schedule.tz).toBe("America/Los_Angeles");
    const offset = parseWhen(["02:00", "utc+8", "ship", "it"], PERTH, NOW)!;
    expect(offset.schedule.tz).toBe("Etc/GMT-8");
    // "Now" is 17:00 in a UTC+8 zone, so the next 02:00 there is the following morning: 18:00Z.
    expect((offset.schedule as { at: number }).at).toBe(T("2026-11-05T18:00:00Z"));
    expect(isValidZone("Australia/Perth")).toBe(true);
    expect(isValidZone("Perth")).toBe(false);
  });

  it("reads an absolute instant, with or without an explicit offset", () => {
    const zoned = parseWhen(["2026-11-06T02:00", "run", "the", "drill"], PERTH, NOW);
    expect(zoned!.schedule.kind).toBe("once");
    expect((zoned!.schedule as { at: number }).at).toBe(T("2026-11-05T18:00:00Z"));
    expect(zoned!.rest).toBe(1);
    const utc = parseWhen(["2026-11-06T02:00Z", "run", "the", "drill"], PERTH, NOW);
    expect((utc!.schedule as { at: number }).at).toBe(T("2026-11-06T02:00:00Z"));
  });

  it("refuses what is not a time, and says nothing rather than guessing", () => {
    expect(parseWhen(["sometime", "tomorrow", "maybe"], PERTH, NOW)).toBeNull();
    expect(parseWhen(["in", "a", "bit", "do", "it"], PERTH, NOW)).toBeNull();
    expect(parseWhen([], PERTH, NOW)).toBeNull();
  });
});

// --- the extension in a session ------------------------------------------

interface Sandbox {
  cwd: string;
  state: string;
  declared: string;
  jobs: string;
  events: string;
  locks: string;
  room: string;
}

interface BootOptions {
  /** Move the clock here before the extension loads, so its first tick is already due-relative. */
  at?: string;
  argv?: Record<string, boolean | string>;
  mode?: "tui" | "print" | "json";
  session?: string;
  sessionId?: string;
}

let box: Sandbox;
let pi: FakePi;
let context: any;
let ui: any;

function freshSandbox(): Sandbox {
  const cwd = mkdtempSync(path.join(tmpdir(), "pi-schedules-"));
  const state = path.join(cwd, ".pi", "schedule");
  // `.pi` itself exists (a repository checkout has one); `.pi/schedule` must be created by the extension,
  // which is what the print-mode test checks.
  mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  const sandbox = {
    cwd,
    state,
    declared: path.join(cwd, ".pi", "schedule.json"),
    jobs: path.join(state, "jobs.jsonl"),
    events: path.join(state, "events.jsonl"),
    locks: path.join(state, "locks"),
    room: path.join(cwd, "team-room-state.json"),
  };
  // The state directory and the team-room path are env-configurable for exactly this reason.
  process.env.SCHEDULE_STATE_DIR = sandbox.state;
  process.env.PI_TEAM_ROOM_STATE = sandbox.room;
  process.env.SCHEDULE_TZ = PERTH;
  delete process.env.SCHEDULE_REQUIRE_OWNER;
  delete process.env.SCHEDULE_NAME;
  delete process.env.SCHEDULE_OFF;
  delete process.env.SCHEDULE_TICK_MS;
  return sandbox;
}

async function boot(options: BootOptions = {}): Promise<void> {
  vi.resetModules();
  const mod = await import(MODULE);
  if (options.at) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T(options.at)));
  }
  pi = createFakePi();
  (mod as { default: (api: unknown) => void }).default(pi as any);
  for (const [name, value] of Object.entries(options.argv ?? {})) pi.setFlag(name, value);
  const session = options.session ?? "home-ops";
  const created = createContext({
    cwd: box.cwd,
    mode: options.mode ?? "tui",
    hasUI: options.mode !== "print",
    sessionName: session,
    sessionId: options.sessionId ?? "zz-own-session",
    idle: true,
  });
  context = created.context;
  ui = created.ui;
  pi.setSessionName(session);
  await pi.emit("session_start", { reason: "startup" }, context);
}

/** A restart: the old instance stops its interval, then the same sandbox is booted again. */
async function reboot(options: BootOptions = {}): Promise<void> {
  await pi.emit("session_shutdown", { reason: "exit" }, context);
  await boot(options);
}

async function command(name: string, args: string): Promise<void> {
  const handler = pi.commands.get(name)?.handler;
  if (!handler) throw new Error(`test: no command registered as "${name}"`);
  await handler(args, context);
}

const notices = (): string[] => ui.notifications.map((entry: any) => entry.message as string);
const lastNotice = (): string => notices().at(-1) ?? "";

/** Firing happens on the tick interval, so a test moves the clock and lets the interval run. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

function records(file: string): any[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function writeTeamState(sessions: unknown[]): void {
  writeFileSync(box.room, JSON.stringify({ sessions }), "utf8");
}

function clearState(): void {
  rmSync(box.state, { recursive: true, force: true });
  rmSync(box.locks, { recursive: true, force: true });
}

const toolText = (result: any): string => result.content[0].text as string;
const toolJson = (result: any): any => JSON.parse(result.content[0].text);

beforeEach(() => {
  box = freshSandbox();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("wiring", () => {
  it("registers the commands, the tool, both renderers and the flags it reads", async () => {
    await boot({ at: "2026-11-05T09:00:00Z" });
    expect([...pi.commands.keys()].sort()).toEqual(["at", "cron", "every", "schedule"]);
    expect(pi.tools.has("schedule_jobs")).toBe(true);
    expect(pi.entryRenderers.has(ENTRY_TYPE)).toBe(true);
    expect(pi.messageRenderers.has(RUN_TYPE)).toBe(true);
    expect([...pi.flags.keys()]).toEqual(
      expect.arrayContaining(["schedules-off", "schedule-name", "schedule-tz", "schedule-tick"]),
    );
    expect(pi.lifecycleEvents).toEqual(expect.arrayContaining(["session_start", "session_shutdown"]));
  });

  it("writes nothing and fires nothing in print mode, and says why", async () => {
    await boot({ at: "2026-11-05T09:00:00Z", mode: "print", session: "throwaway" });
    await command("at", "in 10m touch a file");
    expect(lastNotice()).toContain("do not fire in print/JSON mode");
    expect(existsSync(box.state)).toBe(false);
    expect(pi.sentMessages).toEqual([]);
    expect(ui.statuses.get("schedules")).toBeUndefined();
    await advance(60 * 60_000);
    expect(pi.sentMessages).toEqual([]);
    expect(existsSync(box.state)).toBe(false);
  });

  it("starts paused when --schedules-off is passed, without touching the jobs", async () => {
    await boot({ at: "2026-11-05T09:00:00Z", argv: { "schedules-off": true } });
    await command("every", "1h ping the fleet");
    await advance(3 * 60 * 60_000);
    expect(pi.sentMessages).toEqual([]);
    expect(records(box.jobs)).toHaveLength(1);
    expect(ui.statuses.get("schedules")).toContain("schedules off");
  });
});

describe("creating jobs", () => {
  it("schedules /at in 20m and reports the next run on the repository's clock", async () => {
    await boot({ at: "2026-11-05T09:00:00Z" }); // 17:00 Perth
    await command("at", "in 20m refresh the home-ops checkout");
    const notice = lastNotice();
    expect(notice).toContain("scheduled refresh-the-home-ops-checkout");
    expect(notice).toContain("once at 2026-11-05T09:20:00.000Z");
    expect(notice).toContain("17:20"); // the reported next run is a Perth wall time, not a UTC one
    expect(records(box.jobs)).toHaveLength(1);
    expect(records(box.jobs)[0]).toMatchObject({ op: "add", id: "refresh-the-home-ops-checkout", tz: PERTH });
  });

  it("stores /every day at 2am perth as a cron job in that zone", async () => {
    await boot({ at: "2026-11-05T09:00:00Z" });
    await command("every", "day at 2am perth pull home-ops so it is up to date, then read NIGHTLY_MAINTENANCE.md");
    expect(records(box.jobs)[0].schedule).toEqual({ kind: "cron", cron: "0 2 * * *", tz: PERTH });
    expect(lastNotice()).toContain("cron 0 2 * * * (Australia/Perth)");
    expect(lastNotice()).toContain("02:00 Australia/Perth");
  });

  it("refuses a when it cannot read, an /every with no recurrence, and a prompt with no text", async () => {
    await boot({ at: "2026-11-05T09:00:00Z" });
    await command("at", "sometime next week tidy the pods");
    expect(lastNotice()).toContain("could not read that as a time");
    await command("every", "2am tidy the pods");
    expect(lastNotice()).toContain("could not read that as a time");
    expect(lastNotice()).toContain("which is what /at is for");
    await command("at", "in 10m");
    expect(lastNotice()).toContain("no prompt after the time");
    expect(records(box.jobs)).toEqual([]);
  });

  it("rejects a zone the runtime does not know, rather than quietly scheduling in the machine zone", async () => {
    await boot({ at: "2026-11-05T09:00:00Z" });
    await command("at", "in 10m --tz Australia/Perthv2 do the thing");
    expect(lastNotice()).toContain("is not a zone this runtime knows");
    expect(records(box.jobs)).toEqual([]);
  });

  it("warns that an owner-gated job will not fire here, but stores it for the session that owns it", async () => {
    await boot({ at: "2026-11-05T09:00:00Z", session: "home-ops" });
    await command("at", "in 10m --owner night-bot do the thing");
    expect(lastNotice()).toContain("belongs to night-bot");
    expect(records(box.jobs)[0]).toMatchObject({ owner: "night-bot" });
  });

  it("refuses to create an unowned job when the deployment requires an owner", async () => {
    process.env.SCHEDULE_REQUIRE_OWNER = "1";
    await boot({ at: "2026-11-05T09:00:00Z", session: "home-ops" });
    await command("every", "6h ping the fleet");
    expect(lastNotice()).toContain("refusing to create");
    expect(records(box.jobs)).toEqual([]);
  });
});

describe("firing", () => {
  it("injects the prompt as a custom message that starts a turn, records the run, and retires the job", async () => {
    await boot({ at: "2026-11-05T09:00:00Z" });
    await command("at", "in 20m refresh the home-ops checkout");
    expect(pi.sentMessages).toEqual([]);

    await advance(21 * 60_000);

    expect(pi.sentMessages).toHaveLength(1);
    const { message, options } = pi.sentMessages[0];
    expect(message).toMatchObject({ customType: RUN_TYPE, display: false });
    expect(message.content.startsWith("refresh the home-ops checkout")).toBe(true);
    expect(message.details).toMatchObject({ jobId: "refresh-the-home-ops-checkout" });
    // triggerTurn is what makes a scheduled run happen in an idle session at all.
    expect(options).toEqual({ triggerTurn: true, deliverAs: "followUp" });

    expect(records(box.events).filter((event) => event.op === "fired")).toHaveLength(1);
    expect(pi.appendedEntries.at(-1)).toMatchObject({ type: ENTRY_TYPE, data: { op: "fired" } });
    expect(lastNotice()).toContain("fired refresh-the-home-ops-checkout");

    // A one-shot is gone afterwards, so it cannot fire again tomorrow.
    expect(records(box.jobs).at(-1)).toMatchObject({ op: "remove", id: "refresh-the-home-ops-checkout" });
    await advance(3 * 60 * 60_000);
    expect(pi.sentMessages).toHaveLength(1);
  });

  it("claims a lease per occurrence, and stands down when another session holds it", async () => {
    await boot({ at: "2026-11-05T09:00:00Z" });
    await command("every", "1h check the fleet");
    const anchor = T("2026-11-05T09:00:00Z");
    const due = T("2026-11-05T10:00:00Z");
    const key = occurrenceKey(every(HOUR, anchor), due);

    // The other Pi got there first: the lock exists before this session's tick.
    mkdirSync(path.join(box.locks, "check-the-fleet"), { recursive: true });
    writeFileSync(path.join(box.locks, "check-the-fleet", `${key}.lock`), JSON.stringify({ session: "home-ops-2" }), "utf8");

    await advance(61 * 60_000);

    expect(pi.sentMessages).toEqual([]);
    const skipped = records(box.events).filter((event) => event.op === "skipped");
    // One line for the occurrence, not one per tick.
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ op: "skipped", id: "check-the-fleet", key });
    expect(skipped[0].reason).toContain("lease held");
  });

  it("fires a missed cron occurrence on the tick after it is created, exactly once", async () => {
    await boot({ at: "2026-11-05T19:05:00Z" }); // 03:05 Perth: tonight's 02:00 was already missed
    await command("cron", "0 2 * * * --tz Australia/Perth rotate the logs");
    await advance(3 * 60_000);
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].message.content).toContain("rotate the logs");
    // Several more ticks must not produce a second run of the same occurrence.
    await advance(20 * 60_000);
    expect(pi.sentMessages).toHaveLength(1);
    expect(records(box.events).filter((event) => event.op === "fired")).toHaveLength(1);
    // Tomorrow's run is a different occurrence, and therefore a different lease.
    expect(occurrenceKey(cron("0 2 * * *", PERTH), T("2026-11-06T18:00:00Z"))).toBe("w2026-11-07T0200");
  });

  it("catches up a missed occurrence after a restart, and lets an older one age out", async () => {
    await boot({ at: "2026-11-04T09:00:00Z" }); // created the day before, session down through 02:00
    await command("cron", "0 2 * * * --tz Australia/Perth --catchup 3h rotate the logs");
    expect(pi.sentMessages).toEqual([]);

    vi.setSystemTime(new Date(T("2026-11-05T19:10:00Z"))); // 03:10 Perth: 02:00 was 70 minutes ago
    await reboot({ at: "2026-11-05T19:10:00Z" });
    await advance(1500); // the startup tick that catches the missed occurrence
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].message.details).toMatchObject({ jobId: "rotate-the-logs" });
    expect(pi.sentMessages[0].message.content).toContain("rotate the logs");

    // The same schedule with catch-up off does not run a 70-minute-old occurrence.
    await pi.emit("session_shutdown", { reason: "exit" }, context);
    clearState();
    await boot({ at: "2026-11-05T19:10:00Z" });
    await command("cron", "0 2 * * * --tz Australia/Perth --catchup none rotate the logs");
    await advance(60 * 1000);
    expect(pi.sentMessages).toEqual([]);
  });

  it("keeps a job out of a session that is not its owner, and claims nothing there", async () => {
    await boot({ at: "2026-11-05T09:00:00Z", session: "some-other-pi-in-the-same-folder" });
    await command("every", "1h --owner home-ops ping the fleet");
    await advance(61 * 60_000);
    expect(pi.sentMessages).toEqual([]);
    expect(existsSync(path.join(box.locks, "ping-the-fleet"))).toBe(false);
    expect(records(box.events).filter((event) => event.op === "skipped")[0].reason).toContain("belongs to home-ops");
  });

  it("fires for a session whose name matches the owner pattern", async () => {
    await boot({ at: "2026-11-05T09:00:00Z", session: "home-ops-2" });
    await command("every", "1h --owner home-* ping the fleet");
    await advance(61 * 60_000);
    expect(pi.sentMessages).toHaveLength(1);
  });

  it("honours --deliver: nextTurn waits for a turn instead of starting one", async () => {
    await boot({ at: "2026-11-05T09:00:00Z" });
    await command("at", "in 10m --deliver nextTurn write the standup note");
    await advance(11 * 60_000);
    expect(pi.sentMessages[0].options).toEqual({ triggerTurn: false, deliverAs: "nextTurn" });
  });

  it("skips, rather than queues, when a --skip-if-busy job comes due mid-answer", async () => {
    await boot({ at: "2026-11-05T09:00:00Z" });
    await command("at", "in 10m --skip-if-busy rebuild the image");
    context.setIdle(false);
    await advance(11 * 60_000);
    expect(pi.sentMessages).toEqual([]);
    const skipped = records(box.events).filter((event) => event.op === "skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toContain("skip_if_busy");
  });

  it("pauses firing with /schedule off without touching the jobs, and resumes with /schedule on", async () => {
    await boot({ at: "2026-11-05T09:00:00Z" });
    await command("every", "1h ping the fleet");
    await command("schedule", "off");
    expect(ui.statuses.get("schedules")).toContain("schedules off");
    expect(lastNotice()).toContain("paused in this session");
    await advance(2 * 60 * 60_000);
    expect(pi.sentMessages).toEqual([]);
    expect(records(box.jobs)).toHaveLength(1);
    await command("schedule", "on");
    await advance(30 * 60_000);
    // Resumed, and the occurrence this session slept through is inside the catch-up window, so it runs.
    expect(pi.sentMessages).toHaveLength(1);
  });

  it("pauses one job durably, so a restart keeps it paused", async () => {
    await boot({ at: "2026-11-05T09:00:00Z" });
    await command("every", "1h ping the fleet");
    await command("schedule", "pause ping-the-fleet");
    expect(lastNotice()).toContain("paused ping-the-fleet");
    await reboot({ at: "2026-11-05T11:00:00Z" });
    await advance(61 * 60_000);
    expect(pi.sentMessages).toEqual([]);
    await command("schedule", "resume ping-the-fleet");
    await advance(30 * 60_000);
    expect(pi.sentMessages).toHaveLength(1);
  });
});

describe("cross-node deconfliction", () => {
  it("lets the live peer with the lower session id win the occurrence", async () => {
    // lastSeenAt is the occurrence time, i.e. a peer that is heartbeating right now.
    writeTeamState([
      { id: "aaa-peer-session", name: "home-ops", cwd: box.cwd, project: "home-ops", connected: true, lastSeenAt: new Date(T("2026-11-05T10:00:00Z")).toISOString() },
    ]);
    await boot({ at: "2026-11-05T09:00:00Z", sessionId: "zz-own-session" });
    await command("every", "1h --owner home-ops ping the fleet");
    await advance(61 * 60_000);
    expect(pi.sentMessages).toEqual([]);
    const skipped = records(box.events).filter((event) => event.op === "skipped");
    expect(skipped[0].reason).toContain("election lost to aaa-peer-session");
    // Losing must not leave a lease that blocks the winner.
    expect(existsSync(path.join(box.locks, "ping-the-fleet"))).toBe(false);
  });

  it("runs it itself when the only live peer has the higher id", async () => {
    writeTeamState([
      { id: "zzz-peer-session", name: "home-ops", cwd: box.cwd, project: "home-ops", connected: true, lastSeenAt: new Date(T("2026-11-05T10:00:00Z")).toISOString() },
      // Stale by the team room's own staleness window, so it is not a peer any more.
      { id: "aaa-stale-peer", name: "home-ops", cwd: box.cwd, project: "home-ops", connected: true, lastSeenAt: new Date(T("2026-11-05T07:00:00Z")).toISOString() },
    ]);
    await boot({ at: "2026-11-05T09:00:00Z", sessionId: "zz-own-session" });
    await command("every", "1h --owner home-ops ping the fleet");
    await advance(61 * 60_000);
    expect(pi.sentMessages).toHaveLength(1);
  });

  it("ignores a peer that is sitting in a different repository", async () => {
    writeTeamState([
      { id: "aaa-peer-session", name: "rooter", cwd: "/workspace/rooter", project: "rooter", connected: true, lastSeenAt: new Date(T("2026-11-05T10:00:00Z")).toISOString() },
    ]);
    await boot({ at: "2026-11-05T09:00:00Z", sessionId: "zz-own-session" });
    await command("every", "1h --owner home-ops ping the fleet");
    await advance(61 * 60_000);
    expect(pi.sentMessages).toHaveLength(1);
  });

  it("matches a peer whose checkout only shares the declared repo suffix", async () => {
    writeFileSync(box.declared, JSON.stringify({ defaults: { tz: PERTH, owner: "home-ops", repo: "home-ops" }, jobs: [] }), "utf8");
    await boot({ at: "2026-11-05T09:00:00Z", sessionId: "zz-own-session" });
    writeTeamState([
      { id: "aaa-peer-session", name: "home-ops", cwd: "/srv/deploy/home-ops", project: "home-ops", connected: true, lastSeenAt: new Date(T("2026-11-05T10:00:00Z")).toISOString() },
    ]);
    await command("every", "1h ping the fleet");
    await advance(61 * 60_000);
    expect(pi.sentMessages).toEqual([]);
  });

  it("falls back to leases alone when no team room state exists", async () => {
    await boot({ at: "2026-11-05T09:00:00Z" });
    await command("every", "1h ping the fleet");
    await command("schedule", "who");
    expect(lastNotice()).toContain("team room");
    expect(lastNotice()).toContain("(not found)");
    await advance(61 * 60_000);
    expect(pi.sentMessages).toHaveLength(1);
    expect(records(box.events).filter((event) => event.op === "fired")[0].key).toBe(`t${T("2026-11-05T10:00:00Z")}`);
  });
});

describe("declared schedules in .pi/schedule.json", () => {
  it("loads a committed schedule and reports its next run in its own zone", async () => {
    writeFileSync(
      box.declared,
      JSON.stringify({
        defaults: { tz: PERTH, owner: "home-ops" },
        jobs: [{ id: "nightly", cron: "0 2 * * *", prompt: "pull home-ops, then read NIGHTLY_MAINTENANCE.md", note: "the runbook" }],
      }),
      "utf8",
    );
    await boot({ at: "2026-11-05T09:00:00Z" }); // 17:00 Perth
    const listed = toolJson(await callTool(pi, "schedule_jobs", { action: "list" }, context));
    expect(listed.jobs[0]).toMatchObject({
      id: "nightly",
      source: "declared",
      owner: "home-ops",
      canFireHere: true,
      schedule: "cron 0 2 * * * (Australia/Perth)",
    });
    expect(listed.jobs[0].nextWall).toContain("02:00");
    expect(listed.jobs[0].next).toBe(isoUtc(T("2026-11-05T18:00:00Z")));
  });

  it("refuses to edit a committed schedule from a command or from the tool", async () => {
    writeFileSync(box.declared, JSON.stringify({ jobs: [{ id: "nightly", cron: "0 2 * * *", prompt: "rotate logs", tz: PERTH }] }), "utf8");
    await boot({ at: "2026-11-05T09:00:00Z" });
    await command("schedule", "remove nightly");
    expect(lastNotice()).toContain("is declared in");
    expect(lastNotice()).toContain("does not edit a committed file");
    expect(records(box.jobs)).toEqual([]);
    expect(toolText(await callTool(pi, "schedule_jobs", { action: "remove", id: "nightly" }, context))).toContain("edit that file");
  });

  it("picks up a schedule.json that a nightly pull changed, without a restart", async () => {
    await boot({ at: "2026-11-05T09:00:00Z" });
    writeFileSync(box.declared, JSON.stringify({ jobs: [{ id: "one", cron: "0 2 * * *", prompt: "rotate logs", tz: PERTH }] }), "utf8");
    await advance(30 * 1000);
    expect(toolJson(await callTool(pi, "schedule_jobs", { action: "list" }, context)).jobs.map((job: any) => job.id)).toEqual(["one"]);
    writeFileSync(
      box.declared,
      JSON.stringify({
        jobs: [
          { id: "one", cron: "0 2 * * *", prompt: "rotate logs", tz: PERTH },
          { id: "two", cron: "30 3 * * *", prompt: "vacuum the pods", tz: PERTH },
        ],
      }),
      "utf8",
    );
    await advance(30 * 1000);
    expect(toolJson(await callTool(pi, "schedule_jobs", { action: "list" }, context)).jobs.map((job: any) => job.id)).toEqual(["one", "two"]);
  });

  it("phase-locks a declared interval to the epoch, so a restart cannot slide it", async () => {
    writeFileSync(box.declared, JSON.stringify({ jobs: [{ id: "heartbeat", every: "every 6h", catchup: "none", prompt: "ping the fleet", tz: PERTH }] }), "utf8");
    await boot({ at: "2026-11-05T00:05:00Z" });
    await advance(61 * 60_000); // 01:06: the 00:00 grid point is long gone and catch-up is off
    expect(pi.sentMessages).toEqual([]);
    await advance(4 * HOUR + 54 * 60_000 + 25_000); // 06:00:25Z, one tick past the 06:00 grid point
    expect(pi.sentMessages).toHaveLength(1);
    // The occurrence key is the grid instant, not a time relative to when this pod started.
    expect(records(box.events).filter((event) => event.op === "fired")[0].key).toBe(`t${T("2026-11-05T06:00:00Z")}`);
  });

  it("reports a declared file it cannot read, and carries on with the local jobs", async () => {
    writeFileSync(box.declared, "{ not json", "utf8");
    await boot({ at: "2026-11-05T09:00:00Z" });
    await advance(400); // the load warning is deliberately deferred so it lands after the UI settles
    expect(notices().join("\n")).toContain("schedule.json is not readable JSON");
    await command("at", "in 10m still works");
    expect(lastNotice()).toContain("scheduled still-works");
  });
});

describe("listing and auditing", () => {
  it("answers 'did the 2am job run?' from history", async () => {
    await boot({ at: "2026-11-05T19:05:00Z" });
    await command("cron", "0 2 * * * --tz Australia/Perth rotate the logs");
    await advance(3 * 60_000);
    await command("schedule", "history");
    const line = lastNotice();
    expect(line).toContain("FIRED");
    expect(line).toContain("rotate-the-logs");
    expect(line).toContain("w2026-11-06T0200");
  });

  it("shows who this session thinks it is, and which state it is reading", async () => {
    await boot({ at: "2026-11-05T09:00:00Z", session: "home-ops" });
    await command("schedule", "who");
    const lines = lastNotice();
    expect(lines).toContain("session name   home-ops");
    expect(lines).toContain(`cwd            ${box.cwd}`);
    expect(lines).toContain(`state dir      ${box.state}`);
    expect(lines).toContain("default tz     Australia/Perth");
    expect(lines).toContain("mode           tui");
  });

  it("lists jobs with the gate that applies to each one", async () => {
    await boot({ at: "2026-11-05T09:00:00Z", session: "home-ops" });
    await command("every", "1h --owner home-ops ping the fleet");
    await command("every", "1h --owner someone-else probe the other repo");
    await command("schedule", "list");
    const text = lastNotice();
    expect(text).toContain("ping-the-fleet");
    expect(text).toContain('belongs to someone-else, this session is "home-ops"');
    expect(text).toContain("team room state not found");
  });

  it("draws the audit entry the way the extension promised", async () => {
    await boot({ at: "2026-11-05T09:00:00Z" });
    const renderer = pi.entryRenderers.get(ENTRY_TYPE)!;
    const rendered = renderer(
      {
        type: "custom",
        customType: ENTRY_TYPE,
        data: { op: "fired", id: "nightly", key: "w2026-11-06T0200", at: T("2026-11-05T18:00:00Z"), wall: "2026-11-06 02:00 Australia/Perth", prompt: "pull home-ops" },
      },
      { expanded: false },
      fakeTheme,
    );
    const text = (rendered?.render(80) ?? []).join("\n");
    expect(text).toContain("schedules");
    expect(text).toContain("fired nightly");
    expect(text).toContain("pull home-ops");
  });

  it("draws the injected prompt as a scheduled run", async () => {
    await boot({ at: "2026-11-05T09:00:00Z" });
    const renderer = pi.messageRenderers.get(RUN_TYPE)!;
    const rendered = renderer(
      { customType: RUN_TYPE, content: "rotate the logs", details: { jobId: "rotate-the-logs", occurrence: "w2026-11-06T0200" } },
      { expanded: false },
      fakeTheme,
    );
    const text = (rendered?.render(80) ?? []).join("\n");
    expect(text).toContain("scheduled run");
    expect(text).toContain("rotate-the-logs");
    expect(text).toContain("rotate the logs");
  });
});

describe("the schedule_jobs tool", () => {
  it("adds, lists, pauses and removes a job", async () => {
    await boot({ at: "2026-11-05T09:00:00Z" });
    const added = await callTool(pi, "schedule_jobs", { action: "add", at: "every 6h", prompt: "check the fleet status", tz: PERTH, owner: "home-ops", note: "from the tool" }, context);
    expect(toolText(added)).toContain("scheduled check-the-fleet-status");
    const listed = toolJson(await callTool(pi, "schedule_jobs", { action: "list" }, context));
    expect(listed.jobs[0]).toMatchObject({ id: "check-the-fleet-status", source: "local", owner: "home-ops", deliverAs: "followUp" });
    expect(toolText(await callTool(pi, "schedule_jobs", { action: "pause", id: "check-the-fleet-status" }, context))).toContain("paused");
    expect(toolJson(await callTool(pi, "schedule_jobs", { action: "list" }, context)).jobs[0].enabled).toBe(false);
    await advance(7 * 60 * 60_000);
    expect(pi.sentMessages).toEqual([]);
    expect(toolText(await callTool(pi, "schedule_jobs", { action: "remove", id: "check-the-fleet-status" }, context))).toContain("removed");
    expect(toolJson(await callTool(pi, "schedule_jobs", { action: "list" }, context)).jobs).toEqual([]);
  });

  it("runs a job immediately when asked, without consuming its scheduled occurrence", async () => {
    await boot({ at: "2026-11-05T19:00:00Z" });
    await command("cron", "0 2 * * * --tz Australia/Perth rotate the logs");
    const result = await callTool(pi, "schedule_jobs", { action: "run", id: "rotate-the-logs" }, context);
    expect(toolText(result)).toContain("fired rotate-the-logs");
    expect(toolText(result)).toContain("manual-");
    expect(pi.sentMessages).toHaveLength(1);
    // Tonight's real occurrence is still unclaimed: a manual run is keyed separately.
    expect(records(box.events).some((event) => event.key === "w2026-11-06T0200")).toBe(false);
    expect(existsSync(path.join(box.locks, "rotate-the-logs", "w2026-11-06T0200.lock"))).toBe(false);
  });

  it("keeps a one-shot that was rehearsed by hand, because a rehearsal is not its firing", async () => {
    await boot({ at: "2026-11-05T09:00:00Z" });
    await command("at", "2026-11-06T09:00:00Z ping tomorrow");
    await command("schedule", "run ping-tomorrow");
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].message.content).toContain("ping tomorrow");
    expect(pi.sentMessages[0].message.content).toContain("run by hand");
    // A `once` job's occurrence key is the instant it was promised for, so recording the manual fire under
    // that key would silently eat tomorrow's run. The manual key names the moment it happened instead.
    expect(records(box.events).every((event) => String(event.key).startsWith("manual-"))).toBe(true);
    await advance(26 * 60 * 60_000);
    // The rehearsal did not spend it: the fired prompt is the plain one, arriving on its own wall clock.
    expect(pi.sentMessages).toHaveLength(2);
    expect(pi.sentMessages[1].message.content).toBe("ping tomorrow");
    expect(lastNotice()).toContain("fired ping-tomorrow");
    expect(records(box.jobs).some((record) => record.op === "remove" && record.id === "ping-tomorrow")).toBe(true);
  });

  it("lists what is coming next, and refuses an add with no prompt", async () => {
    await boot({ at: "2026-11-05T09:00:00Z" });
    await command("every", "1h --owner home-ops ping the fleet");
    const upcoming = toolJson(await callTool(pi, "schedule_jobs", { action: "next" }, context));
    expect(upcoming[0]).toMatchObject({ id: "ping-the-fleet", next: isoUtc(T("2026-11-05T10:00:00Z")) });
    expect(toolText(await callTool(pi, "schedule_jobs", { action: "add", at: "in 10m" }, context))).toContain("needs a prompt");
    expect(toolText(await callTool(pi, "schedule_jobs", { action: "show", id: "nope" }, context))).toContain('no job "nope"');
  });
});
