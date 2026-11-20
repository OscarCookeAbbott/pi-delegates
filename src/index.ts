import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { bindChild, callerFor, errorText } from "./child.ts";
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
  cwd: Type.Optional(Type.String({ description: "Optional working directory for start" })),
  allowTools: Type.Optional(Type.Array(Type.String(), { description: "For start: keep only these inherited tools; empty means no restriction" })),
  denyTools: Type.Optional(Type.Array(Type.String(), { description: "For start: exclude these inherited tools" })),
}, { additionalProperties: false });
const clean = (text: string) => stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

export function delegateLabel(run: Pick<Run, "id" | "title" | "model">, status: string, width?: number): string {
  const compact = (text: string) => clean(text).replace(/\s+/g, " ").trim();
  const id = `[${run.id}]`;
  const title = compact(run.title);
  const model = ` · ${compact(run.model)}`;
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

export default function delegatesExtension(pi: ExtensionAPI) {
  const inherited = process.connected && process.env.PI_DELEGATE_TOOLS;
  const child = typeof inherited === "string" ? bindChild(pi, inherited.split(",").filter(Boolean)) : undefined;
  let supervisor: Supervisor | undefined;
  let startupError: string | undefined;
  type TaskService = (state: unknown, params: unknown, notes: boolean) => { state: unknown; text: string };
  function getTaskService() {
    let taskService: TaskService | undefined;
    pi.events.emit("delegates:task-service", (service: TaskService) => { taskService = service; });
    return taskService;
  }
  if (!child) {
    pi.on("session_start", (_event, ctx) => {
      const key = createHash("sha256").update(ctx.sessionManager.getSessionId()).digest("hex");
      try {
        supervisor = new Supervisor(join(getAgentDir(), "delegates", key), fileURLToPath(import.meta.url), (pi.getSettings() as { delegates?: Settings }).delegates ?? {}, {
          change: () => updateWidget(ctx),
          notify: (text) => pi.sendMessage({ customType: "delegate-notice", content: clean(text), display: true }, { deliverAs: "steer", triggerTurn: true }),
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
    const runs = current?.runs.filter((run) => !["complete", "failed", "cancelled"].includes(run.state)) ?? [];
    if (!current || !runs.length) { ctx.ui.setWidget("delegates", undefined); return; }
    ctx.ui.setWidget("delegates", (_tui, theme) => ({
      render(width: number) {
        const running = runs.filter((run) => run.state === "running").length;
        const lines: string[] = [theme.fg("muted", `Delegates · ${running}/${runs.length} running`)];
        const supervisor = current;
        function append(parent?: string, depth = 0) {
          for (const run of runs) {
            const visibleParent = runs.some((item) => item.id === run.parent) ? run.parent : undefined;
            if (visibleParent !== parent) continue;
            const indent = "  ".repeat(depth);
            const label = delegateLabel(run, supervisor.statusLabel(run), width - indent.length);
            let color: "warning" | "muted" | "accent" = "accent";
            if (run.state.startsWith("waiting")) color = "warning";
            if (run.state === "interrupted") color = "muted";
            lines.push(indent + theme.fg(color, label));
            append(run.id, depth + 1);
          }
        }
        append();
        const visible = lines.slice(0, 9);
        if (lines.length > visible.length) visible.push(theme.fg("muted", `… ${lines.length - visible.length} more; /delegates`));
        return visible.map((line) => truncateToWidth(line, width));
      },
      invalidate() {},
    }));
  }

  pi.registerTool({
    name: "delegate",
    label: "Delegate",
    description: "Assign a bounded task in a fresh Pi session with start (title, brief, optional cwd/model). Returns immediately. Use list or info (id) to inspect runs without interrupting them. Use request_update (id) for a running delegate's progress; delegates use update (message) to report progress and keep working. Use steer (id, message) to queue guidance or reply to a paused delegate. interrupt (id) stops a live delegate without ending its subtree; resume (id, optional message/model) continues its saved session. cancel (id) permanently ends its subtree. Delegates use request_steer (question) to pause and ask their parent. Results, progress updates, and questions arrive automatically; do not poll. Delegate only when requested or otherwise authorized.",
    promptSnippet: "Delegate bounded work to another Pi session and receive its result or question asynchronously.",
    parameters,
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const text = child ? await child(params, callerFor(pi, ctx)) : await getSupervisor().execute(params, callerFor(pi, ctx));
      return { content: [{ type: "text", text }], details: {} };
    },
  });

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
      const options = ["Close"];
      options.push("View details");
      if (getTaskService()) options.push("View tasks");
      if (run.state === "running" || run.state === "waiting_for_children" || run.state === "waiting_for_reply") options.push(run.question ? "Reply" : "Steer");
      if (["starting", "running", "waiting_for_children"].includes(run.state)) options.push("Interrupt");
      if (run.state === "interrupted" || run.state === "failed") options.push("Resume");
      if (!["complete", "cancelled"].includes(run.state)) options.push("Cancel");
      while (true) {
        const action = await ctx.ui.select(delegateLabel(run, current.statusLabel(run)), options);
        if (!action || action === "Close") return;
        if (action === "View details" || action === "View tasks") {
          const text = action === "View details" ? current.info(run) : current.taskAction(run, { action: "list" });
          await ctx.ui.editor(action, clean(text));
          continue;
        }
        if (action === "Cancel" && !await ctx.ui.confirm(`Cancel [${run.id}]?`, "This permanently cancels the delegate and its descendants. Use Interrupt to keep it resumable.")) return;
        let message: string | undefined;
        if (action !== "Cancel" && action !== "Interrupt") {
          message = await ctx.ui.input(action === "Resume" ? "Resume instructions (optional)" : action);
          if (message === undefined) return;
        }
        ctx.ui.notify(clean(await current.execute({ action: action === "Reply" ? "steer" : action.toLowerCase(), id: run.id, message }, callerFor(pi, ctx))), "info");
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
