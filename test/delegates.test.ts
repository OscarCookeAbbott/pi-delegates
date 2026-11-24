import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createEventBus, RpcClient, type ExtensionAPI, type ExtensionCommandContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "node:test";
import delegatesExtension, { delegateLabel } from "../src/index.ts";
import { Supervisor, inheritedTools } from "../src/supervisor.ts";

const extension = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const provider = fileURLToPath(new URL("./provider.ts", import.meta.url));

async function until(condition: () => boolean, state: () => unknown) {
  const end = Date.now() + 15_000;
  while (!condition()) {
    if (Date.now() > end) assert.fail(JSON.stringify(state(), null, 2));
    await setTimeout(20);
  }
}

test("real Pi: a nested delegate yields, survives quit and takes a reply without replay", { timeout: 35_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-delegates-test-"));
  const agent = join(dir, "agent");
  const workspace = join(dir, "workspace");
  mkdirSync(agent);
  mkdirSync(workspace);
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProjectTrust: "no" }));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  const notices: string[] = [];
  const hooks = { change() {}, notify(text: string) { notices.push(text); }, tasks: () => undefined };
  const caller = { cwd: workspace, model: "delegate-fixture/fixture/test", thinking: "low" as const, tools: ["read", "fixture_tool"], extensions: [provider] };
  const registry = join(dir, "runs");
  let root: Supervisor | undefined;
  try {
    root = new Supervisor(registry, extension, {}, hooks);
    assert.throws(() => new Supervisor(registry, extension, {}, hooks), /already has/);
    await root.execute({ action: "start", title: "Parent", brief: "spawn nested", model: "fixture/test", thinking: "high" }, caller);
    const first = root;
    await until(() => first.runs[1]?.state === "waiting_for_reply" && !first.live.has(first.runs[1].id), () => first.runs);
    const nested = first.runs[1];
    assert.equal(nested.parent, first.runs[0].id);
    assert.equal(first.runs[0].thinking, "high");
    assert.equal(nested.thinking, "high");
    assert.deepEqual(nested.tools, caller.tools);
    assert.doesNotMatch(readFileSync(nested.session, "utf8"), /Unexpected continuation/);
    assert.match(readFileSync(nested.session, "utf8"), /Question saved/);
    await first.close();
    assert.equal(first.live.size, 0);
    root = new Supervisor(registry, extension, {}, hooks);
    assert.equal(root.runs[1].question, "Which option?");
    await root.execute({ action: "steer", id: nested.id, message: "Option B" }, caller);
    const resumed = root;
    await until(() => resumed.runs[1].state === "complete" && !resumed.live.has(nested.id), () => resumed.runs);
    assert.equal(resumed.runs[1].result, "Received: Option B");
    assert.equal(resumed.runs[1].thinking, "high", "resume retains the saved effort instead of the caller's low level");
    assert.match(readFileSync(nested.session, "utf8"), /Received: Option B/);
  } finally {
    await root?.close();
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real Pi: a requested progress update is reported without pausing the delegate", { timeout: 20_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-delegates-progress-"));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
  const notices: string[] = [];
  const root = new Supervisor(join(cwd, "runs"), extension, {}, { change() {}, notify: (text) => { notices.push(text); }, tasks: () => undefined });
  const caller = { cwd, model: "delegate-fixture/fixture/test", tools: ["fixture_tool"], extensions: [provider] };
  try {
    await assert.rejects(root.execute({ action: "update", message: "Unscoped" }, caller), /Only running delegates/);
    await root.execute({ action: "start", title: "Progress", brief: "wait for progress request" }, caller);
    const [run] = root.runs;
    await until(() => existsSync(join(cwd, "fixture-ready")) && root.statusLabel(run).startsWith("fixture_tool · "), () => run);
    assert.match(await root.execute({ action: "request_update", id: run.id }, caller), /Progress update requested/);
    await until(() => !root.live.has(run.id), () => run);
    assert.equal(run.state, "complete");
    assert.match(root.statusLabel(run), /^done · /);
    assert.equal(run.result, "Done");
    assert.match(notices[0], /progress update:\nFirst milestone reached\./);
    assert.match(await root.execute({ action: "info", id: run.id }, caller), /Latest progress update: First milestone reached\./);
    await assert.rejects(root.execute({ action: "request_update", id: run.id }, caller), /isn't running/);
  } finally {
    await root.close();
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("real Pi: a stalled response can be interrupted and resumed", { timeout: 20_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-delegates-interrupt-"));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
  const root = new Supervisor(join(cwd, "runs"), extension, {}, { change() {}, notify() {}, tasks: () => undefined });
  const caller = { cwd, model: "delegate-fixture/fixture/test", tools: [], extensions: [provider] };
  try {
    await root.execute({ action: "start", title: "Stalled", brief: "stall model response" }, caller);
    const [run] = root.runs;
    await until(() => existsSync(join(cwd, "fixture-ready")), () => run);
    await root.execute({ action: "steer", id: run.id, message: "Queued guidance" }, caller);
    assert.equal(run.state, "running");
    assert.match(root.statusLabel(run), /^working · /);
    assert.doesNotMatch(readFileSync(run.session, "utf8"), /Queued guidance/);
    await root.execute({ action: "interrupt", id: run.id }, caller);
    assert.equal(run.state, "interrupted");
    assert.match(root.statusLabel(run), /^paused · /);
    assert.equal(root.live.has(run.id), false);
    await root.execute({ action: "resume", id: run.id, message: "Continue after interrupt", thinking: "medium" }, caller);
    await until(() => !root.live.has(run.id), () => run);
    assert.equal(run.state, "complete");
    assert.equal(run.thinking, "medium");
    const transcript = readFileSync(run.session, "utf8");
    assert.match(transcript, /stall model response/);
    assert.match(transcript, /Continue after interrupt/);
  } finally {
    await root.close();
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
    rmSync(cwd, { recursive: true, force: true });
  }
});

for (const entry of [pathToFileURL(provider).href, "~/provider.ts"]) {
  test(`real root Pi forwards a provider loaded with -e ${entry}`, { timeout: 20_000 }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-delegates-root-"));
    const agent = join(cwd, "agent");
    const pkg = join(cwd, "package");
    mkdirSync(agent);
    cpSync(dirname(extension), join(pkg, "src"), { recursive: true });
    cpSync(new URL("../package.json", import.meta.url), join(pkg, "package.json"));
    writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [pkg] }));
    const client = new RpcClient({
      cwd, cliPath: fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry")),
      env: { PI_CODING_AGENT_DIR: agent, HOME: dirname(provider), USERPROFILE: dirname(provider) },
      model: "delegate-fixture/fixture/test",
      args: ["--tools", "delegate", "-e", entry],
    });
    try {
      await client.start();
      const id = (await client.getState()).sessionId;
      const key = createHash("sha256").update(id).digest("hex");
      const registry = join(cwd, "agent", "delegates", key, "runs.json");
      await client.promptAndWait("spawn nested");
      const runs = () => JSON.parse(readFileSync(registry, "utf8"));
      await until(() => ["waiting_for_reply", "failed"].includes(runs()[0]?.state), runs);
      assert.equal(runs()[0].question, "Which option?", JSON.stringify(runs()));
    } finally {
      await client.stop();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

test("the delegate menu does not send guidance as a reply to a new question", { timeout: 20_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-delegates-menu-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
  const handlers = new Map<string, (event: object, ctx: ExtensionCommandContext) => unknown>();
  let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  let tool: ToolDefinition | undefined;
  let ask = false;
  const warnings: string[] = [];
  const notices: string[] = [];
  delegatesExtension({
    events: createEventBus(), getSettings: () => ({}), getActiveTools: () => ["fixture_tool"],
    on: (name: string, handler: NonNullable<ReturnType<typeof handlers.get>>) => handlers.set(name, handler),
    registerTool: (definition: ToolDefinition) => { tool = definition; },
    registerCommand: (_name: string, definition: { handler: NonNullable<typeof command> }) => { command = definition.handler; },
    registerMessageRenderer() {}, sendMessage: (message: { content: string }) => notices.push(message.content),
  } as unknown as ExtensionAPI);
  const invoke = async (params: object) => {
    assert.ok(tool);
    return (await tool.execute("tool", params, undefined, undefined, toolContext)).content;
  };
  let id = "";
  const context = { cwd, mode: "tui", isProjectTrusted: () => false,
    sessionManager: { getSessionId: () => "menu-test" },
    ui: { setWidget() {}, notify: (text: string, severity: string) => { if (severity === "warning") warnings.push(text); },
      select: () => { if (ask) return undefined; ask = true; return "Steer"; },
      input: async () => {
        await invoke({ action: "steer", id, message: "ask parent" });
        await until(() => notices.some((text) => text.includes("Which option?")), () => notices);
        return "Guidance for the old turn";
      },
    },
  };
  const ctx = context as unknown as ExtensionCommandContext;
  const toolContext = context as unknown as Parameters<ToolDefinition["execute"]>[4];
  // Pi normally passes explicit fixture extensions in its command line.
  process.argv.push("-e", provider);
  try {
    await handlers.get("session_start")?.({}, ctx);
    const started = await invoke({ action: "start", title: "Review", brief: "wait for progress request", model: "delegate-fixture/fixture/test" });
    id = /^\[([\da-zA-Z]{2})\]/.exec(started[0]?.type === "text" ? started[0].text : "")?.[1] ?? "";
    assert.ok(id);
    await until(() => existsSync(join(cwd, "fixture-ready")), () => notices);
    assert.ok(command);
    await command(id, ctx);
    assert.match(warnings.join("\n"), /Delegate state changed/);
    assert.match(JSON.stringify(await invoke({ action: "info", id })), /Question: Which option\?/);
  } finally {
    process.argv.splice(-2);
    await handlers.get("session_shutdown")?.({}, ctx);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("delegate labels shorten the title before the model on narrow rows", () => {
  const run = { id: "aB", title: "検証計画 with a long title", model: "provider/family/model" };
  const status = "running · read · 25%";
  assert.equal(delegateLabel(run, status), `[aB] ${run.title} · ${status} · family/model`);
  const label = delegateLabel(run, status, 51);
  assert.ok(visibleWidth(label) <= 51);
  assert.match(label, /^\[aB\] .*… · running · read · 25% · family\/model$/);
  assert.match(delegateLabel(run, status, 25), / · family\/model$/);
});

test("tool filters only narrow and deny wins", () => {
  assert.deepEqual(inheritedTools(["read", "delegate", "range_edit", "bash_async"], { allowTools: ["read", "range_edit", "ls"], denyTools: ["read"] }), ["range_edit"]);
  assert.deepEqual(inheritedTools(["read", "read", "bash_async"], { allowTools: [], denyTools: [] }), ["read", "bash_async"]);
});
