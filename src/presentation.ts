import { stripVTControlCharacters } from "node:util";
import { getMarkdownTheme, type MessageRenderer, type Theme, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";

export const clean = (text: string) => stripVTControlCharacters(text).replace(/\r\n?/g, "\n").replace(/\t/g, "  ").replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");
const fields = (value: unknown) => value && typeof value === "object" ? value as Record<string, unknown> : {};
const oneLine = (text: unknown) => typeof text === "string" ? clean(text).replace(/\s+/g, " ").trim() : "";
export const contentText = (content: string | readonly { type: string; text?: string }[]) =>
  typeof content === "string" ? content : content.flatMap((block) => block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n");

function preview(component: Component, expanded: boolean, hint: string, theme: Theme): Component {
  if (expanded) return component;
  return {
    render(width) {
      const lines = component.render(width);
      if (lines.length <= 5) return lines;
      return [...lines.slice(0, 5), truncateToWidth(theme.fg("muted", `… ${lines.length - 5} more lines · ${hint}`), width)];
    },
    invalidate() { component.invalidate(); },
  };
}

export type DelegateNotice = { heading: string; tone: "accent" | "warning" | "success" | "error" | "muted" };
export const renderDelegateNotice: MessageRenderer<DelegateNotice> = (message, options, theme) => {
  const text = clean(contentText(message.content));
  const heading = message.details?.heading && clean(message.details.heading);
  const body = heading && text.startsWith(heading) ? text.slice(heading.length).trim() : text;
  const box = new Box(options.outputPad, 1, (line) => theme.bg("customMessageBg", line));
  box.addChild(new Text(theme.fg(message.details?.tone ?? "accent", theme.bold(oneLine(heading ?? "Delegate"))), 0, 0));
  if (body) box.addChild(preview(new Markdown(body, 0, 0, getMarkdownTheme()), options.expanded, options.keyHint("app.tools.expand", "to expand") || "expand for more", theme));
  return box;
};

export const delegateRenderers = {
  renderCall(input, theme) {
    const args = fields(input);
    const action = oneLine(args?.action);
    const target = oneLine(args?.id);
    const title = oneLine(args?.title);
    const label = [action, target && `[${target}]`, title].filter(Boolean).join(" ");
    return new Text(theme.fg("toolTitle", theme.bold("delegate")) + (label ? ` ${theme.fg("accent", label)}` : ""), 0, 0);
  },
  renderResult(result, { expanded }, theme, context) {
    const text = clean(contentText(result.content));
    const args = fields(context?.args);
    const color = context?.isError ? "error" : "toolOutput";
    const panel = new Container();
    const hint = context?.keyHint("app.tools.expand", "to expand") || "expand for more";
    const input = [args.brief, args.question, args.message].find((value): value is string => typeof value === "string" && !!value.trim());
    if (input) {
      const body = theme.fg("toolOutput", clean(input));
      panel.addChild(preview(new Text(body, 0, 0), expanded, hint, theme));
    }
    const resultText = args?.action === "list" || args?.action === "info" || context?.isError ? text : theme.bold(text);
    panel.addChild(preview(new Text(theme.fg(color, resultText), 0, 0), expanded, hint, theme));
    if (expanded) {
      const model = oneLine(args.model);
      const cwd = oneLine(args.cwd);
      const thinking = oneLine(args.thinking);
      const metadata = [model && `Model: ${model}`, thinking && `Thinking: ${thinking}`, cwd && `Directory: ${cwd}`].filter(Boolean).join("\n");
      if (metadata) panel.addChild(new Text(theme.fg("muted", metadata), 0, 0));
    }
    return panel;
  },
} satisfies ToolRenderers;
