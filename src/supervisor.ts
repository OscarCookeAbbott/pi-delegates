import { fork, type ChildProcess } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { errorText, thinkingLevels, type Caller, type FromChild, type Request, type ThinkingLevel, type ToChild } from "./child.ts";
import type { DelegateNotice } from "./presentation.ts";

const alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const terminal = new Set(["complete", "failed", "cancelled"]);
const closed = new Set(["complete", "cancelled"]);
const busy = new Set(["starting", "running", "waiting_for_children"]);
export type Run = {
  id: string; parent?: string; title: string; brief: string; cwd: string; model: string; tools: string[]; extensions: string[];
  session: string; createdAt: number; updatedAt: number; thinking?: ThinkingLevel;
  state: "starting" | "running" | "waiting_for_children" | "waiting_for_reply" | "interrupted" | "complete" | "failed" | "cancelled";
  question?: string; unconfirmedReply?: string; lastUpdate?: string; result?: string; tasks?: unknown;
};
export type Settings = { allowTools?: string[]; denyTools?: string[]; maxDepth?: number; maxConcurrent?: number; maxLaunches?: number };
type Child = { process: ChildProcess; exited: Promise<void>; startup: NodeJS.Timeout; prompt: string; stopping?: boolean; stderr: string; tool?: string | null; percent?: number | null };
type Hooks = { change: () => void; notify: (text: string, details?: DelegateNotice) => void; tasks: (state: unknown, params: unknown, notes: boolean) => { state: unknown; text: string } | undefined };

export function inheritedTools(tools: string[], settings: Settings): string[] {
  return [...new Set(tools)].filter((name) => !["delegate", "subagent", "subagents_enable", "subagent_supervisor", "contact_supervisor", "bg_wait"].includes(name)
    && (!settings.allowTools?.length || settings.allowTools.includes(name)) && !settings.denyTools?.includes(name));
}

