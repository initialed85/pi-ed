/**
 * A fake Pi for the extensions.
 *
 * Pi loads an extension as a module whose default export is `function (pi: ExtensionAPI)`, then
 * drives it with lifecycle events and a per-call `ExtensionContext` (see
 * docs/extensions.md in the installed package). Nothing in this repo talks to a model, a provider
 * or a TUI, so the whole harness is a recording double: it keeps every registration the extension
 * makes and every call the extension performs, and the tests assert on those.
 *
 * Unknown API members throw instead of being silently absent. That is deliberate: the extensions
 * are characterised against a snapshot of the registrations they make today, so if one starts
 * using a Pi method the harness has not modelled, the test fails loudly rather than exercising a
 * half-built code path.
 */

export type AnyHandler = (...args: any[]) => any;

export interface ToolDefinitionLike {
  name: string;
  label?: string;
  description?: string;
  promptSnippet?: string;
  parameters?: unknown;
  outputSchema?: unknown;
  annotations?: Record<string, unknown>;
  execute?: (toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) => any;
  renderCall?: (args: any, theme: any, context: any) => any;
  renderResult?: (result: any, options: { expanded: boolean }, theme: any, context: any) => any;
  [key: string]: unknown;
}

export interface CommandDefinitionLike {
  description?: string;
  handler?: (args: string, ctx: any) => any;
  getArgumentCompletions?: (prefix: string) => any;
  [key: string]: unknown;
}

export interface RecordedNotification {
  message: string | undefined;
  level: string | undefined;
}

export interface RecordedCall {
  /** Which API member was called. */
  name: string;
  args: unknown[];
}

/** Everything the extension did to the outside world, in call order. */
export interface PiRecord {
  /** Lifecycle event names passed to `pi.on`, in registration order. Not `pi.events`, which is Pi's event bus. */
  lifecycleEvents: string[];
  tools: Map<string, ToolDefinitionLike>;
  commands: Map<string, CommandDefinitionLike>;
  flags: Map<string, { options: any; value: boolean | string | undefined }>;
  messageRenderers: Map<string, AnyHandler>;
  entryRenderers: Map<string, AnyHandler>;
  busChannels: Map<string, AnyHandler[]>;
  sentUserMessages: Array<{ content: unknown; options?: { deliverAs?: string } }>;
  appendedEntries: Array<{ type: string; data: unknown }>;
  sessionNames: string[];
  calls: RecordedCall[];
}

export interface FakePi extends PiRecord {
  on(event: string, handler: AnyHandler): () => void;
  registerTool(tool: ToolDefinitionLike): void;
  registerCommand(name: string, options: CommandDefinitionLike): void;
  registerFlag(name: string, options: any): void;
  registerMessageRenderer(customType: string, renderer: AnyHandler): void;
  registerEntryRenderer(customType: string, renderer: AnyHandler): void;
  getThinkingLevel(): string;
  /** Test helper: the real pi also has setThinkingLevel, with the same effect. */
  setThinkingLevel(level: string): void;
  getFlag(name: string): boolean | string | undefined;
  /** Test helper: Pi fills flags in from the CLI after extensions load. */
  setFlag(name: string, value: boolean | string | undefined): void;
  sendUserMessage(content: unknown, options?: { deliverAs?: string }): void;
  appendEntry(type: string, data?: unknown): void;
  getSessionName(): string | undefined;
  /** Handler(s) an extension registered for an event, in registration order. */
  handlersFor(event: string): AnyHandler[];
  /** Fire an event to every registered handler; returns each handler's result. */
  emit(event: string, payload: any, ctx: any): Promise<any[]>;
  /** Pi's internal event bus (`pi.events`), separate from the lifecycle handlers in `pi.on`. */
  events: { on: (channel: string, cb: AnyHandler) => () => void; emit: (channel: string, data: unknown) => void };
  setSessionName(name: string | undefined): void;
}

const UNIMPLEMENTED = (name: string) => () => {
  throw new Error(`harness: extension called unimplemented pi API "${name}"`);
};

