/**
 * autopilot - the model writes the next prompt from the human's shoes.
 *
 * Loop (all in one agent run, append-only, so the main prompt prefix stays warm):
 *   agent answers and is about to settle (agent_before_settle)
 *   -> side call: "if you were the human, what prompt would you write next?"
 *   -> answer appended as a custom_message, which convertToLlm projects to role "user"
 *   -> continuation requested -> agent acts -> settles -> repeat
 *
 * The side call is deliberately cache-hostile (cacheRetention: "none", fresh sessionId,
 * small bounded brief, reasoning off): it never writes a provider cache entry, so the
 * session keeps a single growing cached prefix. Verified: side calls report
 * cacheRead=0 cacheWrite=0, and the brief is a few hundred tokens, not the session.
 *
 * Commands:
 *   /autopilot [goal]       arm; the optional text is the goal note
 *   /autopilot stop         disarm
 *   /autopilot status       counters
 *   /autopilot max <n>      hop limit (default 6, max 50)
 *   /autopilot goal <text>  set/clear the goal note
 *
 * Anti-drift: the brief always shows "THE REQUEST YOU MADE", and the human-voice has to
 * measure every candidate prompt against it, so progress is judged by what you actually
 * asked for and not by the model's own invention. Infinite loops are the failure mode this
 * loop is built to have, so the guard rails are the product, not the garnish.
 *
 * Headless (flags are filled in after extensions load, read at session_start):
 *   pi -p -e ~/.pi/agent/extensions/autopilot.ts --autopilot --autopilot-max 4 \
 *      --autopilot-goal "ship it" "the task"
 *
 * Guard rails: hop limit; the cat sentinel (🐈 = pi-team-room "done, nothing to add":
 * recorded as a transcript marker, never injected as a prompt; DONE/STOP/FINISHED are
 * accepted aliases); minimum five words (an answer is not a
 * prompt), refuses prompts already sent (including the opening request), refuses
 * a same-shape ask (number-folded shingle similarity >= 0.7, which catches "report 7.txt,
 * report 8.txt, report 9.txt" busywork loops), disarms on abort (Escape), disarms on
 * context > 85% of the window, and disarms when the operator steers a running session.
 * Input arriving while idle is a
 * new task, not a takeover, so arming before typing the task works. Extension-sourced
 * input (peers, other extensions) never disarms. Arm state is in memory: /resume and
 * /new start disarmed.
 *
 * Debug trace: AUTOPILOT_DEBUG=/tmp/autopilot.log pi ...
 */

import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
// AgentMessage is Pi's own type, but it comes out of the core package, not the coding-agent front
// door. It is a type-only import, so the runtime never noticed; tsc does.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message, UserMessage } from "@earendil-works/pi-ai";
import { Box, Text } from "@earendil-works/pi-tui";

const CUSTOM_TYPE = "autopilot";
const DEFAULT_MAX_HOPS = 128;
const MAX_PROMPT_CHARS = 1200;
const SIDE_CALL_MAX_TOKENS = 600;
const BRIEF_CHAR_BUDGET = 6000;
const CONTEXT_STOP_PERCENT = 85;
const SHAPE_STOP = 0.7;

const HUMAN_VOICE = `You are the human whose request started this session.

A coding agent has been working on it on its own, and you have to decide what you would type next.

Write the single prompt you would send next, in your own voice, as the human.

Rules:
- You are writing a prompt to send TO the agent. Never answer the agent, never restate its result, never output a filename, a value, a code block, or a summary.
- One to four imperative sentences. Be concrete: name files, commands, values, decisions, acceptance checks.
- React to what the agent actually reported. Accept it, probe it, challenge it, settle an open choice, supply information only you have, or redirect the agent when it wanders.
- Measure every candidate prompt against "THE REQUEST YOU MADE" in the brief. If a person reading this session would not recognise it as the next step of *that* request, it is not a prompt: reply the cat.
- Do not invent side quests the request never asked for (README files, gitignores, refactors, polish, "now look at X" tours) unless the request genuinely cannot finish without them.
- Never repeat a prompt you already sent, and never queue busywork: an ask that is the same action applied to the next item (the next file, the next folder, the next number) is not progress. When the only thing left is repetition, reply the cat.
- Never invent facts, files, credentials, hosts, or access you do not have. If the next step needs something only you can do (a password, a signature, a reboot, a physical action), write a prompt that hands that step back to you as a clear request, then stop.
- The request is satisfied and you have nothing left to ask: reply with exactly the cat, nothing else: 🐈 (it is the pi-team-room "done, no reply needed" acknowledgement. It ends the loop; it is not a prompt.)
- As the human, you don't have direct access to any tool calls (i.e. you can't promise "I'll test it now" and then actually do it); if you need any action taken, you need to include that as an instruction in your prompt so the agent can do it.`;

