import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = await mkdtemp(join(tmpdir(), "pi-codex-compat-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const compatDir = join(agentDir, "codex-request-compat");
const userConfigPath = join(compatDir, "config.json");
await mkdir(compatDir, { recursive: true });
await writeFile(join(compatDir, "codex-instructions.txt"), "You are Codex, but this override is stale.");

const wireCalls = [];
const originalFetchStub = async (input, init) => {
  wireCalls.push({ input, init });
  return new Response("{}", { status: 200 });
};
globalThis.fetch = originalFetchStub;

function createHarness() {
  const handlers = new Map();
  const commands = new Map();
  const pi = {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand(name, definition) {
      commands.set(name, definition);
    },
  };
  return {
    pi,
    commands,
    async emit(event, payload, ctx) {
      let result;
      for (const handler of handlers.get(event) ?? []) {
        const next = await handler(payload, ctx);
        if (next !== undefined) result = next;
      }
      return result;
    },
  };
}

const sessionId = "019f5647-4977-7afd-9247-08ec1ba72561";
const model = {
  provider: "codex",
  id: "gpt-example",
  api: "openai-responses",
  baseUrl: "http://capture.local/api/v1/",
};
const models = [model];
function createContext(overrides = {}) {
  return {
    model,
    modelRegistry: { getAll: () => models },
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => [],
    },
    mode: "print",
    hasUI: false,
    ui: { notify() {} },
    ...overrides,
  };
}

function baseBody(overrides = {}) {
  return {
    model: "gpt-example",
    input: [
      { role: "developer", content: "Pi system prompt" },
      { role: "user", content: [{ type: "input_text", text: "hello" }] },
    ],
    tools: [
      {
        type: "function",
        name: "read",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    ],
    instructions: "Pi instructions",
    prompt_cache_retention: "in_memory",
    max_output_tokens: 10000,
    service_tier: "priority",
    reasoning: { effort: "high", summary: "auto" },
    stream: true,
    ...overrides,
  };
}

async function send(url, init) {
  const before = wireCalls.length;
  await fetch(url, init);
  assert.equal(wireCalls.length, before + 1);
  return wireCalls.at(-1);
}

try {
  const defaultConfig = JSON.parse(await readFile(new URL("../config/default.json", import.meta.url), "utf8"));
  assert.deepEqual(defaultConfig, { providerIds: ["codex"], baseUrls: [] }, "packaged default must contain only codex");

  const { loadConfig } = await import("../extensions/codex-request-compat/config.ts");
  assert.deepEqual((await loadConfig()).providerIds, ["codex"]);

  await writeFile(userConfigPath, JSON.stringify({
    providerIds: [" custom ", "custom"],
    baseUrls: ["http://capture.local/custom///", "http://capture.local/custom///"],
  }));
  const overridden = await loadConfig();
  assert.deepEqual(overridden.providerIds, ["custom"]);
  assert.deepEqual(overridden.baseUrls, ["http://capture.local/custom"]);
  assert.equal(overridden.configSource, "user");

  await writeFile(userConfigPath, JSON.stringify({
    providerIds: 42,
    baseUrls: [
      "ftp://invalid.example/root",
      "http://capture.local/api/v1/?secret=query",
      " http://capture.local/api/v1/ ",
    ],
  }));
  const invalid = await loadConfig();
  assert.deepEqual(invalid.providerIds, ["codex"], "invalid user field must retain its packaged default");
  assert.deepEqual(invalid.baseUrls, ["http://capture.local/api/v1"]);
  assert.ok(invalid.warnings.some((warning) => warning.includes("providerIds")));
  assert.ok(invalid.warnings.filter((warning) => warning.includes("HTTP(S)")).length >= 2);

  await writeFile(userConfigPath, JSON.stringify({ providerIds: ["codex"], baseUrls: [] }));
  const { default: extension } = await import("../extensions/codex-request-compat/index.ts");
  const { logTargetFailure } = await import("../extensions/codex-request-compat/diagnostics.ts");
  await logTargetFailure(
    "https://user:password@capture.local/api/v1/responses?api_key=url-secret#fragment",
    {
      method: "POST",
      headers: {
        authorization: "Bearer request-secret",
        "x-api-key": "request-api-key",
        cookie: "session=request-cookie",
        "x-safe-header": "visible",
      },
      body: JSON.stringify({ model: "diagnostic-test" }),
    },
    new Response("failure", {
      status: 400,
      headers: { "set-cookie": "response-secret", "x-safe-response": "visible" },
    }),
  );
  const diagnostic = JSON.parse(await readFile(join(compatDir, "last-failed-request.json"), "utf8"));
  assert.equal(diagnostic.url, "https://capture.local/api/v1/responses");
  assert.equal(diagnostic.headers.authorization, "<redacted>");
  assert.equal(diagnostic.headers["x-api-key"], "<redacted>");
  assert.equal(diagnostic.headers.cookie, "<redacted>");
  assert.equal(diagnostic.headers["x-safe-header"], "visible");
  assert.equal(diagnostic.responseHeaders["set-cookie"], "<redacted>");
  assert.equal(diagnostic.responseHeaders["x-safe-response"], "visible");

  const harness = createHarness();
  await extension(harness.pi);
  const ctx = createContext();
  await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await harness.emit("agent_start", { type: "agent_start" }, ctx);

  const headerEvent = { type: "before_provider_headers", headers: {} };
  await harness.emit("before_provider_headers", headerEvent, ctx);
  const direct = await send("http://unconfigured.local/anything", {
    method: "POST",
    headers: { ...headerEvent.headers, session_id: "stale", "x-stainless-lang": "js" },
    body: JSON.stringify(baseBody({
      client_metadata: {
        session_id: "stale-session",
        thread_id: "stale-thread",
        turn_id: "stale-turn",
        "x-codex-window-id": "stale-window",
        "x-codex-turn-metadata": "stale-metadata",
        preserved: "yes",
      },
      input: [
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "You are Codex, but stale." }],
        },
        { role: "developer", content: "Pi system prompt" },
        { role: "user", content: [{ type: "input_text", text: "hello" }] },
      ],
    })),
  });
  const directHeaders = direct.init.headers;
  const directBody = JSON.parse(direct.init.body);
  assert.equal(directHeaders.get("originator"), "codex_exec", "direct marker must transform");
  assert.match(directHeaders.get("user-agent"), /^codex_exec\/0\.144\.1 /);
  assert.equal(directHeaders.get("x-openai-internal-codex-responses-lite"), "true");
  assert.equal(directHeaders.has("x-stainless-lang"), false);
  assert.equal(directHeaders.has("session_id"), false);
  assert.equal(directBody.client_metadata.session_id, sessionId, "canonical metadata must overwrite stale body values");
  assert.equal(directBody.client_metadata.thread_id, sessionId);
  assert.notEqual(directBody.client_metadata.turn_id, "stale-turn");
  assert.equal(directBody.client_metadata.preserved, "yes");
  assert.equal(directBody.client_metadata["x-codex-turn-metadata"], directHeaders.get("x-codex-turn-metadata"));
  assert.equal("service_tier" in directBody, false);
  assert.equal("tools" in directBody, false);
  assert.equal("instructions" in directBody, false);
  assert.equal("prompt_cache_retention" in directBody, false);
  assert.equal("max_output_tokens" in directBody, false);
  assert.deepEqual(directBody.input[0].tools, baseBody().tools, "tool schema must remain byte-for-byte equivalent");

  const packagedPrompt = (await readFile(new URL("../assets/codex-instructions.txt", import.meta.url), "utf8")).trim();
  assert.equal(createHash("sha256").update(packagedPrompt).digest("hex"), "e9778714d505f3dd04d44db4394024c5fab5bf6554fc9faa3cdf9cf776b63bb9");
  const nativePrompts = directBody.input.filter((item) => item.type === "message" && item.role === "developer");
  assert.equal(nativePrompts.length, 1, "only one native developer prompt may remain");
  assert.equal(nativePrompts[0].content[0].text, packagedPrompt, "packaged prompt must override stale prompt files and payloads");
  assert.deepEqual(directBody.input[2], {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "<client_context>\nPi system prompt\n</client_context>" }],
  });

  const urlOnly = await send("http://capture.local/api/v1/responses?trace=1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(baseBody()),
  });
  assert.equal(urlOnly.init.headers.get("originator"), "codex_exec", "exact URL must transform without a marker");
  assert.equal(JSON.parse(urlOnly.init.body).client_metadata.session_id, sessionId, "URL fallback must be self-contained");

  const nearPathInit = { method: "POST", headers: {}, body: JSON.stringify(baseBody()) };
  const nearPath = await send("http://capture.local/api/v1/responses-extra", nearPathInit);
  assert.equal(nearPath.init, nearPathInit, "similar pathname must not be transformed");
  const prefixedPath = await send("http://capture.local/api/v1/responses/child", nearPathInit);
  assert.equal(prefixedPath.init, nearPathInit, "child pathname must not be transformed");
  const getInit = { method: "GET", headers: {}, body: JSON.stringify(baseBody()) };
  const getCall = await send("http://capture.local/api/v1/responses", getInit);
  assert.equal(getCall.init, getInit, "GET must not be transformed");

  const twice = await send("http://capture.local/api/v1/responses", {
    method: "POST",
    headers: directHeaders,
    body: JSON.stringify(directBody),
  });
  const twiceBody = JSON.parse(twice.init.body);
  assert.equal(twiceBody.input.filter((item) => item.type === "additional_tools").length, 1);
  assert.equal(twiceBody.input.filter((item) => item.type === "message" && item.role === "developer").length, 1);
  assert.equal("service_tier" in twiceBody, false, "conversion must be idempotent and standard-tier safe");

  await harness.emit("session_before_compact", { type: "session_before_compact" }, ctx);
  const compactHeaderEvent = { type: "before_provider_headers", headers: {} };
  await harness.emit("before_provider_headers", compactHeaderEvent, ctx);
  const compactOne = await send("http://capture.local/api/v1/responses", {
    method: "POST",
    headers: compactHeaderEvent.headers,
    body: JSON.stringify(baseBody()),
  });
  const compactTwo = await send("http://capture.local/api/v1/responses", {
    method: "POST",
    headers: compactHeaderEvent.headers,
    body: JSON.stringify(baseBody()),
  });
  const compactOneBody = JSON.parse(compactOne.init.body);
  const compactTwoBody = JSON.parse(compactTwo.init.body);
  const compactMetadata = JSON.parse(compactOneBody.client_metadata["x-codex-turn-metadata"]);
  assert.equal(compactMetadata.request_kind, "compaction", "compaction without onPayload must transform in fetch");
  assert.equal(compactTwoBody.client_metadata.turn_id, compactOneBody.client_metadata.turn_id, "split compaction requests reuse turn ID");
  assert.ok(compactOneBody.input.some((item) => item.type === "additional_tools"), "fetch must transform compaction payload shape");

  await harness.emit("session_compact", { type: "session_compact" }, ctx);
  await harness.emit("agent_start", { type: "agent_start" }, ctx);
  const afterCompact = await send("http://capture.local/api/v1/responses", {
    method: "POST",
    body: JSON.stringify(baseBody()),
  });
  const afterMetadata = JSON.parse(JSON.parse(afterCompact.init.body).client_metadata["x-codex-turn-metadata"]);
  assert.equal(afterMetadata.request_kind, "turn");
  assert.equal(afterMetadata.window_id, `${sessionId}:1`, "completed compaction increments the window");

  await harness.emit("session_before_tree", {
    type: "session_before_tree",
    preparation: { userWantsSummary: false },
  }, ctx);
  const treeNoSummary = await send("http://capture.local/api/v1/responses", {
    method: "POST",
    body: JSON.stringify(baseBody()),
  });
  const treeMetadata = JSON.parse(JSON.parse(treeNoSummary.init.body).client_metadata["x-codex-turn-metadata"]);
  assert.equal(treeMetadata.request_kind, "turn", "tree navigation without a summary must not pollute request kind");
  await harness.emit("session_tree", { type: "session_tree" }, ctx);

  await harness.emit("session_before_tree", {
    type: "session_before_tree",
    preparation: { userWantsSummary: true },
  }, ctx);
  const treeSummary = await send("http://capture.local/api/v1/responses", {
    method: "POST",
    body: JSON.stringify(baseBody()),
  });
  const treeSummaryMetadata = JSON.parse(
    JSON.parse(treeSummary.init.body).client_metadata["x-codex-turn-metadata"],
  );
  assert.equal(treeSummaryMetadata.request_kind, "compaction", "branch summary uses compaction metadata");
  await harness.emit("session_tree", { type: "session_tree" }, ctx);
  const afterTreeSummary = await send("http://capture.local/api/v1/responses", {
    method: "POST",
    body: JSON.stringify(baseBody()),
  });
  const afterTreeMetadata = JSON.parse(
    JSON.parse(afterTreeSummary.init.body).client_metadata["x-codex-turn-metadata"],
  );
  assert.equal(afterTreeMetadata.request_kind, "turn", "completed tree summary restores turn metadata");
  assert.equal(afterTreeMetadata.window_id, `${sessionId}:1`, "tree summary does not advance compaction window");

  const logs = [];
  const realConsoleLog = console.log;
  console.log = (message) => logs.push(String(message));
  try {
    await harness.commands.get("codex-compat:doctor").handler("", ctx);
  } finally {
    console.log = realConsoleLog;
  }
  assert.match(logs[0], /package: 0\.2\.0/);
  assert.match(logs[0], /configured providers exist: true/);
  assert.match(logs[0], /current api openai-responses: true/);
  assert.match(logs[0], /fetch patch: active/);
  assert.match(logs[0], /active instances: 1/);
  assert.match(logs[0], /warnings: none/);
  assert.match(logs[0], /errors: none/);

  const duplicateHarness = createHarness();
  await extension(duplicateHarness.pi);
  await duplicateHarness.emit("session_start", { type: "session_start", reason: "reload" }, ctx);
  const duplicateLogs = [];
  console.log = (message) => duplicateLogs.push(String(message));
  try {
    await duplicateHarness.commands.get("codex-compat:doctor").handler("", ctx);
  } finally {
    console.log = realConsoleLog;
  }
  assert.match(duplicateLogs[0], /active instances: 2/);
  assert.match(duplicateLogs[0], /duplicate active instances: 2/, "doctor must warn about duplicate factories");
  await duplicateHarness.emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, ctx);

  const afterDuplicateShutdown = await send("http://capture.local/api/v1/responses", {
    method: "POST",
    body: JSON.stringify(baseBody()),
  });
  assert.equal(afterDuplicateShutdown.init.headers.get("originator"), "codex_exec", "one instance shutdown must not break another");
  await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

  assert.equal(globalThis.fetch === originalFetchStub, false, "global fetch is wrapped exactly once and retained safely");
  console.log("PASS: config, exact URL fallback, metadata lifecycle, hot reload, doctor, Lite shape, and standard tier");
} finally {
  await rm(agentDir, { recursive: true, force: true });
}