export function createFakePi(): FakePi {
  const record: PiRecord = {
    lifecycleEvents: [],
    tools: new Map(),
    commands: new Map(),
    flags: new Map(),
    messageRenderers: new Map(),
    entryRenderers: new Map(),
    busChannels: new Map(),
    sentUserMessages: [],
    appendedEntries: [],
    sessionNames: [],
    calls: [],
  };
  const handlers = new Map<string, AnyHandler[]>();
  let sessionName: string | undefined;
  let thinkingLevel = "high";

  const track = (name: string) => (args: unknown[]) => record.calls.push({ name, args });

  const pi = {
    ...record,
    on(event: string, handler: AnyHandler) {
      record.lifecycleEvents.push(event);
      track(`on:${event}`)([handler]);
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {
        const current = handlers.get(event) ?? [];
        handlers.set(
          event,
          current.filter((candidate) => candidate !== handler),
        );
      };
    },
    registerTool(tool: ToolDefinitionLike) {
      track("registerTool")([tool.name, tool]);
      if (record.tools.has(tool.name)) throw new Error(`harness: duplicate registerTool "${tool.name}"`);
      record.tools.set(tool.name, tool);
    },
    registerCommand(name: string, options: CommandDefinitionLike) {
      track("registerCommand")([name, options]);
      if (record.commands.has(name)) throw new Error(`harness: duplicate registerCommand "${name}"`);
      record.commands.set(name, options);
    },
    registerFlag(name: string, options: any) {
      track("registerFlag")([name, options]);
      record.flags.set(name, { options, value: options?.default });
    },
    registerMessageRenderer(customType: string, renderer: AnyHandler) {
      track("registerMessageRenderer")([customType]);
      record.messageRenderers.set(customType, renderer);
    },
    registerEntryRenderer(customType: string, renderer: AnyHandler) {
      track("registerEntryRenderer")([customType]);
      record.entryRenderers.set(customType, renderer);
    },
    getThinkingLevel() {
      return thinkingLevel;
    },
    setThinkingLevel(level: string) {
      thinkingLevel = level;
    },
    getFlag(name: string) {
      const flag = record.flags.get(name);
      if (!flag) throw new Error(`harness: extension read unregistered flag "${name}"`);
      return flag.value;
    },
    setFlag(name: string, value: boolean | string | undefined) {
      const flag = record.flags.get(name);
      if (!flag) throw new Error(`harness: cannot set unregistered flag "${name}"`);
      flag.value = value;
    },
    sendUserMessage(content: unknown, options?: { deliverAs?: string }) {
      track("sendUserMessage")([content, options]);
      record.sentUserMessages.push({ content, options });
    },
    appendEntry(type: string, data?: unknown) {
      track("appendEntry")([type, data]);
      record.appendedEntries.push({ type, data });
    },
    getSessionName() {
      return sessionName;
    },
    setSessionName(name: string | undefined) {
      sessionName = name;
    },
    handlersFor(event: string) {
      return [...(handlers.get(event) ?? [])];
    },
    async emit(event: string, payload: any, ctx: any) {
      const list = handlers.get(event) ?? [];
      if (!list.length) throw new Error(`harness: no handler registered for "${event}"`);
      const results = [];
      for (const handler of list) results.push(await handler(payload, ctx));
      return results;
    },
    events: {
      on(channel: string, cb: AnyHandler) {
        track(`events.on:${channel}`)([channel]);
        const list = record.busChannels.get(channel) ?? [];
        list.push(cb);
        record.busChannels.set(channel, list);
        return () => {
          record.busChannels.set(
            channel,
            (record.busChannels.get(channel) ?? []).filter((candidate) => candidate !== cb),
          );
        };
      },
      emit(channel: string, data: unknown) {
        track(`events.emit:${channel}`)([channel, data]);
        for (const cb of record.busChannels.get(channel) ?? []) cb(data, undefined);
      },
    },
  } as FakePi;

  // Anything the extensions have not been written against fails the test instead of the agent.
  for (const method of ["registerToolProvider", "registerProvider", "setSessionName", "getThemes"]) {
    if (!(method in pi)) (pi as any)[method] = UNIMPLEMENTED(method);
  }
  return pi;
}

/** A UI that records instead of drawing. `hasUI: false` paths must not touch it. */
export interface FakeUi {
  notifications: RecordedNotification[];
  widgets: Map<string, unknown>;
  statuses: Map<string, string | undefined>;
  /** The factory `ui.setFooter` received, or undefined when the built-in footer is still in place. */
  footerFactory: ((tui: any, theme: any, footerData: any) => any) | undefined;
  notify: (message: string | undefined, level?: string) => void;
  setWidget: (key: string, value: unknown) => void;
  setStatus: (key: string, value: string | undefined) => void;
  setFooter: (factory: ((tui: any, theme: any, footerData: any) => any) | undefined) => void;
  [key: string]: unknown;
}

export function createFakeUi(): FakeUi {
  const ui: FakeUi = {
    notifications: [],
    widgets: new Map(),
    statuses: new Map(),
    footerFactory: undefined,
    notify: (message, level) => {
      ui.notifications.push({ message, level });
    },
    setWidget: (key, value) => {
      ui.widgets.set(key, value);
    },
    setStatus: (key, value) => {
      ui.statuses.set(key, value);
    },
    setFooter: (factory) => {
      ui.footerFactory = factory ?? undefined;
    },
  };
  for (const method of ["select", "confirm", "input", "custom", "setEditorText", "addAutocompleteProvider"]) {
    ui[method] = UNIMPLEMENTED(`ui.${method}`);
  }
  return ui;
}

