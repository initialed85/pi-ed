/**
 * schedules - a prompt at a wall-clock time, in the repository's own timezone.
 *
 *   /at <when> <prompt>          one-shot; add a recurrence phrase and it becomes recurring
 *   /every <what> <prompt>       recurring: `6h`, `45m`, `every day at 2am perth`, `mon,wed 09:00 utc`
 *   /cron <mi> <hr> <dom> <mon> <dow> [--tz <IANA>] <prompt>
 *   /schedule [list | show <id> | remove <id> | pause <id> | resume <id> | run <id> | off | on | who | history [id]]
 *
 * The use case is a long-running Pi session per repository (slopyphus), so the bot can be told, once,
 * in the repository it lives in:
 *
 *   /at 2am perth time every day, pull home-ops so it is up to date, then read and execute NIGHTLY_MAINTENANCE.md
 *
 * which is stored as a cron job `0 2 * * *` in `Australia/Perth`. Wall clock, not "every 86,400,000 ms":
 * a job set at 02:00 Perth fires at 02:00 Perth whatever UTC is doing, and in a zone with DST the
 * instant moves with the offset. A wall time inside a DST gap (02:30 on the spring-forward night) does
 * not exist and that occurrence is skipped rather than slid an hour; on the fall-back night the wall time
 * matches twice and the later mapping is the one taken - which is harmless, because occurrences are
 * keyed by wall time, so that morning still runs once.
 *
 * Timezones are IANA names, plus the aliases a human would type (`perth`, `sydney`, `london`, `pt`,
 * `utc+8`). `utc+8` maps to `Etc/GMT-8`, which is inverted because POSIX signs Etc zones the other way:
 * `Etc/GMT-8` is UTC+8. Anything `Intl` rejects is rejected here, loudly, at the command that typed it.
 *
 * Two job sources, one view:
 *
 *   - `.pi/schedule.json` in the repository. Committed, reviewable, and the one a `git pull` updates.
 *     Re-read when its mtime or size changes, so a nightly pull of the repo can change the schedule
 *     without restarting the session. Declared jobs are read-only from the commands: to change one,
 *     edit the file. That keeps one source of truth and no override bookkeeping.
 *   - `<cwd>/.pi/schedule/jobs.jsonl` for everything created by `/at`, `/every`, `/cron`, or the
 *     `schedule_jobs` tool. Append-only, replayed on read: add/remove/pause/resume are operations, and
 *     the live jobs are what the replay leaves behind. Two Pi sessions writing to the same file cannot
 *     clobber each other's job, which a read-modify-write JSON file could.
 *
 * Fired runs and skips are appended to `.pi/schedule/events.jsonl` and mirrored as transcript entries
 * (registerEntryRenderer, customType `schedule`), so "did the 2am job actually run?" is answerable from
 * scrollback or the file. The prompt itself is injected as a custom message of type `schedule-run`,
 * which is what reaches the model, and what a replay of an old session shows.
 *
 * Three concurrency layers, because more than one Pi can be sitting in the same repository - and each
 * layer is honest about the case it actually covers:
 *
 *   1. Identity. A job's `owner` is a session-name pattern. A Pi whose session name does not match
 *      never fires it and never claims it. Name resolution is pi.getSessionName() -> --schedule-name ->
 *      SCHEDULE_NAME -> NAME (slopyphus exports NAME and starts pi with `pi --name $NAME`). Jobs with no
 *      owner are legal and shown as unprotected by `/schedule list`; SCHEDULE_REQUIRE_OWNER=1 refuses to
 *      fire anything unnamed, for deployments where "named or nothing" is the rule.
 *   2. A per-occurrence lease. An occurrence is keyed by what it is: a cron job by its wall occurrence
 *      (`w2026-11-06T0200`, so a fall-back morning is one occurrence rather than two), an interval or
 *      one-shot job by its epoch milliseconds (`t1793872800000`). Every Pi computes the same key, and the
 *      claim is an exclusive create (`flag: "wx"`) of `.pi/schedule/locks/<job>/<key>.lock`. One wins,
 *      the rest see EEXIST and stand down. That is real mutual exclusion for every Pi that shares that
 *      filesystem - several sessions in one folder on one node, or one RWX volume mounted by several pods.
 *      At-most-once per occurrence: a job that fires and then fails does not re-fire, because the lease is
 *      what decides, and `/schedule run <id>` is how you force it (a forced run is keyed `manual-...` so
 *      forcing tonight does not consume tonight's occurrence).
 *   3. Cross-node election, automatic when pi-team-room is installed. Read the room's `sessions[]` and
 *      look for a live peer that could run this same job in this same project; if one exists, the lowest
 *      session id runs it and the others skip. No opt-in flag: the opt-in is that the room is there.
 *      It is eventually consistent (the room gossips every few seconds), so two nodes that started
 *      claiming at the same moment can both believe they won inside that window. It biases the wrong-way
 *      risk the other way: the job runs, rather than nobody running it. Paths have to agree for peers to
 *      be recognised; where the same repo lives at different paths on different nodes, declare `repo`
 *      (in defaults or per job) and matching is by path suffix instead.
 *
 * Print and JSON modes never tick, never claim a lease and never write state. A throwaway `pi -p` in a
 * checkout must not steal tonight's job from the session that owns it, and it has no transcript to
 * decorate either. `/schedule off` (or --schedules-off / SCHEDULE_OFF=1) pauses firing in this session.
 * `/schedule off` is in-memory on purpose: a restart resumes firing, which is the difference between a
 * pause and a forgotten pause. Per-job `pause` is durable, because that one is configuration.
 *
 * Catch-up (`--catchup <duration>`, `--catchup off`) is about downtime, not polling: an occurrence is
 * fired if it is no older than the window, and the window is never smaller than two ticks, so a schedule
 * is noticed within one tick of being due even with catch-up off.
 *
 * Configuration is env and flag: `--schedules-off`, `--schedule-name <name>`, `--schedule-tz <IANA>`,
 * `--schedule-tick <ms>`, and SCHEDULE_NAME / SCHEDULE_TZ / SCHEDULE_TICK_MS / SCHEDULE_OFF /
 * SCHEDULE_REQUIRE_OWNER / SCHEDULE_STATE_DIR / PI_TEAM_ROOM_STATE (for tests and unusual layouts).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, join, resolve } from "node:path";

import { Text } from "@earendil-works/pi-tui";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

/** The one string a reader greps for in the session JSONL. */
const ENTRY_TYPE = "schedule";
/** The customType of the message a fired job injects. Distinct from the audit entry: one is what the
 * model receives, the other is what the transcript records, and a reader greps a different string. */
const RUN_TYPE = "schedule-run";
const STATUS_KEY = "schedules";

const DEFAULT_TICK_MS = 20_000;
/**
 * How late a missed occurrence may still fire. Long enough to cover a pod restart or a deploy, short
 * enough that a cluster which was down for a week does not run a week-old maintenance job at boot.
 * Interval jobs default to their own period instead, capped here.
 */
const DEFAULT_CATCHUP_MS = 3 * 60 * 60_000;
const CATCHUP_PERIOD_CAP_MS = 24 * 60 * 60_000;
/** A lease is a dedupe record, not a log to keep: older than this it can be forgotten. */
const LOCK_PRUNE_MS = 30 * 24 * 60 * 60_000;
/** pi-team-room's own staleness window (STALE_SESSION_MS in network-service.mjs). */
const TEAM_STALE_MS = 90_000;
/** How far a cron search may walk before giving up. Covers any reasonable schedule twice over. */
const CRON_SEARCH_DAYS = 800;
const AUDIT_TAIL_LINES = 4000;
const MAX_PROMPT_IN_ENTRY = 160;

const UNITS: Record<string, number> = {
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
  w: 7 * 86_400_000, week: 7 * 86_400_000, weeks: 7 * 86_400_000,
};

/** What a human types instead of an IANA zone. Deliberately small: IANA names always work too. */
const TZ_ALIASES: Record<string, string> = {
  utc: "UTC", zulu: "UTC", universal: "UTC", gmt: "UTC",
  perth: "Australia/Perth", awst: "Australia/Perth", "western australia": "Australia/Perth", wst: "Australia/Perth",
  adelaide: "Australia/Adelaide", "south australia": "Australia/Adelaide", cst: "Australia/Broken_Hill",
  sydney: "Australia/Sydney", melbourne: "Australia/Sydney", victoria: "Australia/Sydney", nsw: "Australia/Sydney", aest: "Australia/Sydney",
  hobart: "Australia/Hobart", tasmania: "Australia/Hobart",
  brisbane: "Australia/Brisbane", queensland: "Australia/Brisbane", bst: "Australia/Brisbane",
  darwin: "Australia/Darwin", "northern territory": "Australia/Darwin", acst: "Australia/Brisbane",
  canberra: "Australia/Sydney", act: "Australia/Sydney",
  auckland: "Pacific/Auckland", nz: "Pacific/Auckland", "new zealand": "Pacific/Auckland",
  london: "Europe/London", uk: "Europe/London", britain: "Europe/London", ireland: "Europe/Dublin",
  paris: "Europe/Paris", berlin: "Europe/Berlin", madrid: "Europe/Madrid", rome: "Europe/Rome", cet: "Europe/Berlin",
  newyork: "America/New_York", "new york": "America/New_York", eastern: "America/New_York", est: "America/New_York", et: "America/New_York",
  chicago: "America/Chicago", central: "America/Chicago", ct: "America/Chicago",
  denver: "America/Denver", mountain: "America/Denver", mt: "America/Denver",
  "los angeles": "America/Los_Angeles", losangeles: "America/Los_Angeles", pacific: "America/Los_Angeles", pt: "America/Los_Angeles",
  tokyo: "Asia/Tokyo", japan: "Asia/Tokyo", jst: "Asia/Tokyo",
  singapore: "Asia/Singapore", sgt: "Asia/Singapore", hk: "Asia/Hong_Kong", hkt: "Asia/Hong_Kong",
  india: "Asia/Kolkata", kolkata: "Asia/Kolkata", ist: "Asia/Kolkata",
  dubai: "Asia/Dubai", gst: "Asia/Dubai",
};

/** Words that mean nothing after a time and should not become part of the prompt. */
const TIME_NOISE = new Set(["time", "local", "o'clock", "oclock", "sharp", "exactly", "please", "at"]);

// ---------------------------------------------------------------------------
// Wall-clock arithmetic that never touches Date.
//
// Everything here works on (y, month, day, hour, minute) triples in a named zone, converted to an
// instant only at the end. Date objects are avoided on purpose: the test suite drives this extension
// with faked timers, and a Date implementation a test harness replaced is not something schedule
// correctness should depend on. Howard Hinnant's civil-date algorithms handle leap years and out-of
// range day numbers, which is what "the day after 2026-02-28" needs.
// ---------------------------------------------------------------------------

function daysFromCivil(y: number, m: number, d: number): number {
  const shifted = m <= 2 ? y - 1 : y;
  const era = Math.floor((shifted >= 0 ? shifted : shifted - 399) / 400);
  const yearOfEra = shifted - era * 400;
  const monthOfEra = (m + 9) % 12;
  const dayOfYear = Math.floor((153 * monthOfEra + 2) / 5) + d - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

function civilFromDays(z0: number): { y: number; m: number; d: number } {
  const z = z0 + 719468;
  const era = Math.floor((z >= 0 ? z : z - 146096) / 146097);
  const dayOfEra = z - era * 146097;
  const yearOfEra = Math.floor((dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365);
  const y = yearOfEra + era * 400;
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthOfEra = Math.floor((5 * dayOfYear + 2) / 153);
  const d = dayOfYear - Math.floor((153 * monthOfEra + 2) / 5) + 1;
  const m = monthOfEra + (monthOfEra < 10 ? 3 : -9);
  return { y: m <= 2 ? y + 1 : y, m, d };
}

/** 0 = Sunday. Derived from the civil date, so a timezone cannot shift a weekday off by a day. */
function weekdayOfCivil(y: number, m: number, d: number): number {
  return ((daysFromCivil(y, m, d) % 7) + 11) % 7;
}

const DOW_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_FULL = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const DOW_FULL = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const pad = (value: number, width = 2): string => String(Math.trunc(Math.abs(value))).padStart(width, "0");

/** ISO UTC text, built from the arithmetic above rather than from Date.prototype.toISOString. */
export function isoUtc(ms: number): string {
  const days = Math.floor(ms / 86_400_000);
  const rest = ms - days * 86_400_000;
  const civil = civilFromDays(days);
  const hour = Math.floor(rest / 3_600_000);
  const minute = Math.floor((rest % 3_600_000) / 60_000);
  const second = Math.floor((rest % 60_000) / 1000);
  const milli = rest % 1000;
  return `${pad(civil.y, 4)}-${pad(civil.m)}-${pad(civil.d)}T${pad(hour)}:${pad(minute)}:${pad(second)}.${pad(milli, 3)}Z`;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes && !days) parts.push(`${minutes}m`);
  if (!parts.length) parts.push(`${seconds}s`);
  return parts.join(" ");
}

const floorMinute = (ms: number): number => ms - ((((ms % 60_000) + 60_000) % 60_000));

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(tz: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(tz);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  });
  formatterCache.set(tz, created);
  return created;
}

