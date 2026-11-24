import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { AssistantMessageComponent, createBashToolDefinition, createEditToolDefinition, createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition, createReadToolDefinition, createWriteToolDefinition, getMarkdownTheme, parseSessionEntries, SessionManager, ToolExecutionComponent, UserMessageComponent, type SessionEntry, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, matchesKey, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { errorText } from "./child.ts";
import { clean, contentText, delegateRenderers, renderDelegateNotice, type DelegateNotice } from "./presentation.ts";

type Command = "back" | "refresh" | "message";
export type Conversation = Awaited<ReturnType<typeof readConversation>>;

export async function readConversation(path: string) {
  const source = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const entries = parseSessionEntries(source);
  return SessionManager.inMemory(undefined, undefined, entries).getBranch().filter((entry) =>
    (entry.type === "message" && ["assistant", "user", "toolResult"].includes(entry.message.role)) ||
    (entry.type === "custom_message" && entry.display),
  ).slice(-60);
}

export function conversationPreview(entries: Conversation): string {
  for (const entry of entries.toReversed()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const text = clean(contentText(entry.message.content)).replace(/\s+/g, " ").trim();
    if (text) return `Latest reply: ${truncateToWidth(text, 72)}`;
  }
  return "No saved reply yet.";
}

function transcript(entries: readonly SessionEntry[], options: ViewOptions, expanded: boolean): Component[] {
  const { tui, theme, cwd, outputPad } = options;
  const markdown = getMarkdownTheme();
  const components: Component[] = [];
  const tools = new Map<string, ToolExecutionComponent>();
  const builtins = new Map<string, ToolDefinition<any, any, any>>([
    createReadToolDefinition(cwd), createBashToolDefinition(cwd), createEditToolDefinition(cwd), createWriteToolDefinition(cwd),
    createFindToolDefinition(cwd), createGrepToolDefinition(cwd), createLsToolDefinition(cwd),
  ].map((definition) => [definition.name, definition]));
  function tool(name: string, id: string, args: unknown) {
    const renderer = name === "delegate" ? delegateRenderers : builtins.get(name);
    const component = new ToolExecutionComponent(clean(name), id, args, { showImages: false, outputPad }, renderer, tui, cwd);
    component.setArgsComplete();
    component.setExpanded(expanded);
    tools.set(id, component);
    components.push(component);
    return component;
  }
  for (const entry of entries) {
    if (entry.type === "custom_message") {
      if (entry.customType === "delegate-notice") {
        const component = renderDelegateNotice({ ...entry, role: "custom", timestamp: Date.parse(entry.timestamp), details: entry.details as DelegateNotice | undefined }, {
          expanded, outputPad, keyHint: () => options.expandHint, keyText: () => "",
        }, theme);
        if (component) components.push(component);
      } else {
        const box = new Box(outputPad, 1, (line) => theme.bg("customMessageBg", line));
        box.addChild(new Markdown(clean(contentText(entry.content)), 0, 0, markdown));
        components.push(box);
      }
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message;
    switch (message.role) {
      case "user":
        components.push(new UserMessageComponent(clean(contentText(message.content)), markdown, outputPad));
        break;
      case "assistant": {
        const content = message.content.flatMap((block) => block.type === "text" ? [{ ...block, text: clean(block.text) }] : []);
        if (content.length || message.errorMessage) components.push(new AssistantMessageComponent({ ...message, content, errorMessage: message.errorMessage && clean(message.errorMessage) }, true, markdown, undefined, outputPad));
        for (const block of message.content) if (block.type === "toolCall") tool(block.name, block.id, block.arguments);
        break;
      }
      case "toolResult": {
        const row = tools.get(message.toolCallId) ?? tool(message.toolName, message.toolCallId, {});
        row.updateResult({ ...message, content: [{ type: "text", text: clean(contentText(message.content)) }] });
        break;
      }
    }
  }
  return components;
}

type ViewOptions = {
  title: () => string;
  path: string;
  cwd: string;
  messages: Conversation;
  question: () => string | undefined;
  messageAction: () => string | undefined;
  outputPad: number;
  tui: TUI;
  theme: Theme;
  expandKey: (data: string) => boolean;
  expandHint: string;
  done: (command: Command) => void;
};

export function conversationView(options: ViewOptions): Component & { dispose(): void } {
  const { tui, theme, done } = options;
  let messages = options.messages;
  let expanded = false;
  let components = transcript(messages, options, expanded);
  let lines: string[] = [];
  let lastWidth = 0;
  let top: number | undefined;
  let bottom = 0;
  let page = 1;
  let disposed = false;
  let revision = 0;
  let reload: ReturnType<typeof setTimeout> | undefined;
  let error: string | undefined;
  function redraw() { lastWidth = 0; tui.requestRender(); }
  function rebuild() { components = transcript(messages, options, expanded); redraw(); }
  function refresh() {
    clearTimeout(reload);
    const request = ++revision;
    reload = setTimeout(async () => {
      try {
        const snapshot = await readConversation(options.path);
        if (disposed || request !== revision) return;
        messages = snapshot;
        error = undefined;
        rebuild();
      } catch (failure) {
        if (disposed || request !== revision) return;
        error = clean(errorText(failure));
        redraw();
      }
    }, 80);
  }
  let watcher: ReturnType<typeof watch> | undefined;
  try {
    watcher = watch(dirname(options.path), (_event, file) => {
      if (!file || file === basename(options.path)) refresh();
      else if (file === "runs.json") tui.requestRender();
    });
    watcher.on("error", () => watcher?.close());
  } catch { /* Manual refresh is still available. */ }
  refresh(); // Catch messages saved between opening the snapshot and attaching the watcher.

  function move(delta: number) {
    const next = Math.max(0, Math.min(bottom, (top ?? bottom) + delta));
    top = next === bottom ? undefined : next;
    tui.requestRender();
  }
  return {
    render(width) {
      if (width < 1) return [];
      if (width !== lastWidth) {
        lines = components.flatMap((component) => component.render(width));
        lastWidth = width;
      }
      const question = options.question();
      const tail = question ? new Markdown(clean(question), options.outputPad, 0, getMarkdownTheme()).render(width) : [];
      const content = [...(lines.length ? lines : [theme.fg("muted", "No saved messages yet.")]),
        ...(question ? ["", theme.fg("warning", "Waiting for a reply"), ...tail] : []),
        ...(error ? [theme.fg("error", error.replace(/\n/g, " "))] : [])];
      if (tui.terminal.rows < 3) return [truncateToWidth(theme.fg("accent", options.title()), width)];
      page = tui.terminal.rows - 2;
      bottom = Math.max(0, content.length - page);
      if (top !== undefined) top = Math.min(top, bottom);
      const start = top ?? bottom;
      const shown = content.slice(start, start + page);
      while (shown.length < page) shown.push("");
      const action = options.messageAction();
      return [theme.fg("accent", options.title()), ...shown, theme.fg("muted", `Esc back · ${action ? `S ${action} · ` : ""}R refresh · ${options.expandHint} · ↑↓/PgUp/PgDn scroll`)]
        .map((line) => truncateToWidth(line, width));
    },
    invalidate() { components.forEach((component) => component.invalidate()); lastWidth = 0; },
    handleInput(data) {
      if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) done("back");
      else if (matchesKey(data, "r")) done("refresh");
      else if (options.messageAction() && matchesKey(data, "s")) done("message");
      else if (matchesKey(data, "up")) move(-1);
      else if (matchesKey(data, "down")) move(1);
      else if (matchesKey(data, "pageUp")) move(-page);
      else if (matchesKey(data, "pageDown")) move(page);
      else if (matchesKey(data, "home")) move(-Infinity);
      else if (matchesKey(data, "end")) { top = undefined; tui.requestRender(); }
      else if (options.expandKey(data)) { expanded = !expanded; rebuild(); }
    },
    handleMouse(event) {
      if (event.type !== "wheel") return;
      move(event.wheelDelta ?? 0);
      return { handled: true };
    },
    dispose() { disposed = true; clearTimeout(reload); watcher?.close(); },
  };
}
