import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function fixture(pi: ExtensionAPI) {
  const record = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  pi.registerTool({ name: "fixture_tool", label: "Fixture", description: "Fixture tool", parameters: { type: "object", properties: {} },
    async execute() { return { content: [{ type: "text", text: "fixture" }], details: {} }; },
  });
  pi.registerProvider("delegate-fixture", {
    baseUrl: "https://example.invalid", apiKey: "fixture", api: "delegate-fixture",
    models: [{ id: "fixture/test", name: "Test", reasoning: false, input: ["text"], cost: record.cost, contextWindow: 50_000, maxTokens: 2000 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const last = context.messages.at(-1);
      const content = last?.role === "user" ? last.content : "";
      const input = typeof content === "string" ? content : content.flatMap((part) => part.type === "text" ? [part.text] : []).join(" ");
      let call: { action: string; title?: string; brief?: string; question?: string } | undefined;
      if (input === "spawn nested") call = { action: "start", title: "Nested", brief: "ask parent" };
      if (input === "ask parent") call = { action: "request_steer", question: "Which option?" };
      const message: AssistantMessage = {
        api: model.api, provider: model.provider, model: model.id, role: "assistant", timestamp: Date.now(), usage: record,
        stopReason: call ? "toolUse" : "stop", content: call ? [{ type: "toolCall", id: `call-${context.messages.length}`, name: "delegate", arguments: call }]
          : [{ type: "text", text: input.startsWith("Reply to your question") ? `Received: ${input.split("\n").at(-1)}` : last?.role === "toolResult" && context.messages.some((msg) => msg.role === "user" && JSON.stringify(msg).includes("ask parent")) ? "Unexpected continuation" : "Done" }],
      };
      stream.push({ type: "done", reason: call ? "toolUse" : "stop", message });
      return stream;
    },
  });
}
