import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { bindChild, callerFor, errorText, thinkingLevels } from "./child.ts";
import { conversationPreview, conversationView, readConversation } from "./conversation.ts";
import { clean, delegateRenderers, renderDelegateNotice } from "./presentation.ts";
import { Supervisor, type Run, type Settings } from "./supervisor.ts";

const id = Type.String({ pattern: "^[0-9a-zA-Z]{2}$", description: "Exact case-sensitive delegate ID" });
const parameters = Type.Object({
  action: Type.Union((["start", "list", "info", "request_update", "update", "steer", "request_steer", "interrupt", "resume", "cancel"] as const).map((name) => Type.Literal(name))),
  id: Type.Optional(id),
  title: Type.Optional(Type.String({ maxLength: 160 })),
  brief: Type.Optional(Type.String({ maxLength: 24_000 })),
  message: Type.Optional(Type.String({ maxLength: 24_000 })),
  question: Type.Optional(Type.String({ maxLength: 4000 })),
  model: Type.Optional(Type.String({ description: "Optional model ID or provider/id for start or resume" })),
  thinking: Type.Optional(Type.Union(thinkingLevels.map((level) => Type.Literal(level)), { description: "Thinking level for start or resume. Defaults to the parent's level on start and the delegate's saved level on resume." })),
  cwd: Type.Optional(Type.String({ description: "Optional working directory for start" })),
  allowTools: Type.Optional(Type.Array(Type.String(), { description: "For start: keep only these inherited tools; empty means no restriction" })),
  denyTools: Type.Optional(Type.Array(Type.String(), { description: "For start: exclude these inherited tools" })),
}, { additionalProperties: false });

export function delegateLabel(run: Pick<Run, "id" | "title" | "model">, status: string, width?: number): string {
  const compact = (text: string) => clean(text).replace(/\s+/g, " ").trim();
  const id = `[${run.id}]`;
  const title = compact(run.title);
  const model = ` · ${compact(run.model.slice(run.model.indexOf("/") + 1))}`;
  let suffix = ` · ${compact(status)}${model}`;
  if (width === undefined) return `${id} ${title}${suffix}`;
  if (width <= 0) return "";
  let titleWidth = width - visibleWidth(id + " " + suffix);
  if (titleWidth < 1) {
    suffix = model;
    titleWidth = width - visibleWidth(id + " " + suffix);
  }
  if (titleWidth < 1) return clean(truncateToWidth(id + suffix, width, "…"));
  return `${id} ${clean(truncateToWidth(title, titleWidth, "…"))}${suffix}`;
}

function messageAction(run: Run): "Reply" | "Steer" | "Resume" | undefined {
  switch (run.state) {
    case "waiting_for_reply": return "Reply";
    case "waiting_for_children":
    case "running": return "Steer";
    case "interrupted":
    case "failed": return "Resume";
  }
}

function conversationTitle(run: Run, runs: readonly Run[]): string {
  const path = [`[${run.id}]`];
  let parent = run.parent;
  while (parent && !path.includes(`[${parent}]`)) {
    path.unshift(`[${parent}]`);
    parent = runs.find(({ id }) => id === parent)?.parent;
  }
  return clean(`Root › ${path.join(" › ")} ${run.title}`).replace(/\s+/g, " ");
}

