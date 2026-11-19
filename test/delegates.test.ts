import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "node:test";
import { delegateLabel } from "../src/index.ts";
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
  const caller = { cwd: workspace, model: "delegate-fixture/fixture/test", tools: ["read", "fixture_tool"], extensions: [provider] };
  const registry = join(dir, "runs");
  let root: Supervisor | undefined;
  try {
    root = new Supervisor(registry, extension, {}, hooks);
    assert.throws(() => new Supervisor(registry, extension, {}, hooks), /already has/);
    await root.execute({ action: "start", title: "Parent", brief: "spawn nested", model: "fixture/test" }, caller);
    const first = root;
    await until(() => first.runs[1]?.state === "waiting_for_reply" && !first.live.has(first.runs[1].id), () => first.runs);
    const nested = first.runs[1];
    assert.equal(nested.parent, first.runs[0].id);
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
    assert.match(readFileSync(nested.session, "utf8"), /Received: Option B/);
  } finally {
    await root?.close();
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
    rmSync(dir, { recursive: true, force: true });
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

test("delegate labels shorten the title before the model on narrow rows", () => {
  const run = { id: "aB", title: "検証計画 with a long title", model: "provider/model" };
  const status = "running · read · 25%";
  assert.equal(delegateLabel(run, status), `[aB] ${run.title} · ${status} · ${run.model}`);
  const label = delegateLabel(run, status, 51);
  assert.ok(visibleWidth(label) <= 51);
  assert.match(label, /^\[aB\] .*… · running · read · 25% · provider\/model$/);
  assert.match(delegateLabel(run, status, 25), / · provider\/model$/);
});

test("tool filters only narrow and deny wins", () => {
  assert.deepEqual(inheritedTools(["read", "delegate", "range_edit", "bash_async"], { allowTools: ["read", "range_edit", "ls"], denyTools: ["read"] }), ["range_edit"]);
  assert.deepEqual(inheritedTools(["read", "read", "bash_async"], { allowTools: [], denyTools: [] }), ["read", "bash_async"]);
});
