/**
 * SearXNG-backed web search for Pi.
 *
 * Registers a tool named `web_search`, which REPLACES the built-in
 * DuckDuckGo web_search (registerTool with a built-in's name replaces it
 * entirely — docs/extensions.md, "Tools"). Every session's web search now
 * goes through the home SearXNG instance:
 *
 *   https://searxng.dev.initialed85.cc   (home-dev, ns searxng)
 *
 * The ingress carries traefik-common-lan-tailscale-only, so callers outside
 * LAN/Tailscale get 403 — the tool says so explicitly. The JSON API exists
 * only because clusters/dev/applications/searxng/configmap.yaml lists
 * `formats: [html, json, csv, rss]`; keep that in sync if the ConfigMap
 * changes. Full service contract: ~/Projects/Home/home-ops/SERVICES.md.
 *
 * Override the endpoint with SEARXNG_URL (e.g. for a local container).
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const BASE_URL = (process.env.SEARXNG_URL ?? "https://searxng.dev.initialed85.cc").replace(/\/+$/, "");

const Params = Type.Object({
	query: Type.String({ description: "Search query" }),
	count: Type.Optional(Type.Number({ description: "Max results to return (default 8, max 25)" })),
	categories: Type.Optional(
		Type.String({
			description: "Comma-separated SearXNG categories: general, it, news, science, images, videos, music, files, social media",
		}),
	),
	time_range: Type.Optional(
		StringEnum(["day", "week", "month", "year"] as const, { description: "Recency window" }),
	),
	pageno: Type.Optional(Type.Number({ description: "Result page, 1-based (default 1)" })),
});

const Output = Type.Object({
	query: Type.String(),
	results: Type.Array(
		Type.Object({
			title: Type.String(),
			url: Type.String(),
			snippet: Type.String(),
			engines: Type.String(),
		}),
	),
	unresponsive_engines: Type.Array(Type.String()),
});

interface Details {
	query: string;
	count: number;
	unresponsive: string[];
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "web_search",
		description:
			"Web search via the home SearXNG metasearch instance (google, duckduckgo, bing, wikipedia, and many more). Returns ranked results with title, URL and snippet.",
		promptSnippet: "Web search via home SearXNG (LAN/Tailscale only)",
		parameters: Params,
		outputSchema: Output,
		annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const url = new URL("/search", BASE_URL);
			url.searchParams.set("q", params.query);
			url.searchParams.set("format", "json");
			if (params.categories) url.searchParams.set("categories", params.categories);
			if (params.time_range) url.searchParams.set("time_range", String(params.time_range));
			if (params.pageno) url.searchParams.set("pageno", String(params.pageno));

			const timeout = AbortSignal.timeout(30_000);
			const signals: AbortSignal[] = [timeout];
			if (signal) signals.push(signal);
			const sig = AbortSignal.any ? AbortSignal.any(signals) : timeout;

			let res: Response;
			try {
				res = await fetch(url, { signal: sig, headers: { accept: "application/json" } });
			} catch (e) {
				throw new Error(
					`searxng unreachable at ${BASE_URL}: ${e instanceof Error ? e.message : String(e)}. ` +
						"Connection refused/403 means you are outside LAN/Tailscale (traefik-common-lan-tailscale-only).",
				);
			}
			if (res.status === 403) {
				throw new Error(
					"searxng 403: the ingress allowlist (traefik-common-lan-tailscale-only) says this caller is not on LAN/Tailscale.",
				);
			}
			if (!res.ok) throw new Error(`searxng answered HTTP ${res.status}`);

			let data: any;
			try {
				data = await res.json();
			} catch {
				throw new Error(
					"searxng answered with non-JSON: format=json is disabled upstream by default; check `formats` in clusters/dev/applications/searxng/configmap.yaml.",
				);
			}

			const count = Math.min(Math.max(Math.floor(params.count ?? 8), 1), 25);
			const results: Array<{ title: string; url: string; snippet: string; engines: string }> = (
				Array.isArray(data.results) ? data.results : []
			)
				.slice(0, count)
				.map((r: any) => ({
					title: String(r?.title ?? "(untitled)").trim(),
					url: String(r?.url ?? ""),
					snippet: String(r?.content ?? "").replace(/\s+/g, " ").trim().slice(0, 400),
					engines: Array.isArray(r?.engines) ? r.engines.join(",") : "",
				}));
			const unresponsive = (Array.isArray(data.unresponsive_engines) ? data.unresponsive_engines : []).map(
				(e: any) => (Array.isArray(e) ? e.join(": ") : String(e)),
			);

			const query = String(data.query ?? params.query);
			let text: string;
			if (results.length === 0) {
				text = `No results for "${query}".` + (unresponsive.length ? ` Unresponsive engines: ${unresponsive.join(", ")}.` : "");
			} else {
				text = results
					.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`)
					.join("\n");
				if (unresponsive.length) text += `\n\n(unresponsive engines: ${unresponsive.join(", ")})`;
			}

			return {
				content: [{ type: "text" as const, text }],
				structuredContent: { query, results, unresponsive_engines: unresponsive },
				details: { query, count: results.length, unresponsive } as Details,
			};
		},

		renderCall(args, theme, _context) {
			let t = theme.fg("toolTitle", theme.bold("web_search ")) + theme.fg("accent", args.query);
			if (args.categories) t += theme.fg("dim", ` [${args.categories}]`);
			if (args.time_range) t += theme.fg("dim", ` <${args.time_range}>`);
			return new Text(t, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const d = result.details as Details | undefined;
			if (!d) return new Text("", 0, 0);
			const head = theme.fg("success", `${d.count} results for `) + theme.fg("accent", `"${d.query}"`);
			if (expanded) {
				const content = result.content[0];
				return new Text(head + "\n" + (content?.type === "text" ? content.text : ""), 0, 0);
			}
			return new Text(head + (d.unresponsive.length ? theme.fg("warning", ` (${d.unresponsive.length} engines unresponsive)`) : ""), 0, 0);
		},
	});
}