export default function delegatesExtension(pi: ExtensionAPI) {
  const inherited = process.connected && process.env.PI_DELEGATE_TOOLS;
  const child = typeof inherited === "string" ? bindChild(pi, inherited.split(",").filter(Boolean)) : undefined;
  let supervisor: Supervisor | undefined;
  let startupError: string | undefined;
  let expandedDelegate: string | undefined;
  type TaskService = (state: unknown, params: unknown, notes: boolean) => { state: unknown; text: string };
  function getTaskService() {
    let taskService: TaskService | undefined;
    pi.events.emit("delegates:task-service", (service: TaskService) => { taskService = service; });
    return taskService;
  }
  if (!child) {
    pi.on("session_start", (_event, ctx) => {
      expandedDelegate = undefined;
      const key = createHash("sha256").update(ctx.sessionManager.getSessionId()).digest("hex");
      try {
        supervisor = new Supervisor(join(getAgentDir(), "delegates", key), fileURLToPath(import.meta.url), (pi.getSettings() as { delegates?: Settings }).delegates ?? {}, {
          change: () => updateWidget(ctx),
          notify: (text, details) => pi.sendMessage({ customType: "delegate-notice", content: text, display: true, details }, { deliverAs: "steer", triggerTurn: true }),
          tasks: (state, params, notes) => getTaskService()?.(state, params, notes),
        });
        startupError = undefined;
      } catch (error) {
        startupError = errorText(error);
        ctx.ui.notify(`Delegates unavailable: ${startupError}`, "warning");
      }
      updateWidget(ctx);
    });
    pi.on("session_shutdown", async () => { await supervisor?.close(); supervisor = undefined; });
  }

  function getSupervisor() {
    if (!supervisor) throw new Error(startupError ?? "Delegate supervisor unavailable.");
    return supervisor;
  }

  function updateWidget(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;
    const current = supervisor;
    if (!current) return;
    const runs = current.runs.filter((run) => !["complete", "failed", "cancelled"].includes(run.state));
    if (!runs.some(({ id }) => id === expandedDelegate)) expandedDelegate = undefined;
    if (!runs.length) { ctx.ui.setWidget("delegates", undefined); return; }
    ctx.ui.setWidget("delegates", (tui, theme) => {
      const hitRows = new Map<number, string>();
      const render = (width: number) => {
        hitRows.clear();
        const running = runs.filter((run) => run.state === "running").length;
        const lines: string[] = [theme.fg("muted", `Delegates · ${running}/${runs.length} running`)];
        let shown = 0;
        const widgetSupervisor = current;
        function append(parent?: string, depth = 0) {
          for (const run of runs) {
            const visibleParent = runs.some((item) => item.id === run.parent) ? run.parent : undefined;
            if (visibleParent !== parent) continue;
            if (shown >= 8) return;
            shown++;
            const indent = "  ".repeat(depth);
            const label = delegateLabel(run, widgetSupervisor.statusLabel(run), width - indent.length);
            let color: "warning" | "muted" | "accent" = "accent";
            if (run.state.startsWith("waiting")) color = "warning";
            if (run.state === "interrupted") color = "muted";
            hitRows.set(lines.length, run.id);
            lines.push(indent + theme.fg(color, label));
            if (expandedDelegate === run.id) {
              const metadata = [run.parent ? `Parent [${run.parent}]` : "Root delegate", run.thinking && `thinking ${run.thinking}`, run.cwd].filter(Boolean).join(" · ");
              const context = run.question ? `Question: ${run.question}` : run.lastUpdate ? `Update: ${run.lastUpdate}` : `Brief: ${run.brief}`;
              for (const line of [metadata, context]) lines.push(indent + "  " + theme.fg("muted", clean(line).replace(/\s+/g, " ").trim()));
            }
            append(run.id, depth + 1);
          }
        }
        append();
        if (runs.length > shown) lines.push(theme.fg("muted", `… ${runs.length - shown} more; /delegates`));
        if (expandedDelegate && ![...hitRows.values()].includes(expandedDelegate)) expandedDelegate = undefined;
        return lines.map((line) => truncateToWidth(line, width, "…"));
      };
      return {
        render,
        handleMouse(event) {
          const id = hitRows.get(event.y);
          if (event.type !== "click" || event.button !== "left" || !id) return;
          expandedDelegate = expandedDelegate === id ? undefined : id;
          tui.requestRender();
          return { handled: true };
        },
        invalidate() {},
      };
    });
  }

  pi.registerMessageRenderer("delegate-notice", renderDelegateNotice);
  pi.registerTool({
    ...delegateRenderers,
    name: "delegate",
    label: "Delegate",
    description: "Assign a bounded task in a fresh Pi session with start (title, brief, optional cwd/model/thinking). Returns immediately. Use list or info (id) to inspect runs without interrupting them. Use request_update (id) for a running delegate's progress; delegates use update (message) to report progress and keep working. Use steer (id, message) to queue guidance or reply to a paused delegate. interrupt (id) stops a live delegate without ending its subtree; resume (id, optional message/model/thinking) continues its saved session. cancel (id) permanently ends its subtree. Delegates use request_steer (question) to pause and ask their parent. Results, progress updates, and questions arrive automatically; do not poll. Delegate only when requested or otherwise authorized.",
    promptSnippet: "Delegate bounded work to another Pi session and receive its result or question asynchronously.",
    parameters,
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const text = child ? await child(params, callerFor(pi, ctx)) : await getSupervisor().execute(params, callerFor(pi, ctx));
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  async function sendHumanMessage(
    ctx: ExtensionCommandContext,
    current: Supervisor,
    run: Run,
    draft: { action: NonNullable<ReturnType<typeof messageAction>>; question?: string; message: string },
  ): Promise<boolean> {
    const { action, question, message } = draft;
    if (messageAction(run) !== action || run.question !== question) {
      ctx.ui.notify("Delegate state changed. Review it before sending a message.", "warning");
      return false;
    }
    try {
      const text = message.trim();
      const receipt = await current.execute({ action: action === "Resume" ? "resume" : "steer", id: run.id,
        message: text ? `Human ${action === "Reply" ? "reply" : "guidance"}:\n${text}` : "",
      }, callerFor(pi, ctx));
      ctx.ui.notify(clean(receipt), "info");
      return true;
    } catch (error) {
      ctx.ui.notify(clean(errorText(error)), "error");
      return false;
    }
  }

  async function openConversation(ctx: ExtensionCommandContext, current: Supervisor, run: Run) {
    const title = conversationTitle(run, current.runs);
    while (true) {
      const messages = await readConversation(run.session);
      const choice = await ctx.ui.custom<"back" | "refresh" | "message">((tui, theme, keys, done) => conversationView({
        title: () => `${title} · ${clean(current.statusLabel(run))}`, path: run.session, cwd: run.cwd, messages,
        question: () => run.question, messageAction: () => messageAction(run),
        outputPad: pi.getSettings().outputPad ?? 1, tui, theme,
        expandKey: (data) => keys.matches(data, "app.tools.expand"), expandHint: `${keys.getKeys("app.tools.expand").join("/") || "Ctrl+O"} expand/collapse`, done,
      }), { overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 } });
      if (choice === "back" || choice === undefined) return;
      const action = messageAction(run);
      if (choice !== "message" || !action) continue;
      const question = run.question;
      const message = (await ctx.ui.editor(`${action} · ${title}`, ""))?.trim();
      if (!message) continue;
      await sendHumanMessage(ctx, current, run, { action, question, message });
    }
  }

  if (!child) pi.registerCommand("delegates", {
    description: "Browse delegate history and manage saved runs",
    async handler(args, ctx) {
      const current = getSupervisor();
      const selected = args.trim();
      if (!current.runs.length) { ctx.ui.notify("No delegates.", "info"); return; }
      if (ctx.mode !== "tui") {
        ctx.ui.notify(selected ? clean(await current.execute({ action: "info", id: selected }, callerFor(pi, ctx))) : current.runs.map((run) => clean(current.line(run))).join("\n"), "info");
        return;
      }
      let run: Run | undefined;
      if (selected) {
        run = current.runs.find(({ id }) => id === selected);
        if (!run) throw new Error(`Unknown delegate [${selected}].`);
      } else {
        const rows = current.runs.map((entry) => delegateLabel(entry, current.statusLabel(entry)));
        const row = await ctx.ui.select("Delegates", rows);
        run = row === undefined ? undefined : current.runs[rows.indexOf(row)];
      }
      if (!run) return;
      while (true) {
        const options = ["Open conversation", "View details"];
        if (getTaskService()) options.push("View tasks");
        const send = messageAction(run);
        const question = run.question;
        if (send) options.push(send);
        if (["starting", "running", "waiting_for_children"].includes(run.state)) options.push("Interrupt");
        if (!["complete", "cancelled"].includes(run.state)) options.push("Cancel");
        options.push("Close");
        const preview = await readConversation(run.session).then(conversationPreview).catch(() => "Saved conversation unavailable.");
        const action = await ctx.ui.select([delegateLabel(run, current.statusLabel(run)), preview].filter(Boolean).join("\n\n"), options);
        if (!action || action === "Close") return;
        if (action === "Open conversation") {
          try { await openConversation(ctx, current, run); }
          catch (error) { ctx.ui.notify(clean(errorText(error)), "error"); }
          continue;
        }
        if (action === "View details" || action === "View tasks") {
          const text = action === "View details" ? current.info(run) : current.taskAction(run, { action: "list" });
          await ctx.ui.editor(action, clean(text));
          continue;
        }
        if (action === "Cancel" && !await ctx.ui.confirm(`Cancel [${run.id}]?`, "This permanently cancels the delegate and its descendants. Use Interrupt to keep it resumable.")) return;
        if (send && action === send) {
          const message = await ctx.ui.input(action === "Resume" ? "Resume instructions (optional)" : action);
          if (message === undefined || await sendHumanMessage(ctx, current, run, { action, question, message })) return;
          continue;
        }
        ctx.ui.notify(clean(await current.execute({ action: action.toLowerCase(), id: run.id }, callerFor(pi, ctx))), "info");
        return;
      }
    },
  });

  pi.events.on("delegates:tasks", (value) => {
    const request = value as { id?: string; params: unknown; notes?: boolean; respond: (result: Promise<string>) => void };
    if (typeof request?.respond !== "function" || (!child && !request.id)) return;
    const params = { action: "tasks", id: request.id, params: request.params, notes: request.notes };
    request.respond(child ? child(params) : Promise.resolve().then(() => getSupervisor().execute(params, { cwd: process.cwd(), tools: [], extensions: [] })));
  });
}
