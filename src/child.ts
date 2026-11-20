import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type Caller = { cwd: string; model?: string; tools: string[]; extensions: string[]; trusted?: boolean };
export type Request = { action: string; id?: string; [key: string]: unknown };
export type ToChild =
  | { type: "prompt" | "steer" | "notice"; text: string }
  | { type: "reply"; id: number; value?: string; error?: string }
  | { type: "stop" };
export type FromChild =
  | { type: "ready"; model?: string; tools: string[] }
  | { type: "prompt_started" }
  | { type: "request"; id: number; params: Request; caller: Caller }
  | { type: "activity"; text?: string; percent?: number | null }
  | { type: "settled"; text: string; error?: string; aborted: boolean };

export const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function callerFor(pi: ExtensionAPI, ctx: ExtensionContext): Caller {
  const tools = pi.getActiveTools();
  const extensions = [];
  // A CLI extension can register only a provider, so it need not appear in getAllTools().
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length && argv[i] !== "--"; i++) {
    if (argv[i] === "--extension" || argv[i] === "-e") {
      const entry = argv[++i];
      if (!entry) continue;
      if (entry.startsWith("file://")) extensions.push(fileURLToPath(entry));
      else if (entry === "~" || entry.startsWith("~/")) extensions.push(resolve(homedir(), entry.slice(2)));
      else if (/^(builtin|npm|git|github|https?|ssh):/.test(entry)) extensions.push(entry);
      else extensions.push(resolve(entry));
    }
  }
  return { cwd: ctx.cwd, model: ctx.model && `${ctx.model.provider}/${ctx.model.id}`, trusted: ctx.isProjectTrusted(), tools, extensions: [...new Set(extensions)] };
}

export function bindChild(pi: ExtensionAPI, tools: string[]) {
  const allowed = new Set([...tools, "delegate"]);
  const send = (message: FromChild) => process.send?.(message, () => {});
  const pending = new Map<number, { resolve: (value: string) => void; reject: (error: Error) => void }>();
  let nextId = 0;
  let waiting = false;
  let text = "";
  let failure: string | undefined;
  const activeTools = new Map<string, string>();

  pi.on("tool_call", (event) => {
    if (waiting || !allowed.has(event.toolName)) return { block: true, reason: waiting ? "Waiting for parent guidance." : "Tool not inherited by this delegate." };
  });
  let startingPrompt = false;
  pi.on("before_agent_start", () => pi.setActiveTools([...allowed]));
  pi.on("before_provider_request", () => {
    send({ type: "activity", text: "model response in progress" });
    if (!startingPrompt) return;
    startingPrompt = false;
    send({ type: "prompt_started" });
  });
  pi.on("turn_end", (_event, ctx) => { if (waiting) ctx.abort(); });
  pi.on("agent_start", () => { text = ""; failure = undefined; activeTools.clear(); });
  pi.on("tool_execution_start", (event) => {
    activeTools.set(event.toolCallId, event.toolName);
    send({ type: "activity", text: event.toolName });
  });
  pi.on("tool_execution_end", (event) => {
    activeTools.delete(event.toolCallId);
    send({ type: "activity", text: [...activeTools.values()].at(-1) ?? text.slice(0, 160) });
  });
  pi.on("message_end", ({ message }, ctx) => {
    if (message.role !== "assistant") return;
    text = message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n").slice(0, 12_000);
    failure = message.stopReason === "error" || message.stopReason === "length" ? message.errorMessage ?? message.stopReason : undefined;
    send({ type: "activity", text: text.slice(0, 160), percent: ctx.getContextUsage()?.percent ?? null });
  });
  pi.on("session_compact", () => { send({ type: "activity", percent: null }); });
  pi.on("agent_settled", ({ aborted }, ctx) => {
    send({ type: "activity", percent: ctx.getContextUsage()?.percent ?? null });
    send({ type: "settled", text, error: failure, aborted });
  });
  let stop: (() => void) | undefined;
  pi.on("session_start", (_event, ctx) => {
    stop = () => {
      try { pi.events.emit("session:stopping", undefined); }
      finally {
        for (const request of pending.values()) request.reject(new Error("Delegate is shutting down."));
        pending.clear();
        ctx.abort();
        ctx.shutdown();
      }
    };
    process.once("disconnect", stop);
    pi.setActiveTools([...allowed]);
    const model = ctx.model && `${ctx.model.provider}/${ctx.model.id}`;
    send({ type: "ready", tools: pi.getActiveTools(), model });
  });

  const receive = (message: ToChild) => {
    if (message.type === "stop") { stop?.(); return; }
    if (message.type === "reply") {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request?.reject(new Error(message.error));
      else request?.resolve(message.value ?? "");
      return;
    }
    if (message.type === "prompt") { waiting = false; startingPrompt = true; }
    if (waiting) return;
    if (message.type === "notice") pi.sendMessage({ customType: "delegate-notice", content: message.text, display: true }, { deliverAs: "steer", triggerTurn: true });
    else pi.sendUserMessage(message.text, { deliverAs: "steer" });
  };
  process.on("message", receive);
  pi.on("session_shutdown", () => {
    process.off("message", receive);
    if (stop) process.off("disconnect", stop);
    for (const request of pending.values()) request.reject(new Error("Delegate is shutting down."));
    pending.clear();
  });

  return async (params: Request, caller?: Caller): Promise<string> => {
    const id = ++nextId;
    if (params.action === "request_steer") waiting = true;
    try {
      return await new Promise<string>((resolve, reject) => {
        if (!process.connected) { reject(new Error("Delegate supervisor disconnected.")); return; }
        pending.set(id, { resolve, reject });
        process.send!({ type: "request", id, params, caller: caller ?? { cwd: process.cwd(), tools: [], extensions: [] } } satisfies FromChild, (error) => {
          if (error) { pending.delete(id); reject(error); }
        });
      });
    } catch (error) {
      if (params.action === "request_steer") waiting = false;
      throw error;
    }
  };
}