export function isValidZone(tz: string): boolean {
  try {
    zoneFormatter(tz);
    return true;
  } catch {
    return false;
  }
}

interface Wall {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  /** 0 = Sunday, from the civil date rather than from a formatted weekday string. Optional because it is
   * derivable: callers that build a Wall by hand should not have to compute it. */
  dow?: number;
}

function instantToWall(ms: number, tz: string): Wall {
  const parts = zoneFormatter(tz).formatToParts(ms);
  const read = (kind: string): number => {
    const found = parts.find((part) => part.type === kind);
    const value = found ? Number.parseInt(found.value, 10) : Number.NaN;
    return Number.isFinite(value) ? value : 0;
  };
  const y = read("year");
  const mo = read("month");
  const d = read("day");
  return { y, mo, d, h: read("hour"), mi: read("minute"), dow: weekdayOfCivil(y, mo, d) };
}

const wallToEpoch = (wall: Wall): number =>
  daysFromCivil(wall.y, wall.mo, wall.d) * 86_400_000 + wall.h * 3_600_000 + wall.mi * 60_000;

const sameWall = (a: Wall, b: Wall): boolean =>
  a.y === b.y && a.mo === b.mo && a.d === b.d && a.h === b.h && a.mi === b.mi;

/**
 * Instant of a wall-clock time in a zone, or null when that wall time does not exist (the DST gap).
 *
 * Standard fixed-point on the zone offset: guess the instant from the wall time as if it were UTC, then
 * correct it with the offset that actually applied at the guess. Two corrections settle for every zone
 * the IANA database has, and the round trip decides whether the wall time was real. An ambiguous wall
 * time (the repeated hour on a fall-back night) settles on one of the two instants and is kept.
 */
export function wallToInstant(wall: Wall, tz: string): number | null {
  const target = wallToEpoch(wall);
  let guess = target - (wallToEpoch(instantToWall(target, tz)) - target);
  for (let step = 0; step < 3; step++) {
    const offset = wallToEpoch(instantToWall(guess, tz)) - guess;
    const corrected = target - offset;
    if (corrected === guess) break;
    guess = corrected;
  }
  return sameWall(instantToWall(guess, tz), wall) ? guess : null;
}

function machineZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function wallLabel(wall: Wall, tz: string): string {
  return `${wall.y}-${pad(wall.mo)}-${pad(wall.d)} ${pad(wall.h)}:${pad(wall.mi)} ${tz}`;
}

function describeInstant(ms: number, tz: string): string {
  const wall = instantToWall(ms, tz);
  const dow = wall.dow ?? weekdayOfCivil(wall.y, wall.mo, wall.d);
  return `${DOW_NAMES[dow]} ${wall.y}-${pad(wall.mo)}-${pad(wall.d)} ${pad(wall.h)}:${pad(wall.mi)} ${tz}`;
}

// ---------------------------------------------------------------------------
// Schedules: one-shot, fixed interval, or cron.
//
// Interval jobs carry their anchor. Without it a restart re-phases the job - an `every 6h` job created
// at 23:00 would fire at 05:00, 11:00, ... on one run and at 02:00, 08:00, ... after a restart, which
// makes "the 02:00 run" meaningless and breaks occurrence keys across the two runs. The anchor is
// persisted, so the phase and the keys survive.
// ---------------------------------------------------------------------------

interface FieldSet {
  star: boolean;
  values: number[];
}

interface CronSpec {
  text: string;
  tz: string;
  minute: FieldSet;
  hour: FieldSet;
  dom: FieldSet;
  month: FieldSet;
  dow: FieldSet;
}

/**
 * How an occurrence reaches the agent. followUp queues behind the current turn and starts one when idle;
 * steer injects into the turn in flight; nextTurn waits for a turn to attach to and never starts one.
 */
type DeliverAs = "followUp" | "steer" | "nextTurn";

export type Schedule =
  | { kind: "once"; at: number; tz: string }
  | { kind: "interval"; everyMs: number; anchor: number; tz: string }
  | { kind: "cron"; cron: string; tz: string };

type FieldKind = "minute" | "hour" | "dom" | "month" | "dow";

const FIELD_BOUNDS: Record<FieldKind, [number, number]> = {
  minute: [0, 59],
  hour: [0, 23],
  dom: [1, 31],
  month: [1, 12],
  dow: [0, 6],
};

const CRON_MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

function fieldTokenToNumber(token: string, kind: FieldKind): number | null {
  const trimmed = token.trim().toLowerCase();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const value = Number.parseInt(trimmed, 10);
    // Vixie cron accepts 7 as Sunday; normalise it instead of rejecting the whole expression.
    if (kind === "dow" && value === 7) return 0;
    return value;
  }
  const short = kind === "month" ? MONTH_NAMES : DOW_NAMES;
  const full = kind === "month" ? MONTH_FULL : DOW_FULL;
  const byShort = short.findIndex((name) => trimmed === name);
  if (byShort >= 0) return byShort;
  const byFull = full.findIndex((name) => trimmed === name);
  return byFull >= 0 ? byFull : null;
}

function parseField(raw: string, kind: FieldKind): FieldSet | null {
  const text = raw.trim();
  if (!text) return null;
  if (text === "*" || text === "?" || text === "L" || text === "last") {
    return { star: true, values: [] };
  }
  const [lo, hi] = FIELD_BOUNDS[kind];
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    if (rangePart === undefined || rangePart === "") return null;
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step <= 0) return null;
    let from: number | null;
    let to: number | null;
    if (rangePart === "*") {
      from = lo;
      to = hi;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-");
      from = fieldTokenToNumber(a ?? "", kind);
      to = fieldTokenToNumber(b ?? "", kind);
    } else {
      from = fieldTokenToNumber(rangePart, kind);
      to = from;
    }
    if (from === null || to === null) return null;
    // Ranges that wrap (fri-mon over the weekend) are legal cron and mean what a reader expects.
    // A range that wraps (fri-mon across a weekend, 22-02 across midnight) is legal cron and means
    // what a reader expects, so it walks the field circularly rather than being rejected.
    if (from <= to) {
      for (let value = from; value <= to; value += step) values.add(value);
    } else {
      const span = hi - lo + 1;
      const length = to - from + span;
      for (let offset = 0; offset < length; offset += step) values.add(lo + ((from - lo + offset) % span));
    }
    for (const value of values) if (value < lo || value > hi) return null;
  }
  return { star: false, values: [...values].sort((a, b) => a - b) };
}

export function parseCron(expression: string, tz: string): CronSpec | null {
  const expanded = CRON_MACROS[expression.trim().toLowerCase()];
  const text = (expanded ?? expression).trim();
  const fields = text.split(/\s+/);
  if (fields.length !== 5) return null;
  const minute = parseField(fields[0] ?? "", "minute");
  const hour = parseField(fields[1] ?? "", "hour");
  const dom = parseField(fields[2] ?? "", "dom");
  const month = parseField(fields[3] ?? "", "month");
  const dow = parseField(fields[4] ?? "", "dow");
  if (!minute || !hour || !dom || !month || !dow) return null;
  if (!minute.values.length && !minute.star) return null;
  return { text, tz, minute, hour, dom, month, dow };
}

/** Vixie's day rule: two restricted day fields are ORed, a star is not a constraint. */
function dayMatches(cron: CronSpec, day: { d: number; dow: number }): boolean {
  const byMonthDay = cron.dom.star || cron.dom.values.includes(day.d);
  const byWeekDay = cron.dow.star || cron.dow.values.includes(day.dow);
  if (!cron.dom.star && !cron.dow.star) return byMonthDay || byWeekDay;
  return byMonthDay && byWeekDay;
}

function matchesMonth(cron: CronSpec, month: number): boolean {
  return cron.month.star || cron.month.values.includes(month);
}

const allHours = (cron: CronSpec): number[] => (cron.hour.star ? Array.from({ length: 24 }, (_, i) => i) : cron.hour.values);
const allMinutes = (cron: CronSpec): number[] => (cron.minute.star ? Array.from({ length: 60 }, (_, i) => i) : cron.minute.values);

/**
 * Search a cron expression by walking whole days, then the hours and minutes inside the days that
 * qualify. Day-major iteration is what keeps this cheap: `0 0 29 2 *` inspects one candidate per day
 * rather than 1,440, and only the day the search starts on can spend a full minute sweep.
 *
 * `after`/`before` are exclusive. A DST-gap candidate converts to null and is skipped, which is the
 * honest outcome: that occurrence does not exist in that zone.
 */
function searchCron(cron: CronSpec, from: number, limitDays: number, direction: 1 | -1): number | null {
  const startWall = instantToWall(direction === 1 ? floorMinute(from) : from, cron.tz);
  const startDay = daysFromCivil(startWall.y, startWall.mo, startWall.d);
  const hours = allHours(cron);
  const minutes = allMinutes(cron);
  let best: number | null = null;
  const first = direction === 1 ? startDay : startDay - limitDays;
  const last = direction === 1 ? startDay + limitDays : startDay;
  for (let dayNumber = first; dayNumber <= last; dayNumber++) {
    const civil = civilFromDays(dayNumber);
    if (!matchesMonth(cron, civil.m)) continue;
    const weekday = weekdayOfCivil(civil.y, civil.m, civil.d);
    if (!dayMatches(cron, { d: civil.d, dow: weekday })) continue;
    for (const hour of hours) {
      for (const minute of minutes) {
        const instant = wallToInstant({ y: civil.y, mo: civil.m, d: civil.d, h: hour, mi: minute, dow: weekday }, cron.tz);
        if (instant === null) continue;
        if (direction === 1) {
          if (instant > from) return instant;
        } else if (instant < from) {
          best = instant;
        }
      }
    }
  }
  return best;
}

function periodOf(schedule: Schedule): number | null {
  if (schedule.kind === "interval") return schedule.everyMs;
  return null;
}

export function nextOccurrence(schedule: Schedule, from: number): number | null {
  switch (schedule.kind) {
    case "once":
      return schedule.at > from ? schedule.at : null;
    case "interval": {
      // Occurrences are anchor + n*period for n = 1, 2, 3 ... so `every 1h` means "in an hour, then every
      // hour", not "right now". The anchor is persisted, which is what makes a restart land on the same
      // grid instead of sliding the schedule forward.
      if (from < schedule.anchor) return schedule.anchor + schedule.everyMs;
      const steps = Math.max(1, Math.floor((from - schedule.anchor) / schedule.everyMs) + 1);
      const candidate = schedule.anchor + steps * schedule.everyMs;
      return candidate > from ? candidate : null;
    }
    case "cron": {
      const cron = parseCron(schedule.cron, schedule.tz);
      if (!cron) return null;
      return searchCron(cron, from, CRON_SEARCH_DAYS, 1);
    }
  }
}

/**
 * The most recent occurrence at or before `from` that is still inside the catch-up window. Bounded by
 * the window itself, so an occurrence older than the window is never found and simply ages out: no
 * bookkeeping is needed to skip a week-old job after a week-long outage.
 */
export function previousOccurrence(schedule: Schedule, from: number, windowMs: number): number | null {
  switch (schedule.kind) {
    case "once":
      return schedule.at <= from && schedule.at >= from - windowMs ? schedule.at : null;
    case "interval": {
      const steps = Math.floor((from - schedule.anchor) / schedule.everyMs);
      if (steps < 1) return null;
      const candidate = schedule.anchor + steps * schedule.everyMs;
      return candidate >= from - windowMs ? candidate : null;
    }
    case "cron": {
      const cron = parseCron(schedule.cron, schedule.tz);
      if (!cron) return null;
      // An unlimited catch-up window still cannot reach past the forward search horizon, and scanning
      // further than that would be a hang rather than a decision.
      const limitDays = Math.min(CRON_SEARCH_DAYS, Math.max(2, Math.ceil(windowMs / 86_400_000) + 1));
      const found = searchCron(cron, from, limitDays, -1);
      return found !== null && found >= from - windowMs ? found : null;
    }
  }
}