// The cat is the loop's full stop - same meaning as in the pi team room: "done, nothing to add".
// DONE/STOP/FINISHED are accepted aliases because models reach for them.
const STOP_SENTINEL = /^\s*(🐈|DONE|STOP|FINISHED)\s*[.!?]?\s*$/iu;

interface State {
	armed: boolean;
	hops: number;
	maxHops: number;
	goal?: string;
	prompts: string[];
}

const state: State = { armed: false, hops: 0, maxHops: DEFAULT_MAX_HOPS, prompts: [] };

function debug(message: string): void {
	const target = process.env.AUTOPILOT_DEBUG;
	if (!target) return;
	try {
		appendFileSync(target, `${new Date().toISOString()} ${message}\n`);
	} catch {
		/* debug logging is best effort */
	}
}

function clip(value: string, max: number): string {
	const clean = value.replace(/\s+/g, " ").trim();
	return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) =>
			part && typeof part === "object" && (part as { type?: string }).type === "text"
				? ((part as { text?: string }).text ?? "")
				: "",
		)
		.filter(Boolean)
		.join("\n");
}

/** Build the "what I know as the human" brief for the side call. Bounded and cheap. */
function brief(messages: AgentMessage[], st: State): string {
	const lines: string[] = [];
	let goalLine: string | undefined;

	for (const message of messages) {
		const role = (message as { role?: string }).role;
		const text = textOf((message as { content?: unknown }).content).trim();

		if (role === "user") {
			if (!goalLine && text) goalLine = `THE REQUEST YOU MADE: ${clip(text, 900)}`;
			else if (text) lines.push(`YOU ALSO SAID: ${clip(text, 300)}`);
			continue;
		}
		if (role === "custom") {
			if (text) lines.push(`THE PROMPT YOU ALREADY WROTE: ${clip(text, 300)}`);
			continue;
		}
		if (role === "assistant") {
			const content = (message as { content?: unknown[] }).content ?? [];
			const calls = content
				.filter((part) => part && typeof part === "object" && (part as { type?: string }).type === "toolCall")
				.map((part) => {
					const call = part as { name?: string; arguments?: Record<string, unknown> };
					const detail = call.arguments
						? (call.arguments.command as string) ??
							(call.arguments.path as string) ??
							(call.arguments.filePath as string) ??
							(call.arguments.query as string) ??
							""
						: "";
					return `${call.name}${detail ? ` ${clip(String(detail), 90)}` : ""}`;
				});
			if (text) lines.push(`THE AGENT SAID: ${clip(text, 700)}`);
			if (calls.length) lines.push(`THE AGENT RAN: ${calls.slice(-8).join(" | ")}`);
			continue;
		}
		if (role === "toolResult") {
			if (text) lines.push(`OUTPUT: ${clip(text, 220)}`);
			continue;
		}
	}

	// Keep the newest activity that fits the budget, goal always present.
	const recent: string[] = [];
	let used = goalLine?.length ?? 0;
	for (let i = lines.length - 1; i >= 0 && used < BRIEF_CHAR_BUDGET; i--) {
		recent.unshift(lines[i]);
		used += lines[i].length;
	}

	const promptLines: string[] = [];
	for (const previous of st.prompts) promptLines.push(`- ${clip(previous, 200)}`);
	const position = goalLine
		? ["# Your position", goalLine].join("\n")
		: "# Your position\n(Your original request is no longer visible; work from the agent's last reply.)";
	const goalNote = st.goal ? ["# Your standing goal note", clip(st.goal, 500)].join("\n") : "";
	const history = ["# What has happened since", ...(recent.length ? recent : ["(nothing yet)"])].join("\n");
	const asked = promptLines.length ? ["# Prompts you have already written", ...promptLines].join("\n") : "";

	const parts = [position, goalNote, history, asked].filter(Boolean);
	return parts.join("\n\n");
}

