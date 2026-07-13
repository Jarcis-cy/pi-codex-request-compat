import { randomUUID } from "node:crypto";
import { FETCH_PATCH_KEY, ORIGINATOR } from "./constants.ts";
import type { MetadataRuntime, MetadataSnapshot } from "./metadata.ts";
import { selectWireProfile, type CodexWireProfile, type WireProfileId } from "./profiles.ts";

export interface CompatRuntimeState {
	metadata: MetadataRuntime;
	userAgent: string;
	profiles: ReadonlyMap<WireProfileId, CodexWireProfile>;
	endpoints: ResolvedEndpoint[];
	logFailure: (input: RequestInfo | URL, init: RequestInit, response: Response) => Promise<void>;
}

export interface ResolvedEndpoint {
	baseUrl: string;
	origin: string;
	responsesPath: string;
}

export interface FetchCoordinator {
	originalFetch: typeof fetch;
	patchedFetch: typeof fetch;
	states: Map<symbol, CompatRuntimeState>;
	activeInstance?: symbol;
}

type GlobalFetchHolder = typeof globalThis & {
	[FETCH_PATCH_KEY]?: FetchCoordinator;
};

export function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getHeader(headers: HeadersInit | undefined, name: string): string | undefined {
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

export function resolveEndpoint(baseUrl: string): ResolvedEndpoint {
	const url = new URL(baseUrl);
	const rootPath = url.pathname.replace(/\/+$/, "");
	return {
		baseUrl,
		origin: url.origin,
		responsesPath: `${rootPath}/responses` || "/responses",
	};
}

export function mergeEndpoints(baseUrls: string[]): ResolvedEndpoint[] {
	const endpoints = new Map<string, ResolvedEndpoint>();
	for (const baseUrl of baseUrls) {
		try {
			const endpoint = resolveEndpoint(baseUrl);
			endpoints.set(`${endpoint.origin}${endpoint.responsesPath}`, endpoint);
		} catch {
			// Config validation already reports invalid URLs.
		}
	}
	return [...endpoints.values()];
}

function requestUrl(input: RequestInfo | URL): URL | undefined {
	try {
		if (typeof input === "string") return new URL(input);
		if (input instanceof URL) return input;
		return new URL(input.url);
	} catch {
		return undefined;
	}
}

export function matchesEndpoint(input: RequestInfo | URL, endpoints: ResolvedEndpoint[]): boolean {
	const url = requestUrl(input);
	return !!url && endpoints.some((endpoint) => url.origin === endpoint.origin && url.pathname === endpoint.responsesPath);
}

function applyMetadataHeaders(headers: Headers, metadata: MetadataSnapshot): void {
	headers.set("x-codex-installation-id", metadata.installationId);
	headers.set("x-codex-window-id", metadata.windowId);
	headers.set("x-codex-turn-metadata", metadata.turnMetadata);
	headers.set("x-codex-inference-call-id", randomUUID());
	headers.set("session-id", metadata.sessionId);
	headers.set("thread-id", metadata.threadId);
	headers.set("x-client-request-id", metadata.threadId);
}

export function buildCompatHeaders(
	headers: HeadersInit | undefined,
	state: CompatRuntimeState,
	profile: CodexWireProfile,
	metadata = state.metadata.createSnapshot(),
): Headers {
	const out = new Headers(headers ?? {});
	const drop: string[] = [];
	out.forEach((_value, key) => {
		const lower = key.toLowerCase();
		if (lower.startsWith("x-stainless-") || lower === "session_id") drop.push(key);
	});
	for (const key of drop) out.delete(key);
	out.set("originator", ORIGINATOR);
	out.set("user-agent", state.userAgent);
	out.set("accept", "text/event-stream");
	if (profile.wireMode === "responses-lite") {
		out.set("x-openai-internal-codex-responses-lite", "true");
	} else {
		out.delete("x-openai-internal-codex-responses-lite");
	}
	out.set("x-codex-beta-features", "memories,prevent_idle_sleep,remote_compaction_v2");
	applyMetadataHeaders(out, metadata);
	return out;
}

function canonicalClientMetadata(
	existing: unknown,
	metadata: MetadataSnapshot,
): Record<string, unknown> {
	return {
		...(isObject(existing) ? existing : {}),
		"x-codex-installation-id": metadata.installationId,
		session_id: metadata.sessionId,
		thread_id: metadata.threadId,
		turn_id: metadata.turnId,
		"x-codex-window-id": metadata.windowId,
		"x-codex-turn-metadata": metadata.turnMetadata,
	};
}

function isCodexPromptItem(value: unknown, profiles: CompatRuntimeState["profiles"]): boolean {
	if (!isObject(value) || value.type !== "message" || value.role !== "developer") return false;
	if (!Array.isArray(value.content) || value.content.length !== 1) return false;
	const content = value.content[0];
	if (!isObject(content) || content.type !== "input_text" || typeof content.text !== "string") return false;
	return (
		content.text.startsWith("You are Codex") ||
		[...profiles.values()].some((profile) => content.text === profile.instructions)
	);
}

function isAdditionalToolsItem(value: unknown): boolean {
	return isObject(value) && value.type === "additional_tools" && value.role === "developer";
}

export function transformRequest(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	state: CompatRuntimeState,
): RequestInit | undefined {
	if (!init || init.method?.toUpperCase() !== "POST" || typeof init.body !== "string") return undefined;
	const directMarker = getHeader(init.headers, "originator") === ORIGINATOR;
	if (!directMarker && !matchesEndpoint(input, state.endpoints)) return undefined;

	let payload: unknown;
	try {
		payload = JSON.parse(init.body);
	} catch {
		return undefined;
	}
	if (!isObject(payload)) return undefined;
	const profile = selectWireProfile(state.profiles, payload.model);
	if (!profile) return undefined;

	const metadata = state.metadata.createSnapshot();
	const next: RequestInit = { ...init, headers: buildCompatHeaders(init.headers, state, profile, metadata) };
	const body: Record<string, unknown> = { ...payload };
	body.client_metadata = canonicalClientMetadata(body.client_metadata, metadata);

	const originalInput = Array.isArray(body.input) ? body.input : [];
	const existingToolsItem = originalInput.find(isAdditionalToolsItem);
	const tools = Array.isArray(body.tools)
		? body.tools
		: isObject(existingToolsItem) && Array.isArray(existingToolsItem.tools)
			? existingToolsItem.tools
			: [];
	const normalizedInput = originalInput
		.filter((item) => !isAdditionalToolsItem(item) && !isCodexPromptItem(item, state.profiles))
		.map((item) => {
			if (!isObject(item) || typeof item.role !== "string") return item;
			const supplemental = item.role === "developer" || item.role === "system";
			const role = supplemental ? "user" : item.role;
			if (typeof item.content === "string") {
				const text = supplemental ? `<client_context>\n${item.content}\n</client_context>` : item.content;
				return { ...item, type: "message", role, content: [{ type: "input_text", text }] };
			}
			if (Array.isArray(item.content)) {
				const content = supplemental
					? [
							{ type: "input_text", text: "<client_context>" },
							...item.content,
							{ type: "input_text", text: "</client_context>" },
						]
					: item.content;
				return { ...item, type: "message", role, content };
			}
			return item;
		});

	if (profile.wireMode === "responses-lite") {
		body.input = [
			{ type: "additional_tools", role: "developer", tools },
			{
				type: "message",
				role: "developer",
				content: [{ type: "input_text", text: profile.instructions }],
			},
			...normalizedInput,
		];
		delete body.tools;
		delete body.instructions;
		body.parallel_tool_calls = false;
	} else {
		body.input = normalizedInput;
		body.tools = tools;
		body.instructions = profile.instructions;
		body.parallel_tool_calls = true;
	}
	delete body.prompt_cache_retention;
	delete body.max_output_tokens;
	body.tool_choice = "auto";
	const reasoning = isObject(body.reasoning) ? body.reasoning : {};
	body.reasoning = {
		...(typeof reasoning.effort === "string" ? { effort: reasoning.effort } : {}),
		...(profile.wireMode === "responses-lite" ? { context: "all_turns" } : {}),
	};
	const text = isObject(body.text) ? body.text : {};
	body.text = {
		...(isObject(text.format) ? { format: text.format } : {}),
		verbosity: typeof text.verbosity === "string" ? text.verbosity : "low",
	};
	delete body.service_tier;
	body.store = false;
	body.stream = true;
	next.body = JSON.stringify(body);
	return next;
}

function activeState(coordinator: FetchCoordinator): CompatRuntimeState | undefined {
	return coordinator.activeInstance ? coordinator.states.get(coordinator.activeInstance) : undefined;
}

export function getFetchCoordinator(): FetchCoordinator | undefined {
	return (globalThis as GlobalFetchHolder)[FETCH_PATCH_KEY];
}

export function registerFetchRuntime(state: CompatRuntimeState): { instanceId: symbol; coordinator: FetchCoordinator } {
	const holder = globalThis as GlobalFetchHolder;
	let coordinator = holder[FETCH_PATCH_KEY];
	if (!coordinator) {
		const originalFetch = globalThis.fetch.bind(globalThis);
		coordinator = {
			originalFetch,
			states: new Map(),
			patchedFetch: undefined as unknown as typeof fetch,
		};
		coordinator.patchedFetch = async (input, init) => {
			const current = activeState(coordinator!);
			let effectiveInit = init;
			let transformed = false;
			if (current) {
				try {
					const next = transformRequest(input, init, current);
					if (next) {
						effectiveInit = next;
						transformed = true;
					}
				} catch {
					// Interceptor failures must not break the request.
				}
			}
			const response = await coordinator!.originalFetch(input, effectiveInit);
			if (current && transformed && response.status >= 400 && effectiveInit) {
				void current.logFailure(input, effectiveInit, response);
			}
			return response;
		};
		holder[FETCH_PATCH_KEY] = coordinator;
		globalThis.fetch = coordinator.patchedFetch;
	}
	const instanceId = Symbol("codex-request-compat-instance");
	coordinator.states.set(instanceId, state);
	coordinator.activeInstance = instanceId;
	return { instanceId, coordinator };
}

export function unregisterFetchRuntime(instanceId: symbol): void {
	const coordinator = getFetchCoordinator();
	if (!coordinator) return;
	coordinator.states.delete(instanceId);
	if (coordinator.activeInstance === instanceId) {
		coordinator.activeInstance = [...coordinator.states.keys()].at(-1);
	}
}
