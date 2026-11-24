import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { conversationPreview, conversationView, readConversation } from "../src/conversation.ts";
import { renderDelegateNotice } from "../src/presentation.ts";

const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;

test("conversation inspection reads the saved branch without changing it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-delegate-view-"));
  const path = join(dir, "child.jsonl");
  try {
    assert.deepEqual(await readConversation(path), []);
    const entry = (id: string, parentId: string | null, message: object) => ({ type: "message", id, parentId, message });
    const contents = [
      { type: "session", version: 3, id: "child", cwd: dir },
      entry("a", null, { role: "system", content: "System instructions" }),
      entry("b", "a", { role: "user", content: "Review the draft" }),
      entry("c", "b", { role: "assistant", content: [{ type: "text", text: "Old branch" }] }),
      entry("d", "b", { role: "assistant", content: [{ type: "thinking", thinking: "hidden reasoning" }, { type: "toolCall", name: "read" }, { type: "text", text: "\x1b[31mReviewing 🧪\x1b[0m" }] }),
      entry("e", "d", { role: "toolResult", toolName: "read", content: [{ type: "text", text: "Draft contents" }] }),
    ].map((item) => JSON.stringify(item)).join("\n") + '\n{"type":';
    writeFileSync(path, contents);
    const messages = await readConversation(path);
    assert.deepEqual(messages.map(({ id }) => id), ["b", "d", "e"]);
    assert.equal(conversationPreview(messages), "Latest reply: Reviewing 🧪");
    assert.equal(readFileSync(path, "utf8"), contents);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("conversation view renders native tool blocks, expands them, and follows new messages", { timeout: 5000 }, async (t) => {
  initTheme("dark", false);
  const dir = mkdtempSync(join(tmpdir(), "pi-delegate-view-"));
  const path = join(dir, "child.jsonl");
  const timestamp = new Date().toISOString();
  const command = { role: "assistant", content: [{ type: "text", text: "**Checking**" }, { type: "toolCall", name: "delegate", id: "call", arguments: { action: "info", id: "cD" } }] };
  const result = { role: "toolResult", toolName: "delegate", toolCallId: "call", content: [{ type: "text", text: "State\n" + "metadata\n".repeat(10) + "LAST DETAIL" }] };
  const entries = [{ type: "session", version: 3, id: "child", cwd: dir, timestamp }, ...[command, result].map((message, i) => ({ type: "message", id: String(i), parentId: i ? "0" : null, timestamp, message }))];
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const actions: string[] = [];
  let refresh = Promise.withResolvers<void>();
  const view = conversationView({
    title: () => "Root › [aB] › [cD] Review", messages: await readConversation(path), path, cwd: dir,
    question: () => "Which option?", messageAction: () => "Reply", outputPad: 1,
    tui: { terminal: { rows: 30 }, requestRender: () => refresh.resolve() } as TUI,
    theme,
    expandKey: (key) => key === "\x0f", expandHint: "Ctrl+O to expand", done: (action) => { actions.push(action); },
  });
  t.after(() => { view.dispose(); rmSync(dir, { recursive: true, force: true }); });
  const rendered = () => stripVTControlCharacters(view.render(80).join("\n"));
  assert.match(rendered(), /Checking/);
  assert.doesNotMatch(rendered(), /\*\*Checking\*\*|LAST DETAIL/);
  assert.match(rendered(), /delegate info \[cD\]/);
  assert.match(rendered(), /\[aB\] › \[cD\][\s\S]*Which option\?/);
  await refresh.promise;
  view.handleInput?.("\x0f");
  assert.match(rendered(), /LAST DETAIL/);
  refresh = Promise.withResolvers<void>();
  appendFileSync(path, JSON.stringify({ type: "message", id: "2", parentId: "1", timestamp, message: { role: "assistant", content: [{ type: "text", text: "New saved reply" }] } }) + "\n");
  await refresh.promise;
  assert.match(rendered(), /New saved reply/);
  assert.ok(view.render(9).every((line) => visibleWidth(line) <= 9));
  for (const key of ["s", "r", "\x1b"]) view.handleInput?.(key);
  assert.deepEqual(actions, ["message", "refresh", "back"]);
});

test("delegate reports keep the heading visible while long bodies collapse", () => {
  initTheme("dark", false);
  const heading = "Delegate [cD] Review finished";
  const message = { role: "custom" as const, customType: "delegate-notice", timestamp: 0, display: true,
    content: `${heading}\n${Array.from({ length: 12 }, (_, i) => `- Detail ${i}`).join("\n")}`,
    details: { heading, tone: "success" as const },
  };
  const view = (expanded: boolean) => stripVTControlCharacters(renderDelegateNotice(message, { expanded, outputPad: 1, keyText: () => "", keyHint: () => "Ctrl+O to expand" }, theme)?.render(80).join("\n") ?? "");
  assert.match(view(false), /Review finished/);
  assert.match(view(false), /Ctrl\+O to expand/);
  assert.doesNotMatch(view(false), /Detail 11/);
  assert.match(view(true), /Detail 11/);
});
