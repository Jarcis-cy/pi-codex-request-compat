import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { arch, release, type } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TARGET_PROVIDERS = new Set(["vendor-codex", "packyapi", "neibu", "404"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODEX_VERSION = "0.144.1";
const ORIGINATOR = "codex_exec";
const FETCH_PATCH_KEY = "__codexRequestCompatFetchPatch";
const DEBUG_LOG_PATH = join(getAgentDir(), "codex-request-compat", "request-debug.log");
const DEBUG_LAST_FAILURE_PATH = join(getAgentDir(), "codex-request-compat", "last-failed-request.json");
const COMPAT_DIR = join(getAgentDir(), "codex-request-compat");
const CODEX_INSTRUCTIONS_PATH = join(COMPAT_DIR, "codex-instructions.txt");
const PACKAGED_INSTRUCTIONS_PATH = fileURLToPath(
	new URL("../assets/codex-instructions.txt", import.meta.url),
);
const FALLBACK_CODEX_INSTRUCTIONS =
	"You are Codex, based on GPT-5. You are running as a coding agent in the Codex CLI on a user's computer.";
// Loaded once at extension startup and reused by the fetch interceptor. Both
// direct providers and fallback-routed providers pass through this layer.
let codexInstructions = FALLBACK_CODEX_INSTRUCTIONS;
let codexUserAgent = `${ORIGINATOR}/${CODEX_VERSION}`;

const execFileAsync = promisify(execFile);

type TurnIdentity = { turnId: string; turnStartedAtUnixMs: number };
type RequestMetadata = TurnIdentity & {
	installationId: string;
	sessionId: string;
	threadId: string;
	windowId: string;
	turnMetadata: string;
};

function isErrno(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

async function unlinkIfExists(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch (error) {
		if (!isErrno(error, "ENOENT")) throw error;
	}
}

async function readInstallationId(path: string): Promise<string | undefined> {
	try {
		const value = (await readFile(path, "utf8")).trim();
		return UUID_PATTERN.test(value) ? value : undefined;
	} catch (error) {
		if (isErrno(error, "ENOENT")) return undefined;
		throw error;
	}
}

async function loadInstallationId(): Promise<string> {
	const directory = join(getAgentDir(), "codex-request-compat");
	const path = join(directory, "installation-id");
	const lockPath = `${path}.lock`;
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await chmod(directory, 0o700);

	for (;;) {
		const existing = await readInstallationId(path);
		if (existing) {
			await chmod(path, 0o600);
			return existing;
		}

		const candidate = randomUUID();
		try {
			await writeFile(path, `${candidate}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
			return (await readInstallationId(path)) ?? candidate;
		} catch (error) {
			if (!isErrno(error, "EEXIST")) throw error;
		}

		try {
			await writeFile(lockPath, "", { flag: "wx", mode: 0o600 });
		} catch (error) {
			if (!isErrno(error, "EEXIST")) throw error;
			try {
				const lock = await stat(lockPath);
				if (Date.now() - lock.mtimeMs > 30_000) await unlinkIfExists(lockPath);
			} catch (statError) {
				if (!isErrno(statError, "ENOENT")) throw statError;
			}
			await delay(10);
			continue;
		}

		const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
		try {
			try {
				const winner = await readInstallationId(path);
				if (winner) {
					await chmod(path, 0o600);
					return winner;
				}
				await writeFile(tempPath, `${candidate}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
				await rename(tempPath, path);
				await chmod(path, 0o600);
				return (await readInstallationId(path)) ?? candidate;
			} finally {
				await unlinkIfExists(tempPath);
			}
		} finally {
			await unlinkIfExists(lockPath);
		}
	}
}

function isTargetProvider(provider: string | undefined): boolean {
	return provider !== undefined && TARGET_PROVIDERS.has(provider);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ============================================================================
// User-Agent (mirrors codex-rs login/src/auth/default_client.rs
// get_codex_user_agent + terminal-detection user_agent_token)
// ============================================================================

async function detectOsToken(): Promise<string> {
	if (process.platform === "darwin") {
		try {
			const { stdout } = await execFileAsync("sw_vers", ["-productVersion"], { timeout: 2000 });
			const version = stdout.trim();
			// os_info reports macOS as "Mac OS <product version>"
			if (version) return `Mac OS ${version}`;
		} catch {
			// fall through to generic token
		}
	}
	return `${type()} ${release()}`;
}

function detectTerminalToken(): string {
	// Mirrors codex-rs terminal-detection: TERM_PROGRAM[/TERM_PROGRAM_VERSION],
	// falling back to TERM, then "unknown".
	const program = process.env.TERM_PROGRAM?.trim();
	const version = process.env.TERM_PROGRAM_VERSION?.trim();
	if (program) return version ? `${program}/${version}` : program;
	const term = process.env.TERM?.trim();
	return term || "unknown";
}

function sanitizeHeaderValue(value: string): string {
	// codex replaces chars outside ' '..'~' with '_' (sanitize_user_agent)
	return value.replace(/[^\x20-\x7e]/g, "_");
}

async function buildUserAgent(): Promise<string> {
	const osToken = await detectOsToken();
	const terminal = detectTerminalToken();
	return sanitizeHeaderValue(
		`${ORIGINATOR}/${CODEX_VERSION} (${osToken}; ${arch()}) ${terminal} (${ORIGINATOR}; ${CODEX_VERSION})`,
	);
}

// Prefer a user override in the Pi data directory, then the packaged prompt.
// The built-in identity line is only a last-resort fallback.
async function loadCodexInstructions(): Promise<string> {
	for (const path of [CODEX_INSTRUCTIONS_PATH, PACKAGED_INSTRUCTIONS_PATH]) {
		try {
			const text = (await readFile(path, "utf8")).trim();
			if (text) return text;
		} catch {
			// Try the next source.
		}
	}
	return FALLBACK_CODEX_INSTRUCTIONS;
}

// ============================================================================
// Global fetch patch
//
// pi only emits `before_provider_request` for regular agent-turn requests:
// compaction / branch-summary requests call the SDK streamFn directly without
// `onPayload`, so extensions cannot edit their JSON body. Codex-strict
// gateways reject bodies that lack `client_metadata`, which caused 400s
// during auto-compaction. `before_provider_headers` DOES fire for every
// request, so we use our own `originator` header as the marker and rebuild
// `client_metadata` from that request's headers. This matches codex-rs
// semantics: headers and body client_metadata are projections of the same
// turn metadata snapshot (core/src/responses_metadata.rs).
// ============================================================================

function getHeader(headers: HeadersInit | undefined, name: string): string | undefined {
	if (!headers) return undefined;
	if (headers instanceof Headers) return headers.get(name) ?? undefined;
	const lower = name.toLowerCase();
	if (Array.isArray(headers)) {
		for (const [key, value] of headers) {
			if (key.toLowerCase() === lower) return value;
		}
		return undefined;
	}
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === lower) return String(value);
	}
	return undefined;
}

function buildClientMetadataFromHeaders(
	headers: HeadersInit | undefined,
): Record<string, string> | undefined {
	const installationId = getHeader(headers, "x-codex-installation-id");
	const sessionId = getHeader(headers, "session-id");
	const threadId = getHeader(headers, "thread-id");
	const windowId = getHeader(headers, "x-codex-window-id");
	const turnMetadata = getHeader(headers, "x-codex-turn-metadata");
	if (!installationId || !sessionId || !threadId || !windowId || !turnMetadata) return undefined;

	let turnId: string | undefined;
	try {
		const parsed: unknown = JSON.parse(turnMetadata);
		if (isObject(parsed) && typeof parsed.turn_id === "string") turnId = parsed.turn_id;
	} catch {
		return undefined;
	}
	if (!turnId) return undefined;

	return {
		"x-codex-installation-id": installationId,
		session_id: sessionId,
		thread_id: threadId,
		turn_id: turnId,
		"x-codex-window-id": windowId,
		"x-codex-turn-metadata": turnMetadata,
	};
}

// Rebuild request headers to look like the real Rust codex client:
//  - drop every `x-stainless-*` header (OpenAI JS SDK fingerprint; real codex
//    uses reqwest and never sends these). This is what the gateway's
//    "Codex 客户端请求特征无效" check flags.
//  - drop the underscore `session_id` header injected by pi's openai adapter
//    (codex only sends the hyphenated `session-id`).
//  - force the accepted Codex Exec identity for direct and fallback routes.
//  - advertise the Responses Lite headers used by Codex for this model.
function sanitizeCodexHeaders(headers: HeadersInit | undefined): Headers {
	const out = new Headers(headers ?? {});
	const drop: string[] = [];
	out.forEach((_value, key) => {
		const lower = key.toLowerCase();
		if (lower.startsWith("x-stainless-") || lower === "session_id") drop.push(key);
	});
	for (const key of drop) out.delete(key);
	out.set("originator", ORIGINATOR);
	out.set("user-agent", codexUserAgent);
	out.set("accept", "text/event-stream");
	out.set("x-openai-internal-codex-responses-lite", "true");
	out.set("x-codex-beta-features", "memories,prevent_idle_sleep,remote_compaction_v2");
	return out;
}

// A canonical Codex prompt item follows the Lite additional-tools item.
function isCodexPromptItem(value: unknown): boolean {
	if (!isObject(value) || value.type !== "message" || value.role !== "developer") return false;
	if (!Array.isArray(value.content) || value.content.length !== 1) return false;
	const content = value.content[0];
	if (!isObject(content) || content.type !== "input_text" || typeof content.text !== "string") {
		return false;
	}
	return (
		content.text === codexInstructions ||
		content.text.startsWith("You are Codex") ||
		content.text.includes("Codex CLI")
	);
}

function isAdditionalToolsItem(value: unknown): boolean {
	return isObject(value) && value.type === "additional_tools" && value.role === "developer";
}

// Transform an outbound target-provider request into Codex Responses Lite.
function transformCodexRequest(init: RequestInit): RequestInit | undefined {
	if (getHeader(init.headers, "originator") !== ORIGINATOR) return undefined;

	const next: RequestInit = { ...init, headers: sanitizeCodexHeaders(init.headers) };
	if (typeof init.body !== "string") return next;

	try {
		const payload: unknown = JSON.parse(init.body);
		if (!isObject(payload)) return next;
		const body: Record<string, unknown> = { ...payload };

		if (!isObject(body.client_metadata)) {
			const clientMetadata = buildClientMetadataFromHeaders(init.headers);
			if (clientMetadata) body.client_metadata = clientMetadata;
		}

		const originalInput = Array.isArray(body.input) ? body.input : [];
		const existingToolsItem = originalInput.find(isAdditionalToolsItem);
		const tools = Array.isArray(body.tools)
			? body.tools
			: isObject(existingToolsItem) && Array.isArray(existingToolsItem.tools)
				? existingToolsItem.tools
				: [];
		const normalizedInput = originalInput
			.filter((item) => !isAdditionalToolsItem(item) && !isCodexPromptItem(item))
			.map((item) => {
				if (!isObject(item) || typeof item.role !== "string") return item;
				if (typeof item.content === "string") {
					return { ...item, type: "message", content: [{ type: "input_text", text: item.content }] };
				}
				if (Array.isArray(item.content)) return { ...item, type: "message" };
				return item;
			});
		body.input = [
			{ type: "additional_tools", role: "developer", tools },
			{
				type: "message",
				role: "developer",
				content: [{ type: "input_text", text: codexInstructions }],
			},
			...normalizedInput,
		];

		for (const key of ["tools", "instructions", "prompt_cache_retention", "max_output_tokens"]) {
			delete body[key];
		}
		body.tool_choice = "auto";
		body.parallel_tool_calls = false;
		const existingReasoning = isObject(body.reasoning) ? body.reasoning : {};
		body.reasoning = {
			...(typeof existingReasoning.effort === "string" ? { effort: existingReasoning.effort } : {}),
			context: "all_turns",
		};
		const existingText = isObject(body.text) ? body.text : {};
		body.text = {
			...(isObject(existingText.format) ? { format: existingText.format } : {}),
			verbosity: typeof existingText.verbosity === "string" ? existingText.verbosity : "low",
		};
		// Omit service_tier: "priority" is Codex Fast mode and may be billed at
		// a premium. Standard routing is represented by the field being absent.
		delete body.service_tier;
		body.store = false;
		body.stream = true;
		next.body = JSON.stringify(body);
	} catch {
		// Non-JSON body: leave as-is, headers were still sanitized.
	}
	return next;
}

// Summarize a JSON request body's top-level shape so a failed request tells us
// exactly which codex-defining fields are present/missing without dumping 100KB.
function summarizeBodyKeys(body: string): string {
	try {
		const parsed: unknown = JSON.parse(body);
		if (!isObject(parsed)) return "<non-object body>";
		const keys = Object.keys(parsed);
		const instr = parsed.instructions;
		const instrInfo =
			typeof instr === "string"
				? `instructions[0:40]=${JSON.stringify(instr.slice(0, 40))}`
				: `instructions=<${instr === undefined ? "absent" : typeof instr}>`;
		return `${JSON.stringify(keys)} | ${instrInfo}`;
	} catch {
		return "<unparseable>";
	}
}

async function logTargetFailure(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	response: Response,
): Promise<void> {
	try {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const reqHeaders: Record<string, string> = {};
		const h = init?.headers;
		if (h instanceof Headers) {
			h.forEach((v, k) => {
				reqHeaders[k] = k.toLowerCase() === "authorization" ? "<redacted>" : v;
			});
		} else if (Array.isArray(h)) {
			for (const [k, v] of h) reqHeaders[k] = k.toLowerCase() === "authorization" ? "<redacted>" : v;
		} else if (h) {
			for (const [k, v] of Object.entries(h))
				reqHeaders[k] = k.toLowerCase() === "authorization" ? "<redacted>" : String(v);
		}
		const reqBody = typeof init?.body === "string" ? init.body : "<non-string body>";
		let respBody = "";
		try {
			respBody = await response.clone().text();
		} catch {
			respBody = "<unreadable response body>";
		}
		let parsedRequestBody: unknown = reqBody;
		try {
			parsedRequestBody = JSON.parse(reqBody);
		} catch {
			// Keep the raw body when it is not JSON.
		}
		await writeFile(
			DEBUG_LAST_FAILURE_PATH,
			JSON.stringify(
				{
					timestamp: new Date().toISOString(),
					status: response.status,
					url,
					headers: reqHeaders,
					body: parsedRequestBody,
					responseBody: respBody,
				},
				null,
				2,
			),
			{ encoding: "utf8", mode: 0o600 },
		);
		const record = [
			`==== ${new Date().toISOString()} status=${response.status} ${response.statusText} ====`,
			`url: ${url}`,
			`request headers: ${JSON.stringify(reqHeaders)}`,
			`request body keys: ${summarizeBodyKeys(reqBody)}`,
			`request body (${reqBody.length}b): ${reqBody.slice(0, 4000)}`,
			`response headers: ${JSON.stringify(Object.fromEntries(response.headers.entries()))}`,
			`response body: ${respBody.slice(0, 8000)}`,
			"",
			"",
		].join("\n");
		await appendFile(DEBUG_LOG_PATH, record, "utf8");
	} catch {
		// Diagnostics must never affect the request path.
	}
}

function installFetchPatch(): void {
	const holder = globalThis as Record<string, unknown> & { fetch: typeof fetch };
	if (holder[FETCH_PATCH_KEY]) return;
	holder[FETCH_PATCH_KEY] = true;

	const originalFetch = holder.fetch.bind(globalThis);
	const patched: typeof fetch = async (input, init) => {
		let effectiveInit = init;
		if (init) {
			try {
				// Runs for every target request (marked by our originator header),
				// with or without a body, so JS-SDK fingerprint headers are stripped
				// even on GET/streaming setups.
				const nextInit = transformCodexRequest(init);
				if (nextInit) effectiveInit = nextInit;
			} catch {
				// Never break the request on interceptor bugs.
			}
		}
		const response = await originalFetch(input, effectiveInit);
		// Capture the raw server rejection for target-provider requests so we can
		// see exactly what a strict codex gateway is validating. Only fires on
		// 4xx/5xx and only for our marked requests, so success/SSE is untouched.
		if (
			response.status >= 400 &&
			getHeader(effectiveInit?.headers, "originator") === ORIGINATOR
		) {
			void logTargetFailure(input, effectiveInit, response);
		}
		return response;
	};
	holder.fetch = patched;
}

// ============================================================================
// Extension
// ============================================================================

export default async function (pi: ExtensionAPI) {
	const installationId = await loadInstallationId();
	codexUserAgent = await buildUserAgent();
	codexInstructions = await loadCodexInstructions();
	installFetchPatch();

	let turn: TurnIdentity | undefined;
	// Codex window ids are `{thread_id}:{window_number}` where the window
	// number advances after each compaction (core/src/session/mod.rs).
	let windowNumber = 0;

	const clearRun = () => {
		turn = undefined;
	};
	const ensureTurn = (): TurnIdentity =>
		(turn ??= { turnId: randomUUID(), turnStartedAtUnixMs: Date.now() });
	const createRequestMetadata = (sessionId: string): RequestMetadata => {
		const currentTurn = ensureTurn();
		const threadId = sessionId;
		const windowId = `${threadId}:${windowNumber}`;
		const turnMetadata = JSON.stringify({
			installation_id: installationId,
			session_id: sessionId,
			thread_id: threadId,
			turn_id: currentTurn.turnId,
			window_id: windowId,
			request_kind: "turn",
			thread_source: "user",
			sandbox: "none",
			turn_started_at_unix_ms: currentTurn.turnStartedAtUnixMs,
		});
		return {
			...currentTurn,
			installationId,
			sessionId,
			threadId,
			windowId,
			turnMetadata,
		};
	};

	pi.on("session_start", (_event, ctx) => {
		clearRun();
		// Restore the compaction window number when resuming a session.
		try {
			windowNumber = ctx.sessionManager.getBranch().filter((e) => e.type === "compaction").length;
		} catch {
			windowNumber = 0;
		}
	});
	pi.on("session_shutdown", clearRun);
	pi.on("agent_start", (_event, ctx) => {
		clearRun();
		if (isTargetProvider(ctx.model?.provider)) ensureTurn();
	});
	pi.on("agent_end", clearRun);
	pi.on("agent_settled", clearRun);
	pi.on("session_compact", () => {
		windowNumber += 1;
	});

	pi.on("before_provider_headers", (event, ctx) => {
		if (!isTargetProvider(ctx.model?.provider)) return;
		const metadata = createRequestMetadata(ctx.sessionManager.getSessionId());
		event.headers.originator = ORIGINATOR;
		event.headers["User-Agent"] = codexUserAgent;
		event.headers["x-codex-installation-id"] = metadata.installationId;
		event.headers["x-codex-window-id"] = metadata.windowId;
		event.headers["x-codex-turn-metadata"] = metadata.turnMetadata;
		event.headers["x-codex-inference-call-id"] = randomUUID();
		event.headers["session-id"] = metadata.sessionId;
		event.headers["thread-id"] = metadata.threadId;
		event.headers["x-client-request-id"] = metadata.threadId;
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!isTargetProvider(ctx.model?.provider)) return;
		if (!isObject(event.payload)) return;
		const metadata = createRequestMetadata(ctx.sessionManager.getSessionId());
		const existing = isObject(event.payload.client_metadata) ? event.payload.client_metadata : {};
		// Codex gateways validate both projections: transport headers identify the
		// request, while client_metadata carries the same identity in the body.
		return {
			...event.payload,
			client_metadata: {
				...existing,
				"x-codex-installation-id": metadata.installationId,
				session_id: metadata.sessionId,
				thread_id: metadata.threadId,
				turn_id: metadata.turnId,
				"x-codex-window-id": metadata.windowId,
				"x-codex-turn-metadata": metadata.turnMetadata,
			},
		};
	});
}