/**
 * The identity of one occurrence, spelled so every Pi computes the same string.
 *
 * A cron job is keyed by its wall occurrence (`w2026-11-06T0200`) rather than by the instant. On a
 * fall-back night the wall time 02:00 maps to two instants, and keying on the instant would run the job
 * twice that morning. Keying on the wall occurrence is what makes the promise this extension claims true
 * across a DST boundary: at most one run per scheduled occurrence. Interval and one-shot jobs are
 * instants by nature, so those are keyed by their epoch milliseconds.
 */
export function occurrenceKey(schedule: Schedule, instant: number): string {
  if (schedule.kind === "cron") {
    const wall = instantToWall(instant, schedule.tz);
    return `w${pad(wall.y, 4)}-${pad(wall.mo)}-${pad(wall.d)}T${pad(wall.h)}${pad(wall.mi)}`;
  }
  return `t${instant}`;
}

// ---------------------------------------------------------------------------
// Reading a time the way a person types one.
//
// Deliberately a small grammar rather than a clever one: every accepted shape is listed here, and a
// shape that does not match says so instead of guessing. The prompt is whatever is left over.
//
//   in 20m                      one-shot, relative
//   2026-11-06T02:00            one-shot, absolute (offset or Z accepted; a bare date is not)
//   2am / 14:30 / 2:30pm        wall time, one-shot at the next occurrence unless a recurrence follows
//   <wall> <tz>                 2am perth, 14:30 australia/brisbane, 02:00 utc+8
//   every day | daily | hourly | weekly | monthly      recurrence, optionally `at <wall> [tz]` after it
//   every monday | every mon,wed,fri                   recurrence on named days
//   every 6h | every 45m | every 3 days               recurrence by period
//   0 2 * * *                                         a cron expression, quoted or as five tokens
// ---------------------------------------------------------------------------

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && (trimmed.startsWith('"') || trimmed.startsWith("'")) && trimmed.endsWith(trimmed[0])) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function matchDuration(tokens: string[], index: number): { ms: number; used: number } | null {
  const token = tokens[index] ?? "";
  const inline = /^(\d+(?:\.\d+)?)([a-z]+)$/i.exec(token);
  if (inline) {
    const unit = UNITS[inline[2].toLowerCase()];
    if (!unit) return null;
    return { ms: Math.round(Number(inline[1]) * unit), used: 1 };
  }
  const bare = /^(\d+(?:\.\d+)?)$/.exec(token);
  if (bare) {
    const unit = UNITS[(tokens[index + 1] ?? "").toLowerCase().replace(/[.,]/g, "")];
    if (!unit) return null;
    return { ms: Math.round(Number(bare[1]) * unit), used: 2 };
  }
  return null;
}

function matchWall(tokens: string[], index: number): { wall: { h: number; mi: number }; used: number } | null {
  const token = (tokens[index] ?? "").toLowerCase().replace(/[.,]/g, "");
  let hour: number | null = null;
  let minute = 0;
  const clock = /^(\d{1,2}):(\d{2})(am|pm)?$/.exec(token);
  const spoken = /^(\d{1,2})(am|pm)$/.exec(token);
  if (clock) {
    hour = Number(clock[1]);
    minute = Number(clock[2]);
    if (clock[3] === "pm" && hour < 12) hour += 12;
    if (clock[3] === "am" && hour === 12) hour = 0;
  } else if (spoken) {
    hour = Number(spoken[1]);
    if (spoken[2] === "pm" && hour < 12) hour += 12;
    if (spoken[2] === "am" && hour === 12) hour = 0;
  }
  if (hour === null || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { wall: { h: hour, mi: minute }, used: 1 };
}

function titleCaseZone(token: string): string {
  return token
    .split("/")
    .map((part) => part.replace(/[_-]+/g, " ").replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/ /g, "_"))
    .join("/");
}

function matchZone(tokens: string[], index: number): { tz: string; used: number } | null {
  for (const width of [2, 1]) {
    const candidate = tokens.slice(index, index + width).join(" ").toLowerCase().replace(/[,.;]/g, "");
    if (candidate && TZ_ALIASES[candidate]) return { tz: TZ_ALIASES[candidate], used: width };
  }
  const token = tokens[index] ?? "";
  const offsetForm = /^(utc|gmt|etc)([+-]\d{1,2})$/i.exec(token);
  if (offsetForm) {
    // Etc/GMT+N is UTC-N in the zone database; a person typing `utc+8` means UTC+8, so the sign flips.
    const zone = `Etc/GMT${Number(offsetForm[2]) > 0 ? "-" : "+"}${Math.abs(Number(offsetForm[2]))}`;
    if (isValidZone(zone)) return { tz: zone, used: 1 };
    return null;
  }
  if (token.includes("/")) {
    const zone = titleCaseZone(token);
    if (isValidZone(zone)) return { tz: zone, used: 1 };
  }
  return null;
}

/**
 * The three delivery modes, read honestly.
 *
 * The CLI is strict and errors on `--deliver bogus`, but the storage layer cannot be: a job file is older than the
 * code reading it, and a value that was invalid when written must not brick every other schedule in the file. So it
 * falls back to `followUp`. That asymmetry is the trap - an operator who believes a job is set to `steer` gets a
 * quiet `followUp` and no indication why.
 *
 * The fallback is kept, because a broken schedule is worse than a default one, but it is stamped rather than hidden:
 * `list` and `show` say the value out loud, so the default never looks like a choice.
 */
export function readDeliverAs(value: unknown): { deliverAs: DeliverAs; deliverAsUnread?: string } {
  if (value === "steer" || value === "followUp" || value === "nextTurn") return { deliverAs: value };
  // Absent is not unreadable; it is the default, and saying so would be noise.
  if (value === undefined || value === null || value === "") return { deliverAs: "followUp" };
  return { deliverAs: "followUp", deliverAsUnread: String(value) };
}

function skipTimeNoise(tokens: string[], index: number): number {
  let cursor = index;
  while (TIME_NOISE.has((tokens[cursor] ?? "").toLowerCase().replace(/[,.;]/g, ""))) cursor++;
  return cursor;
}

const DOW_TOKEN = /^[a-z]{3}(,?[a-z]{3})*$/i;

interface ParsedWhen {
  schedule: Schedule;
  rest: number;
  summary: string;
}

export function parseWhen(tokens: string[], tz: string, now: number): ParsedWhen | null {
  const zone = tz;

  // `in 20m`
  if ((tokens[0] ?? "").toLowerCase() === "in") {
    const duration = matchDuration(tokens, 1);
    if (!duration) return null;
    const at = now + duration.ms;
    return { schedule: { kind: "once", at, tz: zone }, rest: 1 + duration.used, summary: `once in ${formatDuration(duration.ms)}` };
  }

  // `every ...` / `daily` / `hourly` with the recurrence leading
  const leading = (tokens[0] ?? "").toLowerCase();
  if (leading === "every" || leading === "each" || leading === "daily" || leading === "hourly" || leading === "weekly" || leading === "monthly") {
    const parsed = parseRecurrence(tokens, 0, zone, now);
    if (parsed) return parsed;
  }

  // A leading `cron` keyword is accepted because it is what this file itself prints: the summary of a cron job
  // renders as `cron 0 10 * * *`, and an agent that copies what it was shown must not be told the string is
  // unreadable. Before this the round trip was lossy in exactly the direction that matters - `list` emitted a shape
  // `add` rejected - and it failed silently rather than loudly, because `cron 0 6 * *` (the first five tokens) is
  // itself a *parseable-looking* candidate: letters are legal in a day-of-week field, so the shape test let the
  // keyword through and the expression died in parseCron. Reuse the rest of the parser rather than duplicating it,
  // so the quoted form `cron "0 6 * * 1"` works for free too.
  if (leading === "cron" && tokens.length > 1) {
    const stripped = parseWhen(tokens.slice(1), zone, now);
    if (stripped) return { ...stripped, rest: stripped.rest + 1 };
  }

  // A cron expression, quoted (one token, or a quoted run of tokens) or as five loose tokens.
  const first = tokens[0] ?? "";
  if (first.startsWith('"') || first.startsWith("'")) {
    const quote = first[0];
    if (first.length > 1 && first.endsWith(quote)) {
      const expression = first.slice(1, -1).trim();
      const cron = parseCron(expression, zone);
      if (cron) return { schedule: { kind: "cron", cron: expression, tz: zone }, rest: 1, summary: `cron ${expression} ${zone}` };
    } else {
      const closing = tokens.findIndex((token, i) => i > 0 && (token.endsWith('"') || token.endsWith("'")));
      if (closing > 0) {
        const expression = stripQuotes(tokens.slice(0, closing + 1).join(" "));
        const cron = parseCron(expression, zone);
        if (cron) return { schedule: { kind: "cron", cron: expression, tz: zone }, rest: closing + 1, summary: `cron ${expression} ${zone}` };
      }
    }
    // An unbalanced quote is not a cron expression, and stopping here would hide every other shape the
    // reader might have meant. Fall through and let the final "could not read that" explain it.
  }
  if (tokens.length >= 5) {
    const candidate = tokens.slice(0, 5).join(" ");
    // Every token has to look like a cron field, not just the joined string: without this, "1 in 2 the 3"
    // could be read as a schedule by an over-eager parser.
    const shaped = tokens.slice(0, 5).every((token) => /^[*?\dA-Za-z/,\-]+$/.test(token));
    const cron = shaped ? parseCron(candidate, zone) : null;
    if (cron) {
      return { schedule: { kind: "cron", cron: candidate, tz: zone }, rest: 5, summary: `cron ${candidate} ${zone}` };
    }
  }

  // A wall time, with an optional zone, then an optional recurrence.
  const wall = matchWall(tokens, 0);
  if (wall) {
    let cursor = wall.used;
    const zoneMatch = matchZone(tokens, cursor);
    if (zoneMatch) {
      cursor += zoneMatch.used;
      cursor = skipTimeNoise(tokens, cursor);
    }
    const effectiveZone = zoneMatch?.tz ?? zone;
    const recurrence = parseRecurrence(tokens, cursor, effectiveZone, now, wall.wall);
    if (recurrence) return recurrence;
    // No recurrence: the next wall time that matches, once.
    const cron = parseCron(`${wall.wall.mi} ${wall.wall.h} * * *`, effectiveZone);
    const at = cron ? searchCron(cron, now, 2, 1) : null;
    if (at === null) return null;
    return { schedule: { kind: "once", at, tz: effectiveZone }, rest: cursor, summary: `once at ${describeInstant(at, effectiveZone)}` };
  }

  // A bare duration with no `every`: `6h` as the whole `what`.
  const bare = matchDuration(tokens, 0);
  if (bare && bare.used >= 1) {
    const interval = { kind: "interval" as const, everyMs: bare.ms, anchor: now, tz: zone };
    return { schedule: interval, rest: bare.used, summary: `every ${formatDuration(bare.ms)}` };
  }

  // An absolute ISO datetime.
  const absolute = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(tokens[0] ?? "");
  if (absolute) {
    const [y, mo, d] = [Number(absolute[1].slice(0, 4)), Number(absolute[1].slice(5, 7)), Number(absolute[1].slice(8, 10))];
    const h = Number(absolute[2] ?? "0");
    const mi = Number(absolute[3] ?? "0");
    const seconds = Number(absolute[4] ?? "0");
    const marker = absolute[5];
    let instant: number | null;
    if (marker) {
      const offsetMatch = /^([+-])(\d{2}):?(\d{2})$/.exec(marker);
      const offsetMs = marker.toUpperCase() === "Z" ? 0 : (offsetMatch ? (offsetMatch[1] === "-" ? -1 : 1) * (Number(offsetMatch[2]) * 3_600_000 + Number(offsetMatch[3]) * 60_000) : 0);
      instant = daysFromCivil(y, mo, d) * 86_400_000 + h * 3_600_000 + mi * 60_000 + seconds * 1000 - offsetMs;
    } else {
      const zoneMatch = matchZone(tokens, 1);
      const effectiveZone = zoneMatch?.tz ?? zone;
      instant = wallToInstant({ y, mo, d, h, mi, dow: weekdayOfCivil(y, mo, d) }, effectiveZone);
      if (instant !== null) instant += seconds * 1000;
    }
    if (instant === null) return null;
    return { schedule: { kind: "once", at: instant, tz: zone }, rest: marker ? 1 : 1 + (matchZone(tokens, 1)?.used ?? 0), summary: `once at ${isoUtc(instant)}` };
  }

  return null;
}

