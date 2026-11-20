import { readFile } from "node:fs/promises";
import { stripVTControlCharacters } from "node:util";
import { parseSessionEntries, SessionManager } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";

type Message = { label: string; text: string };
type Command = "back" | "refresh" | "message";
const clean = (text: string) => stripVTControlCharacters(text).replace(/\r\n?/g, "\n").replace(/\t/g, "  ").replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");

export async function readConversation(path: string): Promise<Message[]> {
  const source = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const entries = parseSessionEntries(source);
  const branch = SessionManager.inMemory(undefined, undefined, entries).getBranch();
  const messages: Message[] = [];
  for (let i = branch.length - 1; i >= 0 && messages.length < 60; i--) {
    const entry = branch[i];
    const message = entry.type === "message" ? entry.message : undefined;
    let label: string;
    let content: unknown;
    if (entry.type === "custom_message" && entry.display) {
      label = "Notice";
      content = entry.content;
    } else if (message?.role === "user" || message?.role === "assistant") {
      label = message.role === "user" ? "Input" : "Delegate";
      content = message.content;
    } else if (message?.role === "toolResult") {
      label = `${message.toolName}${message.isError ? " (error)" : ""}`;
      content = message.content;
    } else continue;
    let text = typeof content === "string" ? content : "";
    if (Array.isArray(content)) {
      text = content.flatMap((block) => {
        if (block.type === "text" && typeof block.text === "string") return [block.text];
        if (block.type === "toolCall" && typeof block.name === "string") return [`Called ${block.name}`];
        if (block.type === "image") return ["[Image]"];
        return [];
      }).join("\n");
    }
    const limit = message?.role === "toolResult" ? 1600 : 8000;
    text = clean(text).trim();
    if (text) messages.push({ label: clean(label), text: text.length > limit ? text.slice(0, limit).toWellFormed() + "\n…" : text });
  }
  return messages.reverse();
}

export function conversationPreview(messages: readonly Message[]): string {
  return messages.filter(({ label }) => label === "Input" || label === "Delegate").slice(-2)
    .map(({ label, text }) => `${label}: ${truncateToWidth(text.replace(/\s+/g, " "), 88)}`).join("\n");
}

export function conversationView(options: {
  title: string;
  messages: readonly Message[];
  question?: string;
  messageAction?: string;
  height: () => number;
  render: () => void;
  done: (command: Command) => void;
}): Component {
  const { title, messages, question, messageAction, height, done } = options;
  const body = messages.map(({ label, text }) => `${label}\n${text}`).join("\n\n") || "No saved messages yet.";
  const text = question ? `${body}\n\nWaiting for a reply\n${clean(question)}` : body;
  let top: number | undefined;
  let bottom = 0;
  let page = 1;
  let lastWidth = 0;
  let lines: string[] = [];
  function move(delta: number) {
    top = Math.max(0, Math.min(bottom, (top ?? bottom) + delta));
    options.render();
  }
  return {
    render(width) {
      if (width < 1) return [];
      if (width !== lastWidth) {
        lines = wrapTextWithAnsi(text, width);
        lastWidth = width;
      }
      page = Math.max(1, height() - 2);
      bottom = Math.max(0, lines.length - page);
      if (top !== undefined) top = Math.min(top, bottom);
      const start = top ?? bottom;
      const shown = lines.slice(start, start + page);
      while (shown.length < page) shown.push("");
      return [title, ...shown, `Esc back · ${messageAction ? `S ${messageAction} · ` : ""}R refresh · ↑↓/PgUp/PgDn scroll`]
        .map((line) => truncateToWidth(line, width));
    },
    invalidate() { lastWidth = 0; },
    handleInput(data) {
      if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) done("back");
      else if (matchesKey(data, "r")) done("refresh");
      else if (messageAction && matchesKey(data, "s")) done("message");
      else if (matchesKey(data, "up")) move(-1);
      else if (matchesKey(data, "down")) move(1);
      else if (matchesKey(data, "pageUp")) move(-page);
      else if (matchesKey(data, "pageDown")) move(page);
      else if (matchesKey(data, "home")) move(-Infinity);
      else if (matchesKey(data, "end")) { top = undefined; options.render(); }
    },
  };
}
