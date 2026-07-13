import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = await mkdtemp(join(tmpdir(), "pi-codex-compat-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const calls = [];
globalThis.fetch = async (input, init) => {
  calls.push({ input, init });
  return new Response("{}", { status: 200 });
};

try {
  const { default: extension } = await import("../extensions/codex-request-compat.ts");
  const handlers = new Map();
  await extension({ on: (event, handler) => handlers.set(event, handler) });

  const sessionId = "019f5647-4977-7afd-9247-08ec1ba72561";
  const ctx = {
    model: { provider: "vendor-codex" },
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => [],
    },
  };
  handlers.get("session_start")?.({}, ctx);
  handlers.get("agent_start")?.({}, ctx);

  const headerEvent = { headers: {} };
  handlers.get("before_provider_headers")?.(headerEvent, ctx);
  const headers = new Headers({
    ...headerEvent.headers,
    accept: "application/json",
    session_id: sessionId,
    "x-stainless-lang": "js",
  });

  const originalTools = [
    {
      type: "function",
      name: "read",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  ];
  const body = JSON.stringify({
    model: "gpt-5.6-sol",
    input: [
      { role: "developer", content: "Pi system prompt" },
      { role: "user", content: [{ type: "input_text", text: "hello" }] },
    ],
    tools: originalTools,
    instructions: "Pi instructions",
    stream: true,
    store: false,
    prompt_cache_key: sessionId,
    prompt_cache_retention: "in_memory",
    max_output_tokens: 10000,
    service_tier: "priority",
    reasoning: { effort: "high", summary: "auto" },
    include: ["reasoning.encrypted_content"],
  });

  await fetch("https://provider.example/codex/v1/responses", { method: "POST", headers, body });
  assert.equal(calls.length, 1);

  const sent = calls[0];
  const sentHeaders = sent.init.headers;
  const sentBody = JSON.parse(sent.init.body);

  assert.equal(sentHeaders.get("originator"), "codex_exec");
  assert.match(sentHeaders.get("user-agent"), /^codex_exec\/0\.144\.1 /);
  assert.equal(sentHeaders.get("accept"), "text/event-stream");
  assert.equal(sentHeaders.get("x-openai-internal-codex-responses-lite"), "true");
  assert.equal(sentHeaders.has("x-stainless-lang"), false);
  assert.equal(sentHeaders.has("session_id"), false);

  assert.equal("tools" in sentBody, false);
  assert.equal("instructions" in sentBody, false);
  assert.equal("prompt_cache_retention" in sentBody, false);
  assert.equal("max_output_tokens" in sentBody, false);
  assert.equal("service_tier" in sentBody, false, "standard routing must not be upgraded to Fast");
  assert.deepEqual(sentBody.input[0], {
    type: "additional_tools",
    role: "developer",
    tools: originalTools,
  });
  assert.equal(sentBody.input[1].type, "message");
  assert.equal(sentBody.input[1].role, "developer");
  assert.match(sentBody.input[1].content[0].text, /^You are Codex/);
  assert.deepEqual(sentBody.input[2], {
    type: "message",
    role: "developer",
    content: [{ type: "input_text", text: "Pi system prompt" }],
  });
  assert.equal(sentBody.input[3].type, "message");
  assert.equal(sentBody.tool_choice, "auto");
  assert.equal(sentBody.parallel_tool_calls, false);
  assert.deepEqual(sentBody.reasoning, { effort: "high", context: "all_turns" });
  assert.equal(sentBody.text.verbosity, "low");
  assert.equal(sentBody.client_metadata.session_id, sessionId);
  assert.equal(sentBody.client_metadata.thread_id, sessionId);
  assert.equal(typeof sentBody.client_metadata["x-codex-turn-metadata"], "string");

  await fetch("https://provider.example/codex/v1/responses", {
    method: "POST",
    headers: sentHeaders,
    body: JSON.stringify(sentBody),
  });
  const twice = JSON.parse(calls[1].init.body);
  assert.equal(twice.input.filter((item) => item.type === "additional_tools").length, 1);
  assert.equal(
    twice.input.filter(
      (item) => item.type === "message" && item.role === "developer" && item.content?.[0]?.text?.startsWith("You are Codex"),
    ).length,
    1,
  );
  assert.equal("service_tier" in twice, false);

  console.log("PASS: Responses Lite shape, metadata, idempotence, tools, and standard billing tier");
} finally {
  await rm(agentDir, { recursive: true, force: true });
}