/** `every <period>`, `every day at <wall> [tz]`, `every <weekday> [at <wall> [tz]]`, and the bare words. */
function parseRecurrence(
  tokens: string[],
  index: number,
  tz: string,
  now: number,
  wallGiven?: { h: number; mi: number },
): ParsedWhen | null {
  const cursor = index;
  const head = (tokens[cursor] ?? "").toLowerCase();
  let position = cursor;
  if (head === "every" || head === "each") position += 1;

  // Only leading/trailing punctuation is stripped: `mon,wed,fri` is a day list and must survive intact.
  const what = (tokens[position] ?? "").toLowerCase().replace(/^[,.;]+|[,.;]+$/g, "");
  const unit = UNITS[what];
  const duration = matchDuration(tokens, position);

  // `every 6h`, `every 45m`, `every 3 days` - a period, so an interval with a persisted anchor. A zone
  // after it is accepted and remembered for display only: a period is the same instant everywhere, and
  // it is the wall-clock forms above that have to care which zone "every day" means.
  if (duration) {
    let after = position + duration.used;
    const zoneMatch = matchZone(tokens, after);
    if (zoneMatch) after += zoneMatch.used;
    after = skipTimeNoise(tokens, after);
    const schedule: Schedule = { kind: "interval", everyMs: duration.ms, anchor: now, tz: zoneMatch?.tz ?? tz };
    return { schedule, rest: after, summary: `every ${formatDuration(duration.ms)}` };
  }

  // Named recurrence words. A cron expression carries the wall time, so DST moves with it.
  const named: Record<string, string> = {
    day: "0 0 * * *", daily: "0 0 * * *",
    hour: "0 * * * *", hourly: "0 * * * *",
    week: "0 0 * * 0", weekly: "0 0 * * 0",
    month: "0 0 1 * *", monthly: "0 0 1 * *",
    year: "0 0 1 1 *", yearly: "0 0 1 1 *",
  };
  let cronText: string | null = null;
  let used = position;

  if (unit === 86_400_000 && what !== "week" && what !== "month") {
    // `every day` reaches here as a unit word; `every 3 days` is a period and handled above.
    cronText = named.day;
    used = position + 1;
  } else if (named[what]) {
    cronText = named[what];
    used = position + 1;
  } else if (DOW_TOKEN.test(what) && what.length >= 3) {
    const days = what
      .split(",")
      .map((name) => {
        const short = name.trim().toLowerCase().slice(0, 3);
        const value = DOW_NAMES.indexOf(short);
        return value >= 0 ? String(value) : null;
      })
      .filter((value): value is string => value !== null);
    if (days.length) {
      cronText = `0 0 * * ${days.join(",")}`;
      used = position + 1;
    }
  }

  if (!cronText) return null;

  let cursorAfter = used;
  if ((tokens[cursorAfter] ?? "").toLowerCase().replace(/[,.;]/g, "") === "at") cursorAfter += 1;
  const clock = matchWall(tokens, cursorAfter);
  const wall = wallGiven ?? clock?.wall;
  if (clock && !wallGiven) cursorAfter += clock.used;
  const zoneMatch = wallGiven ? null : matchZone(tokens, cursorAfter);
  if (zoneMatch) cursorAfter += zoneMatch.used;
  cursorAfter = skipTimeNoise(tokens, cursorAfter);

  // A named recurrence with no wall time keeps its own default (`every week` is Sunday 00:00). With a
  // wall time, the day/month/day-of-week fields of the named pattern are kept and the time fields are
  // replaced, which is what "every week at 4pm" means.
  const expression = wall
    ? `${wall.mi} ${wall.h} ${cronText.split(" ").slice(2).join(" ")}`
    : cronText;
  const effectiveZone = zoneMatch?.tz ?? tz;
  const cron = parseCron(expression, effectiveZone);
  if (!cron) return null;
  return {
    schedule: { kind: "cron", cron: expression, tz: effectiveZone },
    rest: cursorAfter,
    summary: `cron ${expression} ${effectiveZone}`,
  };
}

// ---------------------------------------------------------------------------
// State on disk.
//
//   .pi/schedule.json                  declared jobs: committed, reviewable, updated by a git pull
//   .pi/schedule/jobs.jsonl            local jobs, as operations (add/remove/pause/resume)
//   .pi/schedule/events.jsonl          every fire and every skip, append-only
//   .pi/schedule/locks/<job>/<key>     one file per occurrence: whoever created it runs it
//   .pi/schedule/.gitignore            written once, so none of the above dirties the repository
// ---------------------------------------------------------------------------

interface Job {
  id: string;
  source: "declared" | "local";
  prompt: string;
  note?: string;
  /** Session-name pattern (or comma-separated patterns). Empty means any session may run it. */
  owner?: string;
  tz: string;
  schedule: Schedule;
  enabled: boolean;
  /** Skip the occurrence rather than queue it when this Pi is mid-answer. */
  skipIfBusy: boolean;
  deliverAs: DeliverAs;
  /**
   * Set when the stored value could not be read as a delivery mode and `deliverAs` is the fallback rather than a
   * choice. See `readDeliverAs`.
   */
  deliverAsUnread?: string;
  catchupMs: number;
  announce: boolean;
  /** Match peers by path suffix instead of the working directory itself. */
  repo?: string;
  createdAt: number;
}

interface Defaults {
  tz?: string;
  owner?: string;
  repo?: string;
  requireOwner?: boolean;
}

interface DeclaredFile {
  defaults?: Defaults;
  jobs?: unknown[];
}

interface JobRecord {
  op: "add" | "remove" | "pause" | "resume";
  id?: string;
  at?: number;
  prompt?: string;
  note?: string;
  owner?: string;
  tz?: string;
  schedule?: Schedule;
  enabled?: boolean;
  skipIfBusy?: boolean;
  deliverAs?: DeliverAs;
  catchupMs?: number;
  announce?: boolean;
  repo?: string;
}

interface EventRecord {
  at: number;
  op: "fired" | "skipped";
  id: string;
  key: string;
  reason?: string;
  session?: string;
  node?: string;
  wall?: string;
}

function safeId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

function slugFromText(value: string): string {
  // Up to six words, hyphens kept: a job id is what you type into `/schedule pause <id>`, so it should
  // look like the prompt it names. The full prompt is stored separately, so shortening costs nothing.
  const words = value.toLowerCase().replace(/[^a-z0-9 -]+/g, " ").trim().split(/\s+/).filter(Boolean);
  return safeId(words.slice(0, 6).join("-") || "job");
}

function parseFlagBlock(text: string): { flags: Record<string, string>; rest: string[] } {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  const valueful = new Set(["tz", "owner", "id", "note", "catchup", "deliver", "repo", "announce", "every", "cron", "at"]);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      rest.push(token);
      continue;
    }
    const name = token.slice(2).toLowerCase();
    if (name === "no-catchup") {
      flags.catchup = "none";
      continue;
    }
    if (name === "skip-if-busy" || name === "off") {
      flags[name] = "true";
      continue;
    }
    if (!valueful.has(name)) {
      flags[name] = "true";
      continue;
    }
    const value = tokens[index + 1];
    if (value === undefined) {
      flags[name] = "";
      continue;
    }
    flags[name] = stripQuotes(value);
    index += 1;
  }
  return { flags, rest };
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const records: T[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as T);
    } catch {
      // A torn line from a crash mid-append is skipped rather than poisoning the whole store.
    }
  }
  return records;
}

function appendJsonl(path: string, value: unknown): void {
  try {
    appendFileSync(path, `${JSON.stringify(value)}\n`);
  } catch {
    // State that cannot be written is reported by the command that asked for it, not thrown here.
  }
}

// ---------------------------------------------------------------------------
// The extension.
// ---------------------------------------------------------------------------

/** Date.now is called lazily, never captured: the tests drive this with faked timers. */
const nowMs = (): number => Date.now();

/** Print and JSON runs are one-shot checkouts: no ticking, no leases, no state writes. */
function isHeadless(ctx: ExtensionContext): boolean {
  return ctx.mode === "print" || ctx.mode === "json";
}

type ToolOutput = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };
const toolText = (text: string, details: Record<string, unknown> = {}): ToolOutput => ({ content: [{ type: "text", text }], details });

interface TeamPeer {
  id: string;
  name: string;
  cwd: string;
  project: string;
}

interface ScheduleEntryData {
  op: "fired" | "skipped";
  id: string;
  key: string;
  at: number;
  wall?: string;
  reason?: string;
  prompt?: string;
}

