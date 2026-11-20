import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { conversationPreview, conversationView, readConversation } from "../src/conversation.ts";

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
    assert.deepEqual(messages, [
      { label: "Input", text: "Review the draft" },
      { label: "Delegate", text: "Called read\nReviewing 🧪" },
      { label: "read", text: "Draft contents" },
    ]);
    assert.equal(conversationPreview(messages), "Input: Review the draft\nDelegate: Called read Reviewing 🧪");
    assert.equal(readFileSync(path, "utf8"), contents);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("conversation view starts at the latest message and can scroll, reply or go back", () => {
  const actions: string[] = [];
  const view = conversationView({
    title: "Root › [aB] › [cD] Review", messages: [{ label: "Delegate", text: "First message\nSecond message" }],
    question: "Which option?", messageAction: "Reply", height: () => 5, render() {}, done: (action) => { actions.push(action); },
  });
  assert.match(view.render(80).join("\n"), /\[aB\] › \[cD\].*\n[\s\S]*Which option\?/);
  assert.doesNotMatch(view.render(80).join("\n"), /First message/);
  view.handleInput?.("\x1b[5~");
  assert.match(view.render(80).join("\n"), /First message/);
  assert.ok(view.render(9).every((line) => visibleWidth(line) <= 9));
  view.handleInput?.("s");
  view.handleInput?.("r");
  view.handleInput?.("\x1b");
  assert.deepEqual(actions, ["message", "refresh", "back"]);
});
