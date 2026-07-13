import { appendFile, chmod, mkdir, writeFile } from "node:fs/promises";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { CompatConfig } from "./config.ts";
import {
	CODEX_VERSION,
	COMPAT_DIR,
	DEBUG_LAST_FAILURE_PATH,
	DEBUG_LOG_PATH,
	EXPECTED_PROFILE_SHAS,
	PACKAGE_VERSION,
} from "./constants.ts";
import { selectWireProfile, type CodexWireProfile, type WireProfileId } from "./profiles.ts";
import { getFetchCoordinator, type FetchCoordinator, type ResolvedEndpoint } from "./transform.ts";

function isSensitiveHeader(name: string): boolean {
	const lower = name.toLowerCase();
	return (
		lower === "authorization" ||
		lower === "proxy-authorization" ||
		lower === "cookie" ||
		lower === "set-cookie" ||
		lower.includes("api-key") ||
		lower.includes("apikey") ||
		lower.includes("token")
	);
}

function redactHeaders(headers: HeadersInit | undefined): Record<string, string> {
	const output: Record<string, string> = {};
	const normalized = new Headers(headers ?? {});
	normalized.forEach((value, key) => {
		output[key] = isSensitiveHeader(key) ? "<redacted>" : value;
	});
	return output;
}

function redactUrl(input: RequestInfo | URL): string {
	const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	try {
		const url = new URL(raw);
		url.username = "";
		url.password = "";
		url.search = "";
		url.hash = "";
		return url.href;
	} catch {
		return "<unparseable URL>";
	}
}

function summarizeBodyKeys(body: string): string {
	try {
		const parsed = JSON.parse(body) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "<non-object body>";
		return JSON.stringify(Object.keys(parsed));
	} catch {
		return "<unparseable>";
	}
}

export async function logTargetFailure(
	input: RequestInfo | URL,
	init: RequestInit,
	response: Response,
): Promise<void> {
	try {
		await mkdir(COMPAT_DIR, { recursive: true, mode: 0o700 });
		await chmod(COMPAT_DIR, 0o700);
		const url = redactUrl(input);
		const requestBody = typeof init.body === "string" ? init.body : "<non-string body>";
		let responseBody = "";
		try {
			responseBody = await response.clone().text();
		} catch {
			responseBody = "<unreadable response body>";
		}
		let parsedBody: unknown = requestBody;
		try {
			parsedBody = JSON.parse(requestBody);
		} catch {
			// Preserve non-JSON text.
		}
		const headers = redactHeaders(init.headers);
		const responseHeaders = redactHeaders(response.headers);
		await writeFile(
			DEBUG_LAST_FAILURE_PATH,
			JSON.stringify({
				timestamp: new Date().toISOString(),
				status: response.status,
				url,
				headers,
				body: parsedBody,
				responseHeaders,
				responseBody,
			}, null, 2),
			{ encoding: "utf8", mode: 0o600 },
		);
		await chmod(DEBUG_LAST_FAILURE_PATH, 0o600);
		await appendFile(
			DEBUG_LOG_PATH,
			[
				`==== ${new Date().toISOString()} status=${response.status} ${response.statusText} ====`,
				`url: ${url}`,
				`request headers: ${JSON.stringify(headers)}`,
				`request body keys: ${summarizeBodyKeys(requestBody)}`,
				`request body (${requestBody.length}b): ${requestBody.slice(0, 4000)}`,
				`response headers: ${JSON.stringify(responseHeaders)}`,
				`response body: ${responseBody.slice(0, 8000)}`,
				"",
				"",
			].join("\n"),
			{ encoding: "utf8", mode: 0o600 },
		);
		await chmod(DEBUG_LOG_PATH, 0o600);
	} catch {
		// Diagnostics must never affect provider requests.
	}
}

export interface DoctorInput {
	config: CompatConfig;
	endpoints: ResolvedEndpoint[];
	coordinator: FetchCoordinator;
	ctx: ExtensionCommandContext;
	profiles: ReadonlyMap<WireProfileId, CodexWireProfile>;
}

export interface DoctorResult {
	text: string;
	warnings: string[];
	errors: string[];
}