export default function (pi: ExtensionAPI) {
  let jobs = new Map<string, Job>();
  let declaredDefaults: Defaults = {};
  let viewStampValue = "";
  let loadProblems: string[] = [];
  let globalPaused = false;
  let ticking = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let tickIntervalMs = DEFAULT_TICK_MS;
  let lastCtx: ExtensionContext | undefined;
  let dir = "";
  let declaredPath = "";
  let eventsPath = "";
  let locksPath = "";
  const firedKeys = new Set<string>();
  /** Occurrences this session has already decided on, fired or not. Without it a lost lease would be
   * re-decided, and re-announced, on every tick until it aged out of the catch-up window. */
  const attempted = new Set<string>();
  const announcedUnowned = new Set<string>();
  const identity = { name: "", id: "", cwd: "" };
  const team = { path: "", available: false, stamp: "", readAt: 0, peers: [] as TeamPeer[] };

  const flagText = (name: string): string | undefined => {
    const value = pi.getFlag(name);
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };

  function machineZoneOr(flagZone: string | undefined): string {
    const candidate = flagZone ?? process.env.SCHEDULE_TZ;
    if (candidate && isValidZone(candidate)) return candidate;
    if (candidate) loadProblems.push(`SCHEDULE_TZ/--schedule-tz "${candidate}" is not a zone Intl accepts`);
    return machineZone();
  }

  // --- identity -----------------------------------------------------------

  function resolveIdentity(ctx: ExtensionContext): void {
    identity.cwd = resolve(ctx.cwd);
    identity.id = ctx.sessionManager.getSessionId() ?? `pid-${process.pid}`;
    identity.name =
      flagText("schedule-name") ??
      process.env.SCHEDULE_NAME ??
      pi.getSessionName() ??
      ctx.sessionManager.getSessionName() ??
      process.env.NAME ??
      "";
  }

  function patternToRegExp(pattern: string): RegExp {
    const escaped = pattern.trim().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    return new RegExp(`^${escaped}$`, "i");
  }

  function ownerPatterns(job: Job): string[] {
    const owner = job.owner ?? declaredDefaults.owner ?? "";
    return owner.split(",").map((part) => part.trim()).filter(Boolean);
  }

  function ownerAllows(job: Job): { ok: boolean; why?: string } {
    const patterns = ownerPatterns(job);
    if (!patterns.length) {
      if (declaredDefaults.requireOwner || process.env.SCHEDULE_REQUIRE_OWNER === "1") {
        return { ok: false, why: `no owner and SCHEDULE_REQUIRE_OWNER/requireOwner is set` };
      }
      return { ok: true };
    }
    if (!identity.name) return { ok: false, why: `job ${job.id} needs session name ${patterns.join("|")}, this session is unnamed` };
    if (patterns.some((pattern) => patternToRegExp(pattern).test(identity.name))) return { ok: true };
    return { ok: false, why: `job ${job.id} belongs to ${patterns.join("|")}, this session is "${identity.name}"` };
  }

  // --- stores -------------------------------------------------------------

  function openStores(ctx: ExtensionContext): void {
    const stateDir = process.env.SCHEDULE_STATE_DIR ?? join(ctx.cwd, CONFIG_DIR_NAME, "schedule");
    dir = resolve(stateDir);
    declaredPath = process.env.SCHEDULE_FILE ?? join(ctx.cwd, CONFIG_DIR_NAME, "schedule.json");
    eventsPath = join(dir, "events.jsonl");
    locksPath = join(dir, "locks");
    try {
      mkdirSync(dir, { recursive: true });
      mkdirSync(locksPath, { recursive: true });
      const ignore = join(dir, ".gitignore");
      if (!existsSync(ignore)) writeFileSync(ignore, "# Written by the pi-ed schedules extension: everything in here is\n# runtime state (jobs created in-session, fired/skipped audit, occurrence leases).\n*\n!.gitignore\n");
    } catch (error) {
      loadProblems.push(`state dir ${dir} is not writable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function fileStamp(target: string): string {
    try {
      const stat = statSync(target);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return "";
    }
  }

  /**
   * Both mutable sources of jobs: a committed schedule.json that a git pull changed, and a jobs.jsonl that
   * another session appended to (another node on the same checkout, when the repository is on shared
   * storage). One stat pair per tick is cheap next to the alternative, which is silently not knowing that
   * someone else added tonight's job.
   */
  function stateStamp(): string {
    return `${fileStamp(declaredPath)}\u0000${fileStamp(join(dir, "jobs.jsonl"))}`;
  }

  function serializeSchedule(schedule: Schedule): Schedule {
    if (schedule.kind === "cron") return { kind: "cron", cron: schedule.cron, tz: schedule.tz };
    if (schedule.kind === "interval") return { kind: "interval", everyMs: schedule.everyMs, anchor: schedule.anchor, tz: schedule.tz };
    return { kind: "once", at: schedule.at, tz: schedule.tz };
  }

  function reviveSchedule(value: Schedule | undefined): Schedule | null {
    if (!value || typeof value !== "object") return null;
    if (value.kind === "interval" && typeof value.everyMs === "number" && typeof value.anchor === "number") {
      const tz = isValidZone(value.tz ?? "") ? value.tz : machineZone();
      return { kind: "interval", everyMs: value.everyMs, anchor: value.anchor, tz };
    }
    if (value.kind === "once" && typeof value.at === "number") {
      const tz = isValidZone(value.tz ?? "") ? value.tz : machineZone();
      return { kind: "once", at: value.at, tz };
    }
    if (value.kind === "cron" && typeof value.cron === "string") {
      const tz = isValidZone(value.tz ?? "") ? value.tz : machineZone();
      if (!parseCron(value.cron, tz)) return null;
      return { kind: "cron", cron: value.cron, tz };
    }
    return null;
  }

  function buildJob(input: {
    id: string;
    prompt: string;
    schedule: Schedule;
    source: "declared" | "local";
    note?: string;
    owner?: string;
    enabled?: boolean;
    skipIfBusy?: boolean;
    deliverAs?: DeliverAs;
    deliverAsUnread?: string;
    catchupMs?: number;
    announce?: boolean;
    repo?: string;
    createdAt?: number;
  }): Job | string {
    const id = safeId(input.id);
    if (!id) return "a job id that is empty after sanitising";
    if (!input.prompt.trim()) return `job ${id}: no prompt`;
    const period = periodOf(input.schedule);
    const defaultCatchup = period ? Math.min(period, CATCHUP_PERIOD_CAP_MS) : DEFAULT_CATCHUP_MS;
    return {
      id,
      source: input.source,
      prompt: input.prompt.trim(),
      note: input.note?.trim() || undefined,
      owner: input.owner?.trim() || undefined,
      tz: input.schedule.tz,
      schedule: serializeSchedule(input.schedule),
      enabled: input.enabled !== false,
      skipIfBusy: input.skipIfBusy === true,
      deliverAs: readDeliverAs(input.deliverAs).deliverAs,
      deliverAsUnread: readDeliverAs(input.deliverAs).deliverAsUnread,
      catchupMs: input.catchupMs ?? defaultCatchup,
      announce: input.announce !== false,
      repo: input.repo?.trim() || undefined,
      createdAt: input.createdAt ?? Date.now(),
    };
  }

  function loadDeclaredJobs(ctx: ExtensionContext): Job[] {
    loadProblems = loadProblems.filter((problem) => !problem.startsWith("schedule.json"));
    if (!existsSync(declaredPath)) return [];
    if (!ctx.isProjectTrusted()) {
      loadProblems.push(`schedule.json was not loaded: this project is not trusted (a repository file that hands this session a prompt at 02:00 is exactly the kind of thing trust is for)`);
      return [];
    }
    let parsed: DeclaredFile;
    try {
      parsed = JSON.parse(readFileSync(declaredPath, "utf8")) as DeclaredFile;
    } catch (error) {
      loadProblems.push(`schedule.json is not readable JSON: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
    declaredDefaults = parsed.defaults ?? {};
    if (declaredDefaults.tz && !isValidZone(declaredDefaults.tz)) {
      loadProblems.push(`schedule.json defaults.tz "${declaredDefaults.tz}" is not a zone Intl accepts`);
      declaredDefaults.tz = undefined;
    }
    const out: Job[] = [];
    for (const raw of parsed.jobs ?? []) {
      const record = raw as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id : "";
      const prompt = typeof record.prompt === "string" ? record.prompt : "";
      const tz = typeof record.tz === "string" && isValidZone(record.tz) ? record.tz : (declaredDefaults.tz ?? defaultZone());
      let schedule: Schedule | null = null;
      if (typeof record.cron === "string" && parseCron(record.cron, tz)) schedule = { kind: "cron", cron: record.cron, tz };
      if (!schedule && typeof record.at === "string") {
        const parsedWhen = parseWhen(record.at.trim().split(/\s+/), tz, Date.now());
        if (parsedWhen) schedule = parsedWhen.schedule;
      }
      if (!schedule && typeof record.every === "string") {
        const parsedWhen = parseWhen(record.every.trim().split(/\s+/), tz, Date.now());
        if (parsedWhen) schedule = parsedWhen.schedule;
      }
      // A committed interval is phase-locked to the epoch, not to whenever this pod last restarted: a
      // `every 6h` in a repository means the same grid on every node and survives a deploy. Local jobs,
      // created by a person in a live session, keep their creation-time anchor so the first run is a
      // period away rather than immediate.
      if (schedule?.kind === "interval") schedule = { ...schedule, anchor: 0 };
      const catchupText = typeof record.catchup === "string" ? record.catchup.trim().toLowerCase() : undefined;
      const built = buildJob({
        id,
        prompt,
        schedule: schedule ?? { kind: "once", at: Number.NaN, tz },
        source: "declared",
        note: typeof record.note === "string" ? record.note : undefined,
        owner: typeof record.owner === "string" ? record.owner : declaredDefaults.owner,
        enabled: record.enabled !== false,
        skipIfBusy: record.skip_if_busy === true || record.skipIfBusy === true,
        deliverAs: readDeliverAs(record.deliver_as).deliverAs,
        deliverAsUnread: readDeliverAs(record.deliver_as).deliverAsUnread,
        catchupMs: catchupText === "always" ? Number.POSITIVE_INFINITY : catchupText === "none" ? 0 : catchupText ? (matchDuration(catchupText.split(/\s+/), 0)?.ms ?? undefined) : undefined,
        announce: record.announce !== false,
        repo: typeof record.repo === "string" ? record.repo : declaredDefaults.repo,
      });
      if (typeof built === "string") {
        loadProblems.push(`schedule.json: skipped a job (${built})`);
        continue;
      }
      if (!schedule) {
        loadProblems.push(`schedule.json: job "${built.id}" has no usable cron/at/every field`);
        continue;
      }
      out.push(built);
    }
    return out;
  }

  function defaultZone(): string {
    return machineZoneOr(flagText("schedule-tz"));
  }

  function replayLocalJobs(): Job[] {
    const out = new Map<string, Job>();
    for (const record of readJsonl<JobRecord>(join(dir, "jobs.jsonl"))) {
      if (!record || !record.id) continue;
      const id = safeId(record.id);
      if (record.op === "remove") {
        out.delete(id);
        continue;
      }
      if (record.op === "pause") {
        const existing = out.get(id);
        if (existing) out.set(id, { ...existing, enabled: false });
        continue;
      }
      if (record.op === "resume") {
        const existing = out.get(id);
        if (existing) out.set(id, { ...existing, enabled: true });
        continue;
      }
      if (record.op === "add") {
        const schedule = reviveSchedule(record.schedule);
        if (!schedule) continue;
        const built = buildJob({
          id,
          prompt: record.prompt ?? "",
          schedule,
          source: "local",
          note: record.note,
          owner: record.owner,
          enabled: record.enabled,
          skipIfBusy: record.skipIfBusy,
          deliverAs: readDeliverAs(record.deliverAs).deliverAs,
          deliverAsUnread: readDeliverAs(record.deliverAs).deliverAsUnread,
          catchupMs: record.catchupMs,
          announce: record.announce,
          repo: record.repo,
          createdAt: record.at,
        });
        if (typeof built === "string") continue;
        out.set(id, built);
      }
    }
    return [...out.values()];
  }

  function rebuildView(ctx: ExtensionContext): void {
    const declared = loadDeclaredJobs(ctx);
    const local = replayLocalJobs();
    const next = new Map<string, Job>();
    const problems: string[] = [];
    for (const job of declared) next.set(job.id, job);
    for (const job of local) {
      if (next.has(job.id)) {
        problems.push(`local job "${job.id}" is shadowed by the declared job of the same id (edit schedule.json to change it)`);
        continue;
      }
      next.set(job.id, job);
    }
    jobs = next;
    loadProblems = [...new Set([...loadProblems, ...problems])];
    viewStampValue = stateStamp();
  }

  function seedFiredKeys(): void {
    firedKeys.clear();
    const events = readJsonl<EventRecord>(eventsPath);
    for (const event of events.slice(-AUDIT_TAIL_LINES)) {
      if (event?.op === "fired" && event.id && event.key) firedKeys.add(`${event.id}\u0000${event.key}`);
    }
  }

  function pruneLocks(): void {
    const now = Date.now();
    let groups: string[] = [];
    try {
      groups = readdirSync(locksPath);
    } catch {
      return;
    }
    for (const group of groups) {
      const groupDir = join(locksPath, group);
      let names: string[] = [];
      try {
        names = readdirSync(groupDir);
      } catch {
        continue;
      }
      for (const name of names) {
        const full = join(groupDir, name);
        try {
          if (statSync(full).mtimeMs < now - LOCK_PRUNE_MS) unlinkSync(full);
        } catch {
          // Someone else is pruning the same tree; a missing file is not an error worth reporting.
        }
      }
    }
  }

  // --- cross-node view (pi-team-room, when it is installed) ---------------

  function teamStatePath(): string {
    const fromEnv = process.env.PI_TEAM_ROOM_STATE;
    if (fromEnv) return resolve(fromEnv);
    const roomDir = process.env.PI_TEAM_ROOM_DIR ?? join(homedir(), ".pi", "team-room");
    return join(roomDir, "state.json");
  }

  function readPeers(): TeamPeer[] {
    const path = teamStatePath();
    team.path = path;
    const now = nowMs();
    let stat;
    try {
      stat = statSync(path);
    } catch {
      team.available = false;
      return team.peers;
    }
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    if (team.available && team.stamp === stamp && now - team.readAt < 2000) return team.peers;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // A read that lands mid-write is not a reason to lose the last good view of who else is out there.
      team.available = true;
      return team.peers;
    }
    const sessions = (parsed as { sessions?: unknown[] }).sessions;
    const peers: TeamPeer[] = [];
    for (const raw of Array.isArray(sessions) ? sessions : []) {
      const session = raw as Partial<TeamPeer> & { connected?: boolean; lastSeenAt?: string };
      if (!session || typeof session.id !== "string") continue;
      if (session.connected === false) continue;
      if (typeof session.lastSeenAt === "string") {
        const seen = Date.parse(session.lastSeenAt);
        if (Number.isFinite(seen) && now - seen > TEAM_STALE_MS) continue;
      }
      peers.push({ id: session.id, name: session.name ?? "", cwd: session.cwd ?? "", project: session.project ?? "" });
    }
    team.peers = peers;
    team.stamp = stamp;
    team.readAt = now;
    team.available = true;
    return peers;
  }

  function repoMatch(job: Job, peer: TeamPeer): boolean {
    const repo = (job.repo ?? declaredDefaults.repo ?? "").trim();
    if (peer.cwd === identity.cwd || peer.project === identity.cwd) return true;
    if (!repo) return false;
    const suffix = repo.startsWith("/") ? repo : `/${repo}`;
    return peer.cwd === repo || peer.project === repo || peer.cwd.endsWith(suffix) || peer.project.endsWith(suffix);
  }

  function peersFor(job: Job): TeamPeer[] {
    const patterns = ownerPatterns(job);
    return readPeers().filter((peer) => {
      if (peer.id === identity.id) return false;
      if (patterns.length && !patterns.some((pattern) => patternToRegExp(pattern).test(peer.name))) return false;
      return repoMatch(job, peer);
    });
  }

  // --- occurrence decisioning ---------------------------------------------

  function catchUpWindow(job: Job): number {
    // A live session notices an occurrence within one tick of it being due, so the polling interval is
    // the floor of the window even when catch-up is switched off. `catchupMs` says how much *older* a
    // missed occurrence may be and still be worth running: it is about downtime, not about polling.
    const floor = tickIntervalMs * 2;
    if (job.catchupMs === Number.POSITIVE_INFINITY) return Number.MAX_SAFE_INTEGER;
    return Math.max(job.catchupMs, floor);
  }

  /** The most recent occurrence that was due and has not run. Only the newest one is worth running. */
  function missedOccurrence(job: Job, now: number): number | null {
    const window = catchUpWindow(job);
    if (window <= 0) return null;
    return previousOccurrence(job.schedule, now, window);
  }

  function claimLease(job: Job, instant: number): "won" | "lost" | "error" {
    const groupDir = join(locksPath, job.id);
    try {
      mkdirSync(groupDir, { recursive: true });
    } catch {
      // ignore: the write below reports the real problem
    }
    const key = occurrenceKey(job.schedule, instant);
    const file = join(groupDir, `${key}.lock`);
    const claim = JSON.stringify({ scheduled: key, at: isoUtc(instant), session: identity.name || "(unnamed)", id: identity.id, node: process.env.NODE_NAME ?? hostname() });
    try {
      writeFileSync(file, claim, { flag: "wx" });
      return "won";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return "lost";
      return "error";
    }
  }

  function releaseLease(job: Job, instant: number): void {
    try {
      unlinkSync(join(locksPath, job.id, `${occurrenceKey(job.schedule, instant)}.lock`));
    } catch {
      // A lease we cannot remove is a lease the next occurrence will outlive anyway.
    }
  }

  // --- firing -------------------------------------------------------------

  function logEvent(event: EventRecord): void {
    appendJsonl(eventsPath, event);
  }

  function announce(data: ScheduleEntryData, job?: Job): void {
    if (job && !job.announce) return;
    pi.appendEntry(ENTRY_TYPE, data);
  }

  function recordFired(job: Job, key: string, instant: number, why: string): void {
    firedKeys.add(`${job.id}\u0000${key}`);
    logEvent({ at: nowMs(), op: "fired", id: job.id, key, reason: why, session: identity.name || "(unnamed)", node: process.env.NODE_NAME ?? hostname(), wall: describeInstant(instant, job.tz) });
    announce({ op: "fired", id: job.id, key, at: instant, wall: describeInstant(instant, job.tz), prompt: job.prompt.slice(0, MAX_PROMPT_IN_ENTRY) }, job);
  }

  function recordSkipped(job: Job, instant: number, reason: string): void {
    const key = occurrenceKey(job.schedule, instant);
    logEvent({ at: nowMs(), op: "skipped", id: job.id, key, reason, session: identity.name || "(unnamed)", node: process.env.NODE_NAME ?? hostname(), wall: describeInstant(instant, job.tz) });
    announce({ op: "skipped", id: job.id, key, at: instant, wall: describeInstant(instant, job.tz), reason }, job);
  }

  async function runOccurrence(
    job: Job,
    instant: number,
    ctx: ExtensionContext,
    options: { force?: boolean; note?: string } = {},
  ): Promise<{ ran: boolean; why: string }> {
    // A manual run is keyed by when it happened, not by the schedule's occurrence key: a `/schedule run`
    // at 02:00 sharp must not consume tonight's occurrence and silently skip it.
    const key = options.force ? `manual-${isoUtc(instant).replace(/[:.]/g, "-")}` : occurrenceKey(job.schedule, instant);
    const gate = `${job.id}\u0000${key}`;
    if (!options.force) {
      if (attempted.has(gate)) return { ran: false, why: "already decided in this session" };
      if (firedKeys.has(gate)) return { ran: false, why: "already fired in this session" };
      attempted.add(gate);
    }

    const gateCheck = ownerAllows(job);
    if (!gateCheck.ok) return { ran: false, why: gateCheck.why ?? "owner gate" };

    if (job.skipIfBusy && !ctx.isIdle()) return { ran: false, why: "busy (skip_if_busy)" };

    if (!options.force) {
      const peers = peersFor(job);
      if (peers.length) {
        const ids = [...peers.map((peer) => peer.id), identity.id].sort();
        const winner = ids[0] ?? identity.id;
        if (winner !== identity.id) {
          return { ran: false, why: `team room election lost to ${winner}` };
        }
      }
      const lease = claimLease(job, instant);
      if (lease === "lost") return { ran: false, why: `lease held by another session (${key})` };
      if (lease === "error") return { ran: false, why: `lease could not be created in ${locksPath}` };
    }

    // The agent gets told which runbook this is, and whether it is the scheduled event or a rehearsal.
    const aside = options.force
      ? `run by hand at ${describeInstant(instant, job.tz)}; the schedule itself is unchanged`
      : options.note && options.note !== "scheduled"
        ? `scheduled run: ${options.note}`
        : "";
    const effective = aside ? `${job.prompt}\n\n(${aside})` : job.prompt;
    const text = `${job.id} · ${key} (${describeInstant(instant, job.tz)})${options.note ? ` · ${options.note}` : ""}${job.note ? ` · ${job.note}` : ""}`;
    try {
      // triggerTurn is what makes a 02:00 run happen in an idle session. deliverAs decides what happens
      // when it is not idle. "nextTurn" deliberately does not trigger: that job waits for a turn to attach
      // to instead of starting one of its own.
      pi.sendMessage(
        { customType: RUN_TYPE, content: effective, display: false, details: { jobId: job.id, occurrence: key, tz: job.tz, note: job.note } },
        { triggerTurn: job.deliverAs !== "nextTurn", deliverAs: job.deliverAs },
      );
    } catch (error) {
      releaseLease(job, instant);
      return { ran: false, why: `sendMessage failed: ${error instanceof Error ? error.message : String(error)}` };
    }

    recordFired(job, key, instant, options.note ?? (options.force ? "manual run" : "scheduled"));
    // A scheduled fire is the end of a `once` job: the wall-clock instant it promised has happened, and a
    // one-shot that quietly survives its own firing would fire again for a session that restarted.
    // A manual run is a rehearsal, so the job stays and still fires at the time it was given.
    if (job.schedule.kind === "once" && !options.force) appendJsonl(join(dir, "jobs.jsonl"), { op: "remove", id: job.id });
    ctx.ui.notify(`⏰ schedules · fired ${text}`, "info");
    renderStatus(ctx);
    return { ran: true, why: text };
  }

  async function tick(): Promise<void> {
    const ctx = lastCtx;
    if (!ctx || globalPaused || ticking) return;
    ticking = true;
    try {
      if (stateStamp() !== viewStampValue) rebuildView(ctx);
      const now = nowMs();
      resolveIdentity(ctx);
      const ordered = [...jobs.values()]
        .filter((job) => job.enabled)
        .map((job) => {
          const missed = missedOccurrence(job, now);
          const instant = missed ?? nextOccurrence(job.schedule, now);
          // A run that comes due within a tick of its wall time is on time, not a catch-up: the note is
          // for the occurrence a sleeping session actually slept through.
          return instant === null ? undefined : { job, instant, catchUp: missed !== null && now - missed > tickIntervalMs };
        })
        .filter((entry): entry is { job: Job; instant: number; catchUp: boolean } => entry !== undefined)
        .filter((entry) => entry.instant <= now)
        .sort((a, b) => a.instant - b.instant);
      for (const entry of ordered) {
        const result = await runOccurrence(entry.job, entry.instant, ctx, entry.catchUp ? { note: `catch-up of ${describeInstant(entry.instant, entry.job.tz)}` } : {});
        if (!result.ran && !result.why.startsWith("already ")) {
          // Every loss is worth one line: a lease lost to a sibling session, an occurrence this session is
          // not the owner of, an election lost to a lower session id. `attempted` means one line per
          // occurrence, not one per tick, which is what makes it information rather than noise.
          recordSkipped(entry.job, entry.instant, result.why);
        }
        if (result.ran) break;
      }
      renderStatus(ctx);
    } finally {
      ticking = false;
    }
  }

  // --- presentation -------------------------------------------------------

  function jobSummary(job: Job): string {
    const schedule = job.schedule;
    if (schedule.kind === "cron") return `cron ${schedule.cron} (${schedule.tz})`;
    if (schedule.kind === "interval") return `every ${formatDuration(schedule.everyMs)}`;
    return `once at ${isoUtc(schedule.at)} (${describeInstant(schedule.at, schedule.tz)})`;
  }

  function jobFlags(job: Job): string {
    const catchup = job.catchupMs === Number.POSITIVE_INFINITY ? "always" : job.catchupMs > 0 ? formatDuration(job.catchupMs) : "off";
    return [`owner ${ownerPatterns(job).join(",") || "(any session)"}`, `deliver ${job.deliverAs}${job.deliverAsUnread ? ` (unread "${job.deliverAsUnread}")` : ""}`, `catch-up ${catchup}`, job.skipIfBusy ? "skip-if-busy" : "queue when busy", job.announce ? "announce" : "quiet"].join("  ");
  }

  function describeJob(job: Job, now: number): string[] {
    const next = nextOccurrence(job.schedule, now);
    const gate = ownerAllows(job);
    const lines = [`${job.source === "declared" ? "declared" : "local   "} ${job.id}`];
    lines.push(`  ${jobSummary(job)}${job.enabled ? "" : "   [paused]"}`);
    lines.push(`  ${next === null ? "no future occurrence" : `next ${describeInstant(next, job.tz)} (in ${formatDuration(next - now)})`}${job.schedule.kind === "once" ? "   [removed after it fires]" : ""}`);
    if (job.note) lines.push(`  note ${job.note}`);
    lines.push(`  ${jobFlags(job)}`);
    if (!gate.ok) lines.push(`  !! ${gate.why}`);
    return lines;
  }

  function nextWallClock(job: Job, now: number): string {
    const next = nextOccurrence(job.schedule, now);
    if (next === null) return "";
    const wall = instantToWall(next, job.tz);
    return `${pad(wall.h)}:${pad(wall.mi)}`;
  }

  function renderStatus(ctx: ExtensionContext): void {
    if (isHeadless(ctx)) return;
    if (globalPaused) {
      ctx.ui.setStatus(STATUS_KEY, "⏸ schedules off");
      return;
    }
    const now = nowMs();
    const active = [...jobs.values()].filter((job) => job.enabled);
    const upcoming = active
      .map((job) => ({ job, next: nextOccurrence(job.schedule, now) }))
      .filter((entry): entry is { job: Job; next: number } => entry.next !== null)
      .sort((a, b) => a.next - b.next);
    if (!upcoming.length) {
      ctx.ui.setStatus(STATUS_KEY, `⏰ ${active.length} schedule(s), none due`);
      return;
    }
    const first = upcoming[0];
    const dueNow = first.next <= now;
    const text = `⏰ ${first.job.id} ${nextWallClock(first.job, now)} ${dueNow ? "due" : `in ${formatDuration(first.next - now)}`}${upcoming.length > 1 ? ` +${upcoming.length - 1}` : ""}`;
    ctx.ui.setStatus(STATUS_KEY, dueNow ? `⚠️ ${text}` : text);
  }

  // --- commands -----------------------------------------------------------

  function zoneFrom(flags: Record<string, string>, fallbackZone: string): string | null {
    const requested = flags.tz;
    if (!requested) return fallbackZone;
    const alias = TZ_ALIASES[requested.trim().toLowerCase()];
    if (alias) return alias;
    const candidate = isValidZone(requested) ? requested : isValidZone(titleCaseZone(requested)) ? titleCaseZone(requested) : "";
    return candidate || null;
  }

  function uniqueId(base: string, taken: Set<string>): string {
    const root = safeId(base) || "job";
    if (!taken.has(root)) return root;
    for (let suffix = 2; suffix < 100; suffix++) {
      const candidate = `${root}-${suffix}`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${root}-${nowMs()}`;
  }

  function applyFlags(job: Job, flags: Record<string, string>): Job | string {
    if (flags.id) job.id = safeId(flags.id);
    if (flags.owner) job.owner = flags.owner;
    if (flags.note) job.note = flags.note;
    if (flags.repo) job.repo = flags.repo;
    if (flags.deliver) {
      if (flags.deliver !== "steer" && flags.deliver !== "followUp" && flags.deliver !== "nextTurn") {
        return `--deliver must be followUp (queue, and start a turn when idle), steer (inject into the turn in flight), or nextTurn (wait for a turn, never start one), not "${flags.deliver}"`;
      }
      job.deliverAs = flags.deliver;
    }
    if (flags["skip-if-busy"]) job.skipIfBusy = true;
    if (flags.announce === "false") job.announce = false;
    if (flags.catchup) {
      if (flags.catchup === "none") job.catchupMs = 0;
      else if (flags.catchup === "always") job.catchupMs = Number.POSITIVE_INFINITY;
      else {
        const parsed = matchDuration(flags.catchup.split(/\s+/), 0);
        if (!parsed) return `--catchup takes a duration (3h), "none", or "always"`;
        job.catchupMs = parsed.ms;
      }
    }
    return job;
  }

  function requireOwnerPolicy(): boolean {
    return declaredDefaults.requireOwner === true || process.env.SCHEDULE_REQUIRE_OWNER === "1";
  }

  async function createJob(ctx: ExtensionContext, text: string, options: { requireRecurrence?: boolean } = {}): Promise<string> {
    if (isHeadless(ctx)) {
      return "schedules do not fire in print/JSON mode: nothing here stays alive to run a job later. Start a long-lived session (or `pi --schedules-off` if you only want to read them).";
    }
    resolveIdentity(ctx);
    const { flags, rest } = parseFlagBlock(text);
    if (!rest.length) return "nothing to schedule: give a time and a prompt";
    const zone = zoneFrom(flags, defaultZone());
    if (!zone) return `--tz "${flags.tz}" is not a zone this runtime knows. Try an IANA name such as Australia/Perth, or a name listed in the extension header.`;
    const parsed = parseWhen(rest, zone, nowMs());
    if (!parsed) {
      const lines = [
        "I could not read that as a time. The shapes accepted are:",
        "  /at in 20m <prompt>",
        "  /at 2am perth <prompt>            (or 14:30 australia/brisbane, 02:00 utc+8)",
        "  /at 2026-11-06T02:00 --tz Australia/Perth <prompt>",
        "  /every day at 2am perth <prompt>  (also: every 6h, every 45m, every monday at 4pm, daily, weekly)",
        "  /cron \"0 2 * * *\" --tz Australia/Perth <prompt>",
      ];
      if (options.requireRecurrence) lines.push("  (/every wants a recurrence: a bare `2am` or `in 20m` is one run, which is what /at is for)");
      return lines.join("\n");
    }
    if (options.requireRecurrence && parsed.schedule.kind === "once") {
      return `/every needs a recurrence (every 6h, every day at 2am perth, every monday). For one run use /at.`;
    }
    return createJobFromParts({ zone, parsed, promptWords: rest.slice(parsed.rest), flags }, ctx);
  }

  /**
   * The part of job creation that is not text parsing. `schedule_jobs add` comes here directly, because
   * round-tripping structured parameters through a command line is how quoting bugs get invented.
   */
  function createJobFromParts(parts: { zone: string; parsed: ParsedWhen; promptWords: string[]; flags: Record<string, string> }, ctx: ExtensionContext): string {
    const { parsed, promptWords, flags } = parts;
    if (!promptWords.length) return `no prompt after the time (${parsed.summary}). Add the instruction to run.`;
    const prompt = promptWords.join(" ").trim();

    const built = buildJob({
      id: uniqueId(slugFromText(prompt), new Set(jobs.keys())),
      prompt,
      schedule: parsed.schedule,
      source: "local",
      owner: declaredDefaults.owner,
    });
    if (typeof built === "string") return built;
    const job = applyFlags(built, flags);
    if (typeof job === "string") return job;
    job.tz = job.schedule.tz;
    if (jobs.has(job.id)) return `a job called "${job.id}" already exists here (pass --id <new-name> to pick another name)`;
    if (requireOwnerPolicy() && !ownerPatterns(job).length) {
      return `refusing to create "${job.id}" with no owner: this deployment requires --owner <session-name> (SCHEDULE_REQUIRE_OWNER / defaults.requireOwner).`;
    }
    const gateCheck = ownerAllows(job);
    appendJsonl(join(dir, "jobs.jsonl"), {
      op: "add",
      id: job.id,
      at: job.createdAt,
      prompt: job.prompt,
      note: job.note,
      owner: job.owner,
      tz: job.tz,
      schedule: serializeSchedule({ ...job.schedule, tz: job.tz }),
      enabled: job.enabled,
      skipIfBusy: job.skipIfBusy,
      deliverAs: job.deliverAs,
      catchupMs: Number.isFinite(job.catchupMs) ? job.catchupMs : Number.POSITIVE_INFINITY,
      announce: job.announce,
      repo: job.repo,
    });
    rebuildView(ctx);
    const stored = jobs.get(job.id);
    if (!stored) return `the job was written but did not load (check ${join(dir, "jobs.jsonl")})`;

    const now = nowMs();
    const next = nextOccurrence(stored.schedule, now);
    const lines = [`scheduled ${stored.id} · ${jobSummary(stored)}`];
    lines.push(`  next ${next === null ? "none" : `${describeInstant(next, stored.tz)} (in ${formatDuration(next - now)})`}`);
    lines.push(`  ${jobFlags(stored)}`);
    if (!gateCheck.ok) lines.push(`  !! ${gateCheck.why}`);
    else if (!ownerPatterns(stored).length && announcedUnowned.add(stored.id)) {
      lines.push(`  !! no owner: any Pi sitting in this repository can fire it (deduped by lease, not by identity). --owner <session-name> pins it, defaults.requireOwner makes it mandatory.`);
    }
    const peers = peersFor(stored);
    if (peers.length) {
      lines.push(`  team room sees ${peers.length} peer(s) for this repo (${peers.map((peer) => peer.name || peer.id).join(", ")}): the lowest session id runs each occurrence`);
    } else if (team.available) {
      lines.push(`  team room: no live peer for ${identity.cwd}, so this session runs it`);
    }
    lines.push(`  prompt that will be injected:\n    ${stored.prompt}`);
    return lines.join("\n");
  }

  function renderList(ctx: ExtensionContext): string {
    const now = nowMs();
    const entries = [...jobs.values()].sort((a, b) => a.id.localeCompare(b.id));
    const lines = [`${basename(identity.cwd) || identity.cwd} · ${identity.name || "(unnamed session)"} · default tz ${defaultZone()}${globalPaused ? " · PAUSED in this session" : ""}`];
    if (!entries.length) {
      lines.push("no jobs. /at in 30m <prompt>, /every day at 2am perth <prompt>, or declare them in .pi/schedule.json");
    }
    for (const job of entries) lines.push(...describeJob(job, now));
    if (loadProblems.length) lines.push(`!! ${loadProblems.join("\n!! ")}`);
    if (team.available) {
      const peers = readPeers();
      lines.push(`team room ${team.path}: ${peers.length} live peer(s)${peers.length ? ` (${peers.map((peer) => `${peer.name || "(unnamed)"}@${peer.project || peer.cwd}`).join(", ")})` : ""}`);
    } else {
      lines.push(`team room state not found at ${team.path}: cross-node election is off, so file leases are the only dedupe`);
    }
    return lines.join("\n");
  }

  async function scheduleCommand(ctx: ExtensionContext, args: string): Promise<string> {
    resolveIdentity(ctx);
    const tokens = args.trim().split(/\s+/).filter(Boolean);
    const sub = (tokens[0] ?? "list").toLowerCase();
    const id = tokens[1] ? safeId(tokens[1]) : "";

    if (sub === "off") {
      globalPaused = true;
      renderStatus(ctx);
      return "schedules paused in this session (in memory on purpose: a restart resumes firing). Jobs in other sessions keep running there.";
    }
    if (sub === "on") {
      globalPaused = false;
      renderStatus(ctx);
      return "schedules resumed in this session";
    }
    if (sub === "who") {
      const lines = [
        `session name   ${identity.name || "(unnamed)"}`,
        `session id     ${identity.id}`,
        `cwd            ${identity.cwd}`,
        `machine tz     ${machineZone()}`,
        `default tz     ${defaultZone()}`,
        `require owner  ${requireOwnerPolicy() ? "yes" : "no"}`,
        `mode           ${ctx.mode}`,
        `state dir      ${dir}`,
        `declared file  ${declaredPath}${existsSync(declaredPath) ? "" : " (absent)"}`,
        `team room      ${team.available ? team.path : `${team.path} (not found)`}`,
      ];
      const peers = readPeers();
      lines.push(`peers          ${peers.length ? peers.map((peer) => `${peer.name || "(unnamed)"} id=${peer.id} cwd=${peer.cwd} project=${peer.project}`).join("\n               ") : "none"}`);
      return lines.join("\n");
    }
    if (sub === "history") {
      const events = readJsonl<EventRecord>(eventsPath).slice(-40);
      const wanted = id;
      const shown = events.filter((event) => !wanted || event.id === wanted);
      if (!shown.length) return `no recorded events${wanted ? ` for ${wanted}` : ""} (file: ${eventsPath})`;
      return shown
        .map((event) => `${isoUtc(event.at)}  ${event.op === "fired" ? "FIRED  " : "skip   "} ${event.id}  ${event.key}  ${event.wall ?? ""}  ${event.reason ?? ""}  by ${event.session ?? "?"}@${event.node ?? "?"}`)
        .join("\n");
    }
    if (sub === "show") {
      const job = jobs.get(id);
      if (!job) return `no job "${id}"`;
      return describeJob(job, nowMs()).join("\n");
    }
    if (sub === "pause" || sub === "resume" || sub === "remove") {
      const job = jobs.get(id);
      if (!job) return `no job "${id}"`;
      if (job.source === "declared") {
        return `"${id}" is declared in ${declaredPath}. A slash command does not edit a committed file someone else has to review: set "enabled": false there, or delete the entry and it disappears on the next read.`;
      }
      appendJsonl(join(dir, "jobs.jsonl"), { op: sub === "pause" ? "pause" : sub === "resume" ? "resume" : "remove", id });
      rebuildView(ctx);
      renderStatus(ctx);
      return `${sub === "pause" ? "paused" : sub === "resume" ? "resumed" : "removed"} ${id}${sub === "remove" ? " (the audit and lease files stay)" : ""}`;
    }
    if (sub === "run") {
      const job = jobs.get(id);
      if (!job) return `no job "${id}"`;
      const result = await runOccurrence(job, nowMs(), ctx, { force: true, note: "manual run" });
      return result.ran ? `ran ${id} · ${result.why}` : `could not run ${id}: ${result.why}`;
    }
    if (sub === "list" || sub === "") {
      if (isHeadless(ctx)) {
        return [...jobs.values()].map((job) => `${job.id}\t${jobSummary(job)}\t${job.enabled ? "enabled" : "paused"}\t${ownerPatterns(job).join(",") || "(any)"}`).join("\n") || "no jobs";
      }
      return renderList(ctx);
    }
    return `unknown /schedule subcommand "${sub}". Try: list, show <id>, pause <id>, resume <id>, remove <id>, run <id>, off, on, who, history [id]`;
  }

  async function runCommandHandler(ctx: ExtensionContext, args: string): Promise<void> {
    const text = await scheduleCommand(ctx, args ?? "");
    ctx.ui.notify(text, text.startsWith("no ") || text.startsWith("unknown ") || text.startsWith("could not") ? "warning" : "info");
  }

  // --- wiring -------------------------------------------------------------

  pi.registerMessageRenderer<{ jobId?: string; occurrence?: string; tz?: string; note?: string }>(RUN_TYPE, (message, _options, theme) => {
    // The injected prompt is display:false, so this is what a replay shows rather than what a live run
    // draws. Returning undefined falls back to Pi's own custom-message rendering.
    const details = message.details as { jobId?: string; occurrence?: string; tz?: string } | undefined;
    const text = typeof message.content === "string" ? message.content : "";
    const head = theme.fg("accent", `⏰ scheduled run${details?.jobId ? ` · ${details.jobId}` : ""}${details?.occurrence ? ` @ ${details.occurrence}` : ""}`);
    return new Text(`${head}\n${theme.fg("customMessageText", text)}`, 1, 1);
  });

  pi.registerEntryRenderer<ScheduleEntryData>(ENTRY_TYPE, (entry, _options, theme) => {
    const data = entry as unknown as { type: string; data?: ScheduleEntryData };
    const info = data.data;
    if (!info) return new Text(theme.fg("muted", "⏰ schedules"), 1, 1);
    const mark = info.op === "fired" ? "⏰" : "⏸";
    const head = `${mark} schedules · ${info.op} ${info.id} @ ${info.wall ?? info.key}`;
    const tail = info.op === "fired" ? (info.prompt ? `: ${info.prompt}` : "") : info.reason ? ` (${info.reason})` : "";
    const lines = [theme.fg(info.op === "fired" ? "accent" : "muted", head)];
    if (tail) lines.push(theme.fg("muted", tail));
    return new Text(lines.join("\n"), 1, 1);
  });

  function startTicking(ctx: ExtensionContext): void {
    if (timer) clearInterval(timer);
    timer = undefined;
    const offFlag = pi.getFlag("schedules-off") === true || process.env.SCHEDULE_OFF === "1";
    globalPaused = offFlag;
    const ticks = Number(pi.getFlag("schedule-tick") ?? process.env.SCHEDULE_TICK_MS ?? DEFAULT_TICK_MS);
    const interval = Number.isFinite(ticks) && ticks >= 1000 ? Math.min(ticks, 15 * 60_000) : DEFAULT_TICK_MS;
    tickIntervalMs = interval;
    const headless = isHeadless(ctx);
    if (headless) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    timer = setInterval(() => {
      void tick();
    }, interval);
    void tick();
  }

  pi.on("session_start", async (_event, ctx) => {
    if (timer) clearInterval(timer);
    timer = undefined;
    jobs = new Map();
    firedKeys.clear();
    attempted.clear();
    declaredDefaults = {};
    loadProblems = [];
    team.peers = [];
    team.stamp = "";
    team.available = false;
    dir = "";
    if (isHeadless(ctx)) {
      // A throwaway instance must not claim tonight's occurrence or write state into someone else's checkout.
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    openStores(ctx);
    resolveIdentity(ctx);
    // tick() runs against lastCtx, and the first tick happens inside startTicking: without this line a
    // session that starts after its schedule was missed would not catch up until the second tick.
    lastCtx = ctx;
    rebuildView(ctx);
    seedFiredKeys();
    pruneLocks();
    startTicking(ctx);
    for (const problem of loadProblems) ctx.ui.notify(`⚠️ schedules · ${problem}`, "warning");
    const unowned = [...jobs.values()].filter((job) => job.enabled && !ownerPatterns(job).length);
    if (unowned.length) {
      ctx.ui.notify(
        `⚠️ schedules · ${unowned.length} job(s) have no owner and can fire from any Pi in ${identity.cwd}: ${unowned.map((job) => job.id).join(", ")}. Set "owner" per job, defaults.owner, or SCHEDULE_REQUIRE_OWNER=1.`,
        "warning",
      );
    }
    const upcoming = [...jobs.values()]
      .filter((job) => job.enabled)
      .map((job) => ({ job, next: nextOccurrence(job.schedule, nowMs()) }))
      .filter((entry) => entry.next !== null)
      .sort((a, b) => (a.next as number) - (b.next as number));
    if (upcoming.length && !globalPaused) {
      const first = upcoming[0];
      ctx.ui.notify(
        `⏰ schedules · ${upcoming.length} job(s) here, next ${first.job.id} ${describeInstant(first.next as number, first.job.tz)} (in ${formatDuration((first.next as number) - nowMs())}) · session ${identity.name || "(unnamed)"} · tz ${defaultZone()}`,
        "info",
      );
    }
    renderStatus(ctx);
  });

  pi.on("session_info_changed", async (_event, ctx) => {
    resolveIdentity(ctx);
    renderStatus(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (timer) clearInterval(timer);
    timer = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.registerFlag("schedules-off", { description: "Do not fire scheduled jobs in this session (jobs still run in other sessions)", type: "boolean", default: false });
  pi.registerFlag("schedule-name", { description: "Session identity to match job owners against, when the session name is not what owns this repository", type: "string" });
  pi.registerFlag("schedule-tz", { description: "Default IANA zone for schedules that do not name one", type: "string" });
  pi.registerFlag("schedule-tick", { description: "Milliseconds between schedule checks (1000-900000, default 20000)", type: "string" });

  const report = (ctx: ExtensionContext, text: string): void => {
    const problem = /^(no |nothing|I could not|refusing|a job called|\/every needs|unknown )/.test(text);
    ctx.ui.notify(text, problem ? "warning" : "info");
  };

  pi.registerCommand("at", {
    description: "Run a prompt once at a wall time (`/at 2am perth <prompt>`, `/at in 20m <prompt>`)",
    handler: async (args, ctx) => {
      lastCtx = ctx;
      report(ctx, await createJob(ctx, args ?? ""));
    },
  });

  pi.registerCommand("every", {
    description: "Run a prompt on a recurrence (`/every day at 2am perth <prompt>`, `/every 6h <prompt>`)",
    handler: async (args, ctx) => {
      lastCtx = ctx;
      // `/every day at 2am` and `/every every 6h` both mean the same thing; the reader should not have to
      // know which words the parser wants.
      const text = (args ?? "").trim();
      const prefixed = /^(every|each|daily|hourly|weekly|monthly|yearly)\b/i.test(text) ? text : `every ${text}`;
      report(ctx, await createJob(ctx, prefixed, { requireRecurrence: true }));
    },
  });

  pi.registerCommand("cron", {
    description: 'Declare a cron expression with a zone (`/cron "0 2 * * *" --tz Australia/Perth <prompt>`)',
    handler: async (args, ctx) => {
      lastCtx = ctx;
      report(ctx, await createJob(ctx, args ?? ""));
    },
  });

  pi.registerCommand("schedule", {
    description: "list | show <id> | pause | resume | remove | run <id> | off | on | who | history [id]",
    getArgumentCompletions: (prefix) => {
      const words = ["list", "show", "pause", "resume", "remove", "run", "off", "on", "who", "history"];
      const typed = prefix.trim();
      const pool = typed && words.some((word) => word.startsWith(typed)) ? words : [...words, ...jobs.keys()];
      return pool.map((value) => ({ value, label: value })).filter((item) => item.value.startsWith(typed));
    },
    handler: async (args, ctx) => {
      lastCtx = ctx;
      await runCommandHandler(ctx, args ?? "");
    },
  });

  pi.registerTool({
    name: "schedule_jobs",
    label: "Schedule jobs",
    description: [
      "Inspect and manage this repository's scheduled prompts.",
      "list shows what exists and whether this session may fire each one; add creates a local job (`at` accepts the same text as /at:",
      "`in 20m`, `2am perth`, `every day at 2am perth`, `every 6h`); show/pause/resume/remove change one job; run fires one immediately;",
      "next lists the upcoming wall times. Jobs declared in .pi/schedule.json are read-only here on purpose: a committed schedule",
      "belongs in a diff, so edit that file instead.",
    ].join(" "),
    promptSnippet: "Inspect or manage scheduled prompts in this repository (list, add, show, pause, resume, remove, run, next)",
    promptGuidelines: [
      "Use schedule_jobs with action list before proposing a new scheduled job, and never edit .pi/schedule.json from this tool.",
      "When adding a job for a wall time, pass tz as an IANA name (for example Australia/Perth) and keep the prompt self-contained: the injected message arrives with no conversation history attached to it.",
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"),
        Type.Literal("add"),
        Type.Literal("show"),
        Type.Literal("pause"),
        Type.Literal("resume"),
        Type.Literal("remove"),
        Type.Literal("run"),
        Type.Literal("next"),
      ]),
      id: Type.Optional(Type.String({ description: "Job id (required for show, pause, resume, remove, run)" })),
      at: Type.Optional(Type.String({ description: "When, in the shapes /at accepts: `in 20m`, `2am perth`, `every day at 2am perth`, `every 6h`, `2026-11-06T02:00`, or a five-field cron such as `0 2 * * *`. A leading `cron` keyword is also accepted, so a string copied out of `list` can be handed straight back to `add`." })),
      cron: Type.Optional(Type.String({ description: "Cron expression such as `0 2 * * *`, alternative to `at`" })),
      prompt: Type.Optional(Type.String({ description: "Text to inject when the job fires. Self-contained: a scheduled run has no conversation context." })),
      tz: Type.Optional(Type.String({ description: "IANA zone the schedule is expressed in, for example Australia/Perth. Defaults to the machine zone." })),
      owner: Type.Optional(Type.String({ description: "Session-name pattern allowed to fire this job, for example home-ops or home-*. Empty means any session in this repository." })),
      note: Type.Optional(Type.String({ description: "Context shown with the prompt: which runbook to read, which checkout to act on." })),
      skipIfBusy: Type.Optional(Type.Boolean({ description: "Skip an occurrence instead of queueing the prompt when this session is mid-answer" })),
      // The per-job flags a human reads in README.md have to be reachable from here too, or the tool is a subset of
      // the CLI and an agent quietly cannot do the thing its own documentation says is possible.
      deliverAs: Type.Optional(Type.Union([Type.Literal("followUp"), Type.Literal("steer"), Type.Literal("nextTurn")], { description: "How an occurrence reaches the agent. followUp (default) queues behind the current turn and starts one when idle; steer injects into the turn in flight; nextTurn waits for a turn to attach to and never starts one - so a nextTurn job will not fire an idle session at all." })),
      catchup: Type.Optional(Type.String({ description: "What to do with occurrences missed while the session was down: a duration such as `2h` (fire only if the miss is recent), `none` (never fire a missed occurrence), or `always` (fire every one). Defaults to always." })),
      repo: Type.Optional(Type.String({ description: "Repository the job belongs to, matched by path suffix. Defaults to the checkout the job was created in." })),
      announce: Type.Optional(Type.Boolean({ description: "false to keep runs of this job out of the team room; runs are announced unless told otherwise" })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      lastCtx = ctx;
      if (isHeadless(ctx)) {
        return toolText("schedules are inactive in print/json mode: a throwaway run neither fires a job nor claims a lease");
      }
      resolveIdentity(ctx);
      const action = params.action;
      const id = params.id ? safeId(params.id) : "";
      const now = nowMs();

      if (action === "list" || action === "next") {
        const rows = [...jobs.values()]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((job) => {
            const next = nextOccurrence(job.schedule, now);
            return {
              id: job.id,
              source: job.source,
              enabled: job.enabled,
              schedule: jobSummary(job),
              next: next === null ? null : isoUtc(next),
              nextWall: next === null ? null : describeInstant(next, job.tz),
              owner: ownerPatterns(job).join(",") || null,
              canFireHere: ownerAllows(job).ok,
              deliverAs: job.deliverAs,
            };
          });
        if (action === "next") {
          const upcoming = rows.filter((row) => row.enabled && row.next).map((row) => ({ id: row.id, next: row.next, wall: row.nextWall, schedule: row.schedule }));
          return toolText(upcoming.length ? JSON.stringify(upcoming, null, 2) : "nothing enabled and scheduled", { upcoming });
        }
        return toolText(JSON.stringify({ cwd: identity.cwd, session: identity.name, defaultZone: defaultZone(), mode: ctx.mode, jobs: rows, problems: loadProblems }, null, 2), { jobs: rows });
      }

      if (action === "add") {
        if (!params.prompt?.trim()) return toolText("add needs a prompt: the scheduled run has no conversation to inherit");
        resolveIdentity(ctx);
        const zone = params.tz ? zoneFrom({ tz: params.tz }, defaultZone()) : defaultZone();
        if (!zone) return toolText(`tz "${params.tz}" is not a zone this runtime knows`);
        const whenText = params.cron?.trim() ? `"${params.cron.trim()}"` : params.at?.trim() ?? "";
        if (!whenText) return toolText("add needs either `at` or `cron`");
        const parsed = parseWhen(whenText.split(/\s+/), zone, nowMs());
        if (!parsed) return toolText(`could not read "${whenText}" as a time. Try \`in 20m\`, \`2am perth\`, \`every 6h\`, \`every day at 2am perth\`, or a five-field cron`);
        const flags: Record<string, string> = {};
        if (params.owner) flags.owner = params.owner;
        if (params.note) flags.note = params.note;
        if (params.skipIfBusy) flags["skip-if-busy"] = "true";
        if (params.deliverAs) flags.deliver = params.deliverAs;
        if (params.catchup) flags.catchup = params.catchup;
        if (params.repo) flags.repo = params.repo;
        if (params.announce === false) flags.announce = "false";
        const text = createJobFromParts({ zone, parsed, promptWords: [params.prompt.trim()], flags }, ctx);
        return toolText(text, { result: text });
      }

      const job = jobs.get(id);
      if (!job) return toolText(`no job "${id}"`);
      if (action === "show") return toolText(describeJob(job, now).join("\n"), { job });
      if (action === "run") {
        const result = await runOccurrence(job, now, ctx, { force: true, note: "manual run" });
        return toolText(result.ran ? `fired ${job.id} · ${result.why}` : `${job.id}: ${result.why}`, { ran: result.ran });
      }
      if (job.source === "declared") {
        return toolText(`"${id}" is declared in ${declaredPath}; edit that file rather than changing a committed schedule from a tool`);
      }
      if (action === "pause" || action === "resume" || action === "remove") {
        appendJsonl(join(dir, "jobs.jsonl"), { op: action, id });
        rebuildView(ctx);
        renderStatus(ctx);
        return toolText(`${action === "pause" ? "paused" : action === "resume" ? "resumed" : "removed"} ${id}`, { id, action });
      }
      return toolText(`unsupported action ${action}`);
    },
  });
}