function required(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

function thinkingLevel(value: unknown, fallback?: ThinkingLevel): ThinkingLevel | undefined {
  if (value === undefined) return fallback;
  const level = thinkingLevels.find((level) => level === value);
  if (!level) throw new Error(`Invalid thinking level. Use ${thinkingLevels.join(", ")}.`);
  return level;
}

function modelName(value: string): string {
  if (value.includes("\n") || value.startsWith("-")) throw new Error("Invalid model name.");
  return value;
}

export class Supervisor {
  readonly runs: Run[];
  readonly live = new Map<string, Child>();
  private readonly registry: string;
  private readonly lock: string;
  private closing = false;
  private readonly dir: string;
  private readonly extension: string;
  private readonly settings: Settings;
  private readonly hooks: Hooks;

  constructor(dir: string, extension: string, settings: Settings, hooks: Hooks) {
    this.dir = dir;
    this.extension = extension;
    this.settings = settings;
    this.hooks = hooks;
    for (const [label, limit] of Object.entries({ maxDepth: settings.maxDepth, maxConcurrent: settings.maxConcurrent, maxLaunches: settings.maxLaunches })) {
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error(`${label} must be a positive integer.`);
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.registry = join(dir, "runs.json");
    this.lock = join(dir, `owner-${process.pid}`);
    this.acquire();
    try {
      const runs: Run[] = existsSync(this.registry) ? JSON.parse(readFileSync(this.registry, "utf8")) : [];
      if (!Array.isArray(runs)) throw new Error("Invalid delegate registry.");
      this.runs = runs;
      for (const run of runs) if (busy.has(run.state)) { run.state = run.question ? "waiting_for_reply" : "interrupted"; run.updatedAt = Date.now(); }
      if (runs.length) this.save();
    } catch (error) {
      rmSync(this.lock);
      throw error;
    }
  }

  private acquire() {
    const conflict = () => new Error("This Pi session already has a delegate supervisor.");
    try { writeFileSync(this.lock, "", { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw conflict(); throw error; }
    // Create our claim before checking others so simultaneous starts cannot both win.
    try {
      for (const name of readdirSync(this.dir)) {
        const pid = Number(/^owner-([1-9]\d*)$/.exec(name)?.[1]);
        if (!Number.isSafeInteger(pid) || pid === process.pid) continue;
        try { process.kill(pid, 0); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") continue; throw error; }
        throw conflict();
      }
    } catch (error) { rmSync(this.lock); throw error; }
  }

  private save() {
    const temp = `${this.registry}.tmp`;
    writeFileSync(temp, JSON.stringify(this.runs), { mode: 0o600 });
    renameSync(temp, this.registry);
  }

  private update(run: Run, patch: Partial<Run>) {
    const old = { ...run };
    Object.assign(run, patch, { updatedAt: Date.now() });
    try { this.save(); } catch (error) {
      for (const key of Object.keys(patch) as (keyof Run)[]) if (!(key in old)) delete run[key];
      Object.assign(run, old);
      throw error;
    }
    this.hooks.change();
  }

  private allocate() {
    const used = new Set(this.runs.map(({ id }) => id));
    const count = alphabet.length ** 2;
    const first = randomInt(count);
    for (let n = 0; n < count; n++) {
      const i = (first + n) % count;
      const id = alphabet[Math.floor(i / alphabet.length)] + alphabet[i % alphabet.length];
      if (!used.has(id)) return id;
    }
    throw new Error("Delegate IDs exhausted in this session.");
  }

  private get(id: unknown, caller?: Run): Run {
    const run = this.runs.find((r) => r.id === id);
    if (!run || (caller && run.parent !== caller.id)) throw new Error("Unknown delegate ID in this scope.");
    return run;
  }

  async execute(params: Request, context: Caller, caller?: Run): Promise<string> {
    if (this.closing) throw new Error("Delegate supervisor is shutting down.");
    if (params.action === "start") return this.start(params, context, caller);
    if (params.action === "list") return this.runs.filter((run) => !caller || run.parent === caller.id).map((run) => this.line(run)).join("\n") || "No delegates.";
    if (params.action === "request_steer") {
      if (!caller || caller.state !== "running") throw new Error("Only running delegates can ask their parent for steering.");
      const question = required(params.question, "Question").slice(0, 4000);
      this.update(caller, { question, state: "waiting_for_reply" });
      return "Question saved. Work pauses here until your parent replies.";
    }
    if (params.action === "update") {
      if (!caller || caller.state !== "running") throw new Error("Only running delegates can send progress updates.");
      const message = required(params.message, "Message");
      if (message.length > 4000) throw new Error("Progress updates must be 4000 characters or fewer.");
      this.update(caller, { lastUpdate: message });
      this.notify(caller, "progress update:", message);
      return "Progress update sent. Continue your work.";
    }
    if (params.action === "tasks") return this.taskAction(params.id === undefined && caller ? caller : this.get(params.id, caller), params.params, params.notes === true);
    const run = this.get(params.id, caller);
    switch (params.action) {
      case "info": return this.info(run);
      case "request_update": {
        const child = this.live.get(run.id);
        if (run.state !== "running" || !child || child.stopping) throw new Error("Delegate isn't running. Use info to see its latest state.");
        await this.send(child, { type: "notice", text: 'Your parent requested a progress update. Use delegate with action "update" and a brief message, then continue your work.' });
        return `[${run.id}] Progress update requested. It will reach the delegate at its next turn boundary.`;
      }
      case "steer": {
        const message = required(params.message, "Message");
        if (run.state === "waiting_for_reply") {
          if (this.live.has(run.id)) throw new Error("Delegate is still pausing; retry after it stops.");
          this.launch(run, `Reply to your question (${run.question}):\n${message}`, context);
          return `[${run.id}] Reply accepted; reopening delegate.`;
        }
        const child = this.live.get(run.id);
        if (!child || (run.state !== "running" && run.state !== "waiting_for_children")) throw new Error("Delegate isn't running. Use resume for an interrupted delegate.");
        if (run.state === "waiting_for_children") this.update(run, { state: "running" });
        await this.send(child, { type: "steer", text: message });
        return `[${run.id}] Steering queued for the next turn boundary. It won't interrupt an active model request or tool.`;
      }
      case "interrupt": {
        const child = this.live.get(run.id);
        if (!busy.has(run.state) || !child || child.stopping) throw new Error("Delegate isn't running.");
        this.update(run, { state: "interrupted" });
        await this.stop(child);
        return `[${run.id}] Interrupted. Resume to continue; resend any undelivered steering as the resume message.`;
      }
      case "resume": {
        if (busy.has(run.state)) throw new Error("Delegate is active. Steer or interrupt it instead.");
        const message = required(params.message, "Message");
        const model = params.model === undefined ? run.model : modelName(required(params.model, "Model"));
        const continuation = run.question ? `Reply to your question (${run.question}):\n${message}` : message;
        this.launch(run, existsSync(run.session) ? continuation : `Original brief (for context):\n${run.brief}\n\nFollow-up instructions:\n${continuation}`, context, model, thinkingLevel(params.thinking, run.thinking));
        return `[${run.id}] Reopening delegate.`;
      }
      case "cancel": await this.cancel(run); return `[${run.id}] Cancelled. Resume with a message to reopen this delegate.`;
      default: throw new Error(`Unknown delegate action: ${params.action}`);
    }
  }

  private start(params: Request, context: Caller, parent?: Run): string {
    let depth = 1;
    for (let at = parent; at; at = at.parent ? this.get(at.parent) : undefined) depth++;
    if (depth > (this.settings.maxDepth ?? 3)) throw new Error("Delegate depth limit reached.");
    if (this.runs.length >= (this.settings.maxLaunches ?? 64)) throw new Error("Delegate launch limit reached for this session.");
    this.checkSlot();
    const { cwd } = context;
    const available = parent ? context.tools.filter((tool) => parent.tools.includes(tool)) : context.tools;
    const tools = inheritedTools(inheritedTools(available, this.settings), {
      allowTools: params.allowTools as string[] | undefined,
      denyTools: params.denyTools as string[] | undefined,
    });
    const now = Date.now();
    const run: Run = {
      id: this.allocate(), parent: parent?.id, title: required(params.title, "Title").slice(0, 160), brief: required(params.brief, "Brief"),
      cwd: params.cwd === undefined ? cwd : resolve(cwd, required(params.cwd, "Working directory")),
      model: modelName(required(params.model ?? context.model, "Model")), thinking: thinkingLevel(params.thinking, context.thinking), tools, extensions: context.extensions,
      session: join(this.dir, `${randomUUID()}.jsonl`), state: "starting", createdAt: now, updatedAt: now,
    };
    this.runs.push(run);
    try { this.save(); } catch (error) { this.runs.pop(); throw error; }
    this.launch(run, run.brief, context);
    return `[${run.id}] Started ${run.title}. The result or a question will come back to you.`;
  }

  private checkSlot() {
    if (this.live.size >= (this.settings.maxConcurrent ?? 4)) throw new Error("Delegate concurrency limit reached.");
  }

  private launch(run: Run, prompt: string, context: Caller, model = run.model, thinking = run.thinking) {
    this.checkSlot();
    if (this.live.has(run.id)) throw new Error("Delegate is still shutting down.");
    this.update(run, { state: "starting", model, thinking, tools: inheritedTools(run.tools, this.settings) });
    const args = ["--session", run.session, "--model", model, "--name", `Delegate [${run.id}] ${run.title}`, "--tools", [...run.tools, "delegate"].join(",")];
    if (thinking !== undefined) args.push("--thinking", thinking);
    if (run.cwd === context.cwd && context.trusted !== undefined) args.push(context.trusted ? "--approve" : "--no-approve");
    for (const path of new Set([this.extension, ...run.extensions])) args.push("--extension", path);
    let proc: ChildProcess;
    try {
      // RPC supplies Pi's non-interactive runtime and graceful stdin shutdown; IPC carries delegate events.
      proc = fork(join(getPackageDir(), "dist", "bundle", "rpc-entry.js"), args, { cwd: run.cwd, execArgv: [], env: { ...process.env, PI_DELEGATE_TOOLS: run.tools.join(",") }, stdio: ["pipe", "ignore", "pipe", "ipc"] });
    } catch (error) {
      this.update(run, { state: run.question ? "waiting_for_reply" : "failed", result: errorText(error) });
      throw error;
    }
    const children = this.runs.filter((child) => child.parent === run.id);
    const previousWork = children.map((child) => [this.line(child), child.question, child.result?.slice(0, 800)].filter(Boolean).join("\n")).join("\n");
    const { promise: exited, resolve: done } = Promise.withResolvers<void>();
    const child: Child = {
      process: proc, exited, prompt: previousWork ? `Your delegates' latest state:\n${previousWork}\n\n${prompt}` : prompt, stderr: "",
      startup: setTimeout(() => this.fail(run, child, new Error("Child Pi did not start. Check model, extensions and project trust.")), 30_000),
    };
    this.live.set(run.id, child);
    proc.stderr?.on("data", (data: Buffer) => { child.stderr = (child.stderr + data.toString()).slice(-2000); });
    proc.stdin?.on("error", () => {});
    proc.on("message", (message) => { void this.receive(run, child, message as FromChild).catch((error) => this.fail(run, child, error)); });
    proc.once("error", (error) => this.fail(run, child, error));
    proc.once("close", (code, signal) => {
      clearTimeout(child.startup);
      this.live.delete(run.id);
      done();
      if (!child.stopping && !this.closing) this.fail(run, child, new Error(`Child exited (${signal ?? code}). ${child.stderr}`));
      this.hooks.change();
    });
  }

  private async receive(run: Run, child: Child, message: FromChild) {
    if (child.stopping || this.closing) return;
    switch (message.type) {
      case "ready": {
        clearTimeout(child.startup);
        const missing = [...run.tools, "delegate"].filter((tool) => !message.tools.includes(tool));
        if (missing.length) throw new Error(`Child could not load inherited tools: ${missing.join(", ")}.`);
        if (!message.model || (message.model !== run.model && message.model.slice(message.model.indexOf("/") + 1) !== run.model)) throw new Error(`Requested model ${run.model} is unavailable in the child.`);
        const reply = run.question ? child.prompt : undefined;
        this.update(run, { state: "running", model: message.model, thinking: message.thinking, question: undefined, unconfirmedReply: reply });
        await this.send(child, { type: "prompt", text: child.prompt });
        break;
      }
      case "thinking":
        if (run.state !== "starting" && run.thinking !== message.level) this.update(run, { thinking: message.level });
        break;
      case "prompt_started":
        if (run.unconfirmedReply) this.update(run, { unconfirmedReply: undefined });
        break;
      case "activity":
        if (message.tool !== undefined) child.tool = message.tool;
        if (message.percent !== undefined) child.percent = message.percent;
        this.hooks.change();
        break;
      case "request": {
        let reply: ToChild;
        try { reply = { type: "reply", id: message.id, value: await this.execute(message.params, message.caller, run) }; }
        catch (error) { reply = { type: "reply", id: message.id, error: errorText(error) }; }
        if (!child.stopping) await this.send(child, reply);
        break;
      }
      case "settled":
        if (run.state === "waiting_for_reply") {
          await this.stop(child);
          if (!this.closing && run.state === "waiting_for_reply") this.notify(run, "asks for steering:", run.question, "warning");
        } else if (message.error || message.aborted) {
          this.fail(run, child, new Error(message.error ?? "Child turn aborted."));
        } else if (this.runs.some((other) => other.parent === run.id && !terminal.has(other.state))) {
          this.update(run, { state: "waiting_for_children", question: undefined, result: message.text });
        } else {
          this.update(run, { state: "complete", question: undefined, result: message.text });
          await this.stop(child);
          if (!this.closing) this.notify(run, "finished", message.text, "success");
        }
    }
  }

  private send(child: Child, message: ToChild): Promise<void> {
    return new Promise((resolve, reject) => child.process.send(message, (error) => error ? reject(error) : resolve()));
  }

  private notify(run: Run, status: string, body?: string, tone: DelegateNotice["tone"] = "accent") {
    const heading = `Delegate [${run.id}] ${run.title} ${status}`;
    const notice = body ? `${heading}\n${body}` : heading;
    const details = { heading, tone };
    const parent = run.parent && this.runs.find((other) => other.id === run.parent);
    const child = parent && this.live.get(parent.id);
    if (!parent || !child || child.stopping || (parent.state !== "running" && parent.state !== "waiting_for_children")) {
      this.hooks.notify(parent ? `${notice}\nParent [${parent.id}] is unavailable.` : notice, details);
      return;
    }
    void this.send(child, { type: "notice", text: notice, details }).then(() => {
      if (parent.state === "waiting_for_children" && !child.stopping && !this.closing) this.update(parent, { state: "running" });
    }).catch(() => { if (!this.closing) this.hooks.notify(notice, details); });
  }

  private fail(run: Run, child: Child, error: unknown) {
    if (child.stopping || this.closing) return;
    const text = errorText(error);
    try { this.update(run, { state: run.question ? "waiting_for_reply" : "failed", result: text }); }
    catch (failure) { this.hooks.notify(`Delegate [${run.id}] could not save state: ${errorText(failure)}`); }
    void this.stop(child).then(() => {
      if (this.closing || run.state === "cancelled") return;
      this.notify(run, run.question ? "is waiting for a reply" : "failed", run.question ? `${text}\nQuestion: ${run.question}` : text, "error");
    });
  }

  private async stop(child: Child) {
    if (child.stopping) return child.exited;
    child.stopping = true;
    clearTimeout(child.startup);
    if (child.process.connected) {
      child.process.send({ type: "stop" } satisfies ToChild, () => child.process.stdin?.end());
    } else child.process.stdin?.end();
    const term = setTimeout(() => child.process.kill("SIGTERM"), 1500);
    const kill = setTimeout(() => child.process.kill("SIGKILL"), 4000);
    try { await child.exited; } finally { clearTimeout(term); clearTimeout(kill); }
  }

  private async cancel(run: Run) {
    if (closed.has(run.state)) throw new Error("Delegate already ended.");
    const branch = [run];
    for (const entry of branch) branch.push(...this.runs.filter((other) => other.parent === entry.id));
    const stops: Promise<void>[] = [];
    for (const entry of branch) {
      if (closed.has(entry.state)) continue;
      this.update(entry, { state: "cancelled", question: undefined, unconfirmedReply: undefined });
      const child = this.live.get(entry.id);
      if (child) stops.push(this.stop(child));
    }
    await Promise.all(stops);
    if (!this.closing) this.notify(run, "was cancelled", undefined, "muted");
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    try {
      for (const run of this.runs) if (busy.has(run.state)) this.update(run, { state: run.question ? "waiting_for_reply" : "interrupted" });
    } finally {
      await Promise.all([...this.live.values()].map((child) => this.stop(child)));
      rmSync(this.lock);
    }
  }

  taskAction(run: Run, params: unknown, notes = false): string {
    const result = this.hooks.tasks(run.tasks, params, notes);
    if (!result) throw new Error("Delegate task trees require pi-tasks in the root session.");
    if (result.state !== run.tasks) this.update(run, { tasks: result.state });
    return result.text;
  }

  statusLabel(run: Run, compact = true) {
    const child = this.live.get(run.id);
    const percent = child?.percent;
    const labels = { starting: "starting", running: child?.tool ?? "working", waiting_for_reply: "waiting", waiting_for_children: "waiting", interrupted: "paused", complete: "done", failed: "failed", cancelled: "cancelled" };
    const status = compact ? labels[run.state] : run.state.replaceAll("_", " ");
    return `${status} · ${percent == null ? "—" : `${Math.round(percent)}%`}`;
  }

  line(run: Run) {
    return `[${run.id}] ${run.title} · ${this.statusLabel(run, false)}`;
  }

  info(run: Run) {
    return [this.line(run), run.parent && `Parent: [${run.parent}]`, `Model: ${run.model}`, run.thinking && `Thinking: ${run.thinking}`, `Directory: ${run.cwd}`, `Session: ${run.session}`,
      `Created: ${new Date(run.createdAt).toISOString()}`, `Updated: ${new Date(run.updatedAt).toISOString()}`, `Brief: ${run.brief}`, run.question && `Question: ${run.question}`, run.unconfirmedReply && `Reply submitted (delivery unconfirmed): ${run.unconfirmedReply}`, run.lastUpdate && `Latest progress update: ${run.lastUpdate}`, run.result && `Result: ${run.result}`].filter(Boolean).join("\n");
  }
}
