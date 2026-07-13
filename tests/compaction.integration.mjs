import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "pi-codex-compat-sdk-"));
const agentDir = join(root, "agent");
const cwd = join(root, "workspace");
await mkdir(agentDir, { recursive: true });
await mkdir(cwd, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const captures = [];
const server = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const text = Buffer.concat(chunks).toString("utf8");
    captures.push({
      method: request.method,
      url: request.url,
      headers: { ...request.headers },
      body: JSON.parse(text),
    });
    response.writeHead(418, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "captured", type: "capture_complete" } }));
  });
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("capture server did not expose a TCP port");
const baseUrl = `http://127.0.0.1:${address.port}/v1`;

let session;
try {
  await mkdir(join(agentDir, "codex-request-compat"), { recursive: true });
  await writeFile(
    join(agentDir, "codex-request-compat", "config.json"),
    JSON.stringify({ providerIds: ["codex"], baseUrls: [] }),
  );
  const modelsPath = join(agentDir, "models.json");
  await writeFile(
    modelsPath,
    JSON.stringify({
      providers: {
        codex: {
          name: "Local capture",
          baseUrl,
          api: "openai-responses",
          apiKey: "test-only-key",
          models: [
            {
              id: "capture-model",
              name: "Capture model",
              reasoning: true,
              input: ["text"],
              contextWindow: 128000,
              maxTokens: 4096,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );

  const {
    AuthStorage,
    createAgentSession,
    DefaultResourceLoader,
    ModelRegistry,
    SessionManager,
    SettingsManager,
  } = await import("@earendil-works/pi-coding-agent");
  const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
  const modelRegistry = ModelRegistry.create(authStorage, modelsPath);
  const model = modelRegistry.find("codex", "capture-model");
  assert.ok(model, "temporary Codex model must load");

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true, reserveTokens: 2048, keepRecentTokens: 1 },
    retry: { enabled: false },
  });
  const sessionManager = SessionManager.inMemory(cwd);
  for (let index = 0; index < 4; index += 1) {
    sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: `Historical message ${index}: ${"context ".repeat(100)}` }],
      timestamp: Date.now() + index,
    });
  }

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [
      new URL("../extensions/codex-request-compat/index.ts", import.meta.url).pathname,
    ],
  });
  await resourceLoader.reload();
  ({ session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    thinkingLevel: "low",
    noTools: "all",
    authStorage,
    modelRegistry,
    resourceLoader,
    sessionManager,
    settingsManager,
  }));
  await session.bindExtensions({ mode: "print" });

  await assert.rejects(session.compact(), /418|captured|Summarization failed|unexpected status/i);
  assert.equal(captures.length, 1, "manual SDK compaction should make exactly one provider request");
  const capture = captures[0];
  assert.equal(capture.method, "POST");
  assert.equal(capture.url, "/v1/responses");
  assert.equal(capture.headers.originator, "codex_exec");
  assert.equal(capture.headers["x-openai-internal-codex-responses-lite"], "true");
  assert.equal(capture.body.input[0].type, "additional_tools");
  assert.equal("tools" in capture.body, false);
  assert.equal("instructions" in capture.body, false);
  assert.equal("service_tier" in capture.body, false);
  const developerMessages = capture.body.input.filter(
    (item) => item.type === "message" && item.role === "developer",
  );
  assert.equal(developerMessages.length, 1, "only the native Codex prompt may be developer-scoped");
  const turnMetadata = JSON.parse(capture.body.client_metadata["x-codex-turn-metadata"]);
  assert.equal(turnMetadata.request_kind, "compaction");
  assert.equal(
    capture.body.client_metadata["x-codex-turn-metadata"],
    capture.headers["x-codex-turn-metadata"],
    "compaction header/body metadata projections must be identical",
  );
  console.log("PASS: real Pi SDK session.compact() traverses header hook and fetch Lite fallback");
} finally {
  session?.dispose();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