export async function buildDoctorReport(input: DoctorInput): Promise<DoctorResult> {
	const { config, endpoints, coordinator, ctx, profiles } = input;
	const models = ctx.modelRegistry.getAll();
	const currentProvider = ctx.model?.provider;
	const configuredProviders = new Set(config.providerIds);
	const presentProviders = new Set(models.map((model) => model.provider));
	const missingProviders = config.providerIds.filter((provider) => !presentProviders.has(provider));
	const incompatibleProviders = config.providerIds.filter(
		(provider) =>
			presentProviders.has(provider) &&
			!models.some((model) => model.provider === provider && model.api === "openai-responses"),
	);
	const currentProviderMatches = currentProvider !== undefined && configuredProviders.has(currentProvider);
	const currentProfile = selectWireProfile(profiles, ctx.model?.id);
	const profileIntegrityHealthy = [...profiles.values()].every(
		(profile) => profile.instructionsSha === EXPECTED_PROFILE_SHAS[profile.id],
	);
	const profileSummary = [...profiles.values()]
		.map((profile) => `${profile.id}=${profile.instructionsSha} (${profile.wireMode})`)
		.join(", ");
	const fetchPatchHealthy = getFetchCoordinator() === coordinator && globalThis.fetch === coordinator.patchedFetch;
	const warnings = [...config.warnings];
	const errors: string[] = [];
	if (missingProviders.length) errors.push(`configured providers not found: ${missingProviders.join(", ")}`);
	if (incompatibleProviders.length) {
		errors.push(`configured providers have no openai-responses models: ${incompatibleProviders.join(", ")}`);
	}
	if (currentProviderMatches && ctx.model?.api !== "openai-responses") {
		errors.push(`current configured model api is ${ctx.model?.api}`);
	}
	if (currentProvider && !currentProviderMatches) warnings.push(`current provider is not selected by providerIds: ${currentProvider}`);
	if (currentProviderMatches && ctx.model?.api === "openai-responses" && !currentProfile) {
		warnings.push(`current model has no Codex wire profile: ${ctx.model.id}`);
	}
	if (!profileIntegrityHealthy) errors.push("packaged wire profile SHA does not match the expected baseline");
	if (!fetchPatchHealthy) errors.push("global fetch patch is inactive or replaced");
	if (coordinator.states.size > 1) warnings.push(`duplicate active instances: ${coordinator.states.size}`);
	if (!endpoints.length) warnings.push("no resolved Responses endpoints");

	const lines = [
		`codex-request-compat doctor`,
		`package: ${PACKAGE_VERSION}`,
		`codex baseline: ${CODEX_VERSION}`,
		`config source: ${config.configSource}`,
		`config path: ${config.configPath}`,
		`providerIds: ${config.providerIds.length ? config.providerIds.join(", ") : "(empty)"}`,
		`resolved endpoints: ${endpoints.length ? endpoints.map((endpoint) => `${endpoint.origin}${endpoint.responsesPath}`).join(", ") : "(none)"}`,
		`current provider matches: ${currentProviderMatches}`,
		`configured providers exist: ${missingProviders.length === 0}`,
		`configured providers openai-responses: ${incompatibleProviders.length === 0}`,
		`current api openai-responses: ${ctx.model?.api === "openai-responses"}`,
		`current wire profile: ${currentProfile?.id ?? "unsupported"}`,
		`packaged wire profiles: ${profileSummary}`,
		`fetch patch: ${fetchPatchHealthy ? "active" : "inactive"}`,
		`active instances: ${coordinator.states.size}`,
		`standard tier enforcement: enabled (service_tier removed)`,
		`warnings: ${warnings.length ? warnings.join("; ") : "none"}`,
		`errors: ${errors.length ? errors.join("; ") : "none"}`,
	];
	return { text: lines.join("\n"), warnings, errors };
}

export function presentDoctorReport(result: DoctorResult, ctx: ExtensionCommandContext): void {
	if (ctx.mode === "tui") {
		ctx.ui.notify(result.text, result.errors.length ? "error" : result.warnings.length ? "warning" : "info");
	} else {
		console.log(result.text);
	}
}