export interface ContextOptions {
  mode?: "tui" | "rpc" | "print" | "json";
  hasUI?: boolean;
  cwd?: string;
  idle?: boolean;
  model?: any;
  contextUsage?: { percent: number | null } | undefined;
  signal?: AbortSignal | undefined;
  sessionFile?: string | undefined;
  sessionId?: string | undefined;
  sessionName?: string | undefined;
  /** Session entries the extension sees on its branch, oldest first. */
  branch?: any[];
  apiKeyResult?: { ok: true; apiKey?: string; headers?: Record<string, unknown>; env?: Record<string, string> } | { ok: false; error?: string };
  completeResult?: any;
  completeError?: Error;
}

/**
 * The context handed to command handlers and lifecycle events. `ui` is typed because tests assert on
 * what an extension showed the user; everything else is deliberately loose so the doubles can carry
 * whatever a future extension reads.
 */
export interface FakeContext {
  ui: FakeUi;
  [key: string]: any;
}

export interface ContextRecord {
  context: FakeContext;
  ui: FakeUi;
  calls: RecordedCall[];
  completed: Array<{ payload: any; options: any }>;
  newSessionArgs: Array<{ options: any; setupCalls: unknown[] }>;
  /**
   * Live counters, mutated by the context doubles. Handed out as one object rather than as plain
   * fields, because tests destructure the record and a snapshot of a number taken at destructure
   * time never moves.
   */
  state: { reloads: number; waitIdleCalls: number };
}

/**
 * An `ExtensionContext`/`ExtensionCommandContext` double. The caller decides what is idle, what
 * model is selected, what the model returns, and what the session file is; everything else is
 * recorded for assertions.
 */
export function createContext(options: ContextOptions = {}): ContextRecord {
  const calls: RecordedCall[] = [];
  const completed: Array<{ payload: any; options: any }> = [];
  const newSessionArgs: Array<{ options: any; setupCalls: unknown[] }> = [];
  const state = { reloads: 0, waitIdleCalls: 0 };
  let idle = options.idle ?? true;
  const ui = createFakeUi();
  const track = (name: string) => (args: unknown[]) => calls.push({ name, args });

  const sessionName = options.sessionName;
  // "not passed" and "passed as undefined" mean different things to these two getters, so the
  // defaults are resolved here rather than with `??` inside them.
  const sessionFile = "sessionFile" in options ? options.sessionFile : "/home/user/.pi/agent/sessions/abc.jsonl";
  const sessionId = "sessionId" in options ? options.sessionId : "11111111-1111-1111-1111-111111111111";

  const context: any = {
    ui,
    mode: options.mode ?? "tui",
    hasUI: options.hasUI ?? true,
    cwd: options.cwd ?? "/work",
    scopedModels: [],
    thinkingLevel: "high",
    // "no model selected" is a real state, so an explicit `model: undefined` must not fall back to
    // the default one.
    model: "model" in options ? options.model : { provider: "test-provider", id: "test-model", maxTokens: 32000 },
    signal: options.signal,
    isIdle: () => {
      track("isIdle")([]);
      return idle;
    },
    setIdle(value: boolean) {
      idle = value;
    },
    isProjectTrusted: () => true,
    hasPendingMessages: () => false,
    abort: () => {
      track("abort")([]);
    },
    shutdown: () => {
      track("shutdown")([]);
    },
    getContextUsage: () => {
      track("getContextUsage")([]);
      return options.contextUsage ?? { percent: 20, tokens: 20000, contextWindow: 100000 };
    },
    compact: () => {
      track("compact")([]);
    },
    getSystemPrompt: () => "system prompt",
    getSystemPromptOptions: () => ({}),
    sessionManager: {
      getSessionFile: () => {
        track("sessionManager.getSessionFile")([]);
        return sessionFile;
      },
      getSessionId: () => {
        track("sessionManager.getSessionId")([]);
        return sessionId;
      },
      getSessionName: () => {
        track("sessionManager.getSessionName")([]);
        return sessionName;
      },
      appendSessionInfo: (value: string) => {
        track("sessionManager.appendSessionInfo")([value]);
      },
      getBranch: (fromId?: string) => {
        track("sessionManager.getBranch")([fromId]);
        return options.branch ?? [];
      },
    },
    modelRegistry: {
      getApiKeyAndHeaders: async (model: any) => {
        track("modelRegistry.getApiKeyAndHeaders")([model]);
        return (
          options.apiKeyResult ?? {
            ok: true as const,
            apiKey: "test-api-key",
            headers: {},
            env: { TEST_PROVIDER_KEY: "test-api-key" },
          }
        );
      },
      complete: async (model: any, payload: any, opts: any) => {
        track("modelRegistry.complete")([model, payload, opts]);
        completed.push({ payload, options: opts });
        if (options.completeError) throw options.completeError;
        return (
          options.completeResult ?? {
            content: [{ type: "text", text: "please run the tests" }],
            stopReason: "stop",
            usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
          }
        );
      },
      getModels: () => [],
    },
    waitForIdle: async () => {
      state.waitIdleCalls++;
      track("waitForIdle")([]);
      idle = false;
    },
    reload: async () => {
      state.reloads++;
      track("reload")([]);
    },
    newSession: async (sessionOptions?: any) => {
      const setupCalls: unknown[] = [];
      newSessionArgs.push({ options: sessionOptions, setupCalls });
      track("newSession")([sessionOptions]);
      if (sessionOptions?.setup) {
        await sessionOptions.setup({
          appendSessionInfo: (value: string) => {
            setupCalls.push(value);
            track("sessionManager.appendSessionInfo(via setup)")([value]);
          },
        });
      }
      // Pi hands the withSession() callback a fresh context over the replaced session.
      await sessionOptions?.withSession?.({ ...context });
      return { cancelled: false };
    },
    fork: async () => ({ cancelled: false }),
    switchSession: async () => ({ cancelled: false }),
    navigateTree: async () => ({ cancelled: false }),
  };

  return {
    context,
    ui,
    calls,
    completed,
    newSessionArgs,
    state,
  };
}