/** Strip fences/quotes a model wraps around the prompt it wrote. */
function sanitize(raw: string): string {
	let text = raw.trim();
	const fence = text.match(/^```[a-zA-Z0-9]*\n([\s\S]*?)\n```$/);
	if (fence) text = fence[1].trim();
	text = text.replace(/^(?:PROMPT|NEXT PROMPT|You:)\s*[:\-]?\s*/i, "");
	text = text.replace(/^["'`][\s\S]*["'`]$/, (m) => m.slice(1, -1).trim());
	return clip(text, MAX_PROMPT_CHARS);
}

function normalize(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Shape similarity. Tokens are number-folded (7.txt and 8.txt become the same token),
 * so "report the contents of 7.txt" and "report the contents of 8.txt" score ~1.0.
 * Catches the self-perpetuating loop where the human-voice invents novelty by applying
 * the same verb to the next item - busywork, not progress.
 */
function shape(text: string): Set<string> {
	const words = (text.toLowerCase().match(/[\p{L}\p{N}_'-]+/gu) ?? [])
		.map((word) => word.replace(/\d+/g, "#"))
		.filter((word) => word !== "#");
	const shingles = new Set<string>();
	for (let i = 0; i + 2 < words.length; i++) shingles.add(words.slice(i, i + 3).join(" "));
	if (shingles.size === 0 && words.length) shingles.add(words.join(" "));
	return shingles;
}

function shapeSimilarity(left: string, right: string): number {
	const a = shape(left);
	const b = shape(right);
	if (!a.size || !b.size) return 0;
	let overlap = 0;
	for (const shingle of a) if (b.has(shingle)) overlap++;
	return overlap / (a.size + b.size - overlap);
}

function closestShape(prompt: string, previous: string[]): { score: number; text: string } {
	let best = { score: 0, text: "" };
	for (const earlier of previous) {
		const score = shapeSimilarity(prompt, earlier);
		if (score > best.score) best = { score, text: earlier };
	}
	return best;
}

function armNote(): string {
	const parts = [`armed (max ${state.maxHops} hops)`];
	if (state.goal) parts.push(`goal: ${clip(state.goal, 80)}`);
	return `${parts.join(", ")}.`;
}

function firstUserText(messages: AgentMessage[]): string {
	for (const message of messages) {
		if ((message as { role?: string }).role !== "user") continue;
		const text = textOf((message as { content?: unknown }).content).trim();
		if (text) return text;
	}
	return "";
}

function wordCount(value: string): number {
	return (value.match(/\S+/g) ?? []).length;
}

function arm(nextMax?: number, goal?: string): void {
	state.armed = true;
	state.hops = 0;
	state.prompts = [];
	if (nextMax !== undefined) state.maxHops = Math.max(1, Math.min(50, nextMax));
	if (goal !== undefined) state.goal = goal;
}

function report(message: string, ctx: ExtensionContext, level: "info" | "warning" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(`autopilot: ${message}`, level);
}

function showStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(
		CUSTOM_TYPE,
		state.armed ? `⏩ autopilot hop ${state.hops}/${state.maxHops}` : undefined,
	);
}

export default function (pi: ExtensionAPI) {
	// Register flags first so the CLI accepts them; pi fills flag values in after all
	// extensions load, so read them from session_start, never from the factory.
	pi.registerFlag("autopilot", { description: "Arm the autopilot loop at session start", type: "boolean", default: false });
	pi.registerFlag("autopilot-max", { description: "Autopilot hop limit", type: "string", default: String(DEFAULT_MAX_HOPS) });
	pi.registerFlag("autopilot-goal", { description: "Autopilot goal note", type: "string" });

	pi.on("session_start", async (_event, ctx) => {
		debug(`session_start flag=${String(pi.getFlag("autopilot"))} max=${String(pi.getFlag("autopilot-max"))} mode=${ctx.mode}`);
		if (pi.getFlag("autopilot") === true) {
			const maxFlag = Number.parseInt(String(pi.getFlag("autopilot-max") ?? DEFAULT_MAX_HOPS), 10);
			const goalFlag = pi.getFlag("autopilot-goal");
			arm(Number.isFinite(maxFlag) ? maxFlag : undefined, goalFlag === undefined ? undefined : String(goalFlag));
			report(armNote(), ctx);
		}
		showStatus(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(CUSTOM_TYPE, undefined);
	});

	// The human typed *while the agent was working*: hand the wheel back. Input that
	// arrives while idle is the operator arming/queueing a task, not a takeover, so the
	// loop keeps its arm. Extension-sourced input (peers, other extensions) is never a takeover.
	pi.on("input", (event, ctx) => {
		const takeover = state.armed && event.source !== "extension" && !ctx.isIdle();
		debug(`input source=${event.source} idle=${ctx.isIdle()} takeover=${takeover}`);
		if (takeover) {
			state.armed = false;
			showStatus(ctx);
			report("disarmed - you took the wheel.", ctx);
		}
		return { action: "continue" };
	});

	pi.registerMessageRenderer(CUSTOM_TYPE, (message, _options, theme) => {
		const details = message.details as { hop?: number; maxHops?: number; signoff?: boolean } | undefined;
		const hop = details?.hop ? `${details.hop}/${details.maxHops}` : "";
		const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
		try {
			const label = details?.signoff
				? theme.fg("success", "🐈 the human has nothing left to ask - autopilot stopped")
				: theme.fg("warning", `⏩ autopilot${hop ? ` ${hop}` : ""} - the human's next prompt:`);
			box.addChild(new Text(`${label}\n${theme.fg("customMessageText", textOf(message.content))}`, 0, 0));
		} catch {
			// Fall back to pi's default custom message rendering.
			return undefined;
		}
		return box;
	});

	pi.registerCommand("autopilot", {
		description: "Run autonomously, asking the model to write the next human prompt",
		getArgumentCompletions: (prefix) => {
			// AutocompleteItem requires { value, label, description? }: pi's
			// getBestAutocompleteMatchIndex calls item.value.startsWith(prefix) with no guard,
			// so a completion item without a value takes down the whole TUI (uncaught TypeError
			// in a tick queue). Returning items with no value is a crash, not a cosmetic bug.
			try {
				const typed = prefix.trim().toLowerCase();
				const candidates: { value: string; label: string; description: string }[] = [
					{ value: "stop", label: "stop", description: "disarm the loop" },
					{ value: "status", label: "status", description: "hop counters and goal note" },
					{ value: "max 4", label: "max 4", description: "set the hop limit" },
					{ value: "max 8", label: "max 8", description: "set the hop limit" },
					{ value: "goal ", label: "goal ", description: "set the goal note, then arm" },
				];
				const hits = candidates.filter((item) => item.value.toLowerCase().startsWith(typed));
				return hits.length ? hits : null;
			} catch {
				return null;
			}
		},
		handler: async (args, ctx) => {
			const raw = args.trim();
			const [head, ...rest] = raw.split(/\s+/);
			const sub = (head ?? "").toLowerCase();

			if (sub === "stop") {
				state.armed = false;
				showStatus(ctx);
				report(`stopped after ${state.hops} hop(s).`, ctx);
				return;
			}
			if (sub === "status") {
				const statusParts = state.armed ? [`armed, hop ${state.hops}/${state.maxHops}`] : ["off. arm with /autopilot [goal]"];
				if (state.armed && state.goal) statusParts.push(`goal: ${clip(state.goal, 80)}`);
				report(statusParts.join(", "), ctx);
				return;
			}
			if (sub === "max") {
				const parsed = Number.parseInt(rest.join(" "), 10);
				if (!Number.isFinite(parsed) || parsed < 1) {
					report("usage: /autopilot max <n>", ctx, "warning");
					return;
				}
				state.maxHops = Math.min(1024, parsed);
				showStatus(ctx);
				report(`hop limit is ${state.maxHops}.`, ctx);
				return;
			}
			if (sub === "goal") {
				state.goal = rest.join(" ").trim() || undefined;
				report(state.goal ? `goal note set: ${clip(state.goal, 100)}` : "goal note cleared.", ctx);
				return;
			}

			arm(undefined, raw || state.goal);
			showStatus(ctx);
			report(`${armNote()} Stop with /autopilot stop, Escape, or by typing.`, ctx);
		},
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		debug(`settle armed=${state.armed} hops=${state.hops} outcome=${event.outcome} messages=${event.context.contextMessages.length}`);
		if (!state.armed) return;

		const stop = (message: string, level: "info" | "warning" = "info") => {
			state.armed = false;
			showStatus(ctx);
			report(message, ctx, level);
		};

		if (event.outcome === "aborted") return stop("disarmed by abort.");
		if (state.hops >= state.maxHops) return stop(`hop limit ${state.maxHops} reached.`);

		const usage = ctx.getContextUsage();
		if (usage?.percent !== null && usage?.percent !== undefined && usage.percent > CONTEXT_STOP_PERCENT) {
			return stop(`context at ${usage.percent.toFixed(0)}% of the window - run /compact and re-arm.`, "warning");
		}

		if (!ctx.model) return stop("no model selected.", "warning");

		const nextHumanPrompt = async (): Promise<string | undefined> => {
			const userMessage: UserMessage = {
				role: "user",
				content: [{ type: "text", text: brief(event.context.contextMessages, state) }],
				timestamp: Date.now(),
			};
			const response = await ctx.modelRegistry.complete(
				ctx.model!,
				{ systemPrompt: HUMAN_VOICE, messages: [userMessage as Message] },
				{
					signal: ctx.signal,
					cacheRetention: "none",
					sessionId: randomUUID(),
					maxTokens: SIDE_CALL_MAX_TOKENS,
					reasoning: "off",
				},
			);
			if (response.stopReason === "aborted") return undefined;
			debug(
				`side call usage stop=${response.stopReason} in=${response.usage?.input} out=${response.usage?.output} cacheRead=${response.usage?.cacheRead} cacheWrite=${response.usage?.cacheWrite}`,
			);
			if (response.stopReason === "error") {
				stop(`side call failed: ${response.errorMessage ?? "unknown error"}`, "warning");
				return undefined;
			}
			return sanitize(textOf(response.content));
		};

		const prompt = await nextHumanPrompt();
		debug(`side call -> ${JSON.stringify(prompt?.slice(0, 240))}`);
		if (!prompt) return; // stop() already reported, or the call produced nothing

		if (STOP_SENTINEL.test(prompt)) {
			stop("the human signed off with 🐈 - nothing left to ask, loop stopped.");
			// pi commits boundary entries even when continue is false (agent-session.js
			// _commitBoundaryDrafts), so the cat lands in the transcript as a marker for the
			// human and is never injected as a prompt.
			return {
				entries: [
					{
						type: "custom_message",
						customType: CUSTOM_TYPE,
						content: "🐈",
						display: true,
						details: { signoff: true, hop: state.hops, maxHops: state.maxHops },
					},
				],
				continue: false,
			};
		}
		// Under five words means it answered the agent's report instead of writing a prompt:
		// the human has nothing to ask, the work is done.
		if (wordCount(prompt) < 5) return stop("the human-voice answered instead of asking - treating the work as finished.");

		// Guard against the asks the human has already made, including the opening request.
		const previous = [...state.prompts, firstUserText(event.context.contextMessages)].filter(Boolean);
		if (previous.map(normalize).includes(normalize(prompt))) {
			return stop("the human-voice repeated a prompt already sent; refusing to ping-pong.", "warning");
		}
		const lookalike = closestShape(prompt, previous);
		if (lookalike.score >= SHAPE_STOP) {
			const label = state.prompts.includes(lookalike.text)
				? `hop ${state.prompts.indexOf(lookalike.text) + 1}`
				: "the original request";
			return stop(
				`the human-voice queued the same shape of ask as ${label} (${(lookalike.score * 100).toFixed(0)}% alike) - treating the work as finished.`,
				"warning",
			);
		}

		state.hops += 1;
		state.prompts.push(prompt);
		showStatus(ctx);

		return {
			entries: [
				{
					type: "custom_message",
					customType: CUSTOM_TYPE,
					content: prompt,
					display: true,
					details: { hop: state.hops, maxHops: state.maxHops, goal: state.goal },
				},
			],
			continue: true,
		};
	});
}