/**
 * A `ReadonlyFooterDataProvider` double, for extensions that replace the footer.
 *
 * Pi hands a footer factory four things it cannot get elsewhere: the git branch, the statuses other
 * extensions set, how many providers are available, and a way to hear about branch changes. The last
 * one matters more than it looks - a footer built once at session start keeps a stale branch after
 * /tree or a checkout, so an extension that owns the footer has to subscribe. This double lets a test
 * flip the branch and assert the footer noticed.
 */
export function createFakeFooterData(options: { branch?: string | null; statuses?: Iterable<[string, string]>; providerCount?: number } = {}) {
  const statuses = new Map<string, string>(options.statuses ?? []);
  const subscribers: Array<() => void> = [];
  let branch: string | null | undefined = "branch" in options ? options.branch : "main";
  return {
    statuses,
    subscribers,
    getGitBranch: () => branch ?? null,
    getExtensionStatuses: () => statuses,
    getAvailableProviderCount: () => options.providerCount ?? 1,
    onBranchChange: (cb: () => void) => {
      subscribers.push(cb);
      return () => {
        const at = subscribers.indexOf(cb);
        if (at >= 0) subscribers.splice(at, 1);
      };
    },
    /** Test helper: Pi's own watcher fires this when .git/HEAD moves. */
    setBranch(value: string | null) {
      branch = value;
      for (const cb of [...subscribers]) cb();
    },
  };
}

/**
 * A theme that tags each string with the semantic colour it was rendered in. The renderers are
 * only worth testing if the tests can see which `theme.fg(...)` call produced which fragment.
 */
export const fakeTheme = {
  fg: (kind: string, text: string) => `[${kind}]${text}[/${kind}]`,
  bg: (kind: string, text: string) => `{${kind}}${text}{/${kind}}`,
  bold: (text: string) => `*${text}*`,
  dim: (text: string) => `~${text}~`,
  italic: (text: string) => `_${text}_`,
};

/** The text a `Text`/`Box` tree would paint, for renderer assertions. */
export function painted(rendered: any): string {
  if (rendered == null) return "";
  if (typeof rendered === "string") return rendered;
  const children = rendered.children ?? [];
  const own = typeof rendered.text === "string" ? rendered.text : "";
  if (!children.length) return own;
  return [own, ...children.map(painted)].filter(Boolean).join("\n");
}

/** Load an extension module with the module registry cleared, so module-level state is fresh. */
export async function loadExtension<T>(path: string): Promise<{ default: T }> {
  return (await import(/* @vite-ignore */ path)) as { default: T };
}

/** Convenience: run a command handler against a fresh context. */
export async function runCommand(
  pi: FakePi,
  name: string,
  args: string,
  context: any,
): Promise<void> {
  const command = pi.commands.get(name);
  if (!command) throw new Error(`harness: no command registered as "${name}"`);
  await command.handler?.(args, context);
}

/** Convenience: invoke a tool's execute() the way Pi does. */
export async function callTool(
  pi: FakePi,
  name: string,
  params: any,
  context: any,
  options: { toolCallId?: string; signal?: AbortSignal | undefined } = {},
) {
  const tool = pi.tools.get(name);
  if (!tool) throw new Error(`harness: no tool registered as "${name}"`);
  if (!tool.execute) throw new Error(`harness: tool "${name}" has no execute`);
  return tool.execute(options.toolCallId ?? "call-1", params, options.signal, undefined, context);
}
