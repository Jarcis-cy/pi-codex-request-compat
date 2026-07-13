import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { buildDoctorReport, logTargetFailure, presentDoctorReport } from "./diagnostics.ts";
import { buildUserAgent, loadInstallationId, MetadataRuntime } from "./metadata.ts";
import { loadWireProfiles, selectWireProfile, type CodexWireProfile } from "./profiles.ts";
import {
	buildCompatHeaders,
	isObject,
	mergeEndpoints,
	registerFetchRuntime,
	unregisterFetchRuntime,
	type CompatRuntimeState,
} from "./transform.ts";

function compatibleProfile(
	ctx: ExtensionContext,
	providerIds: Set<string>,
	profiles: CompatRuntimeState["profiles"],
): CodexWireProfile | undefined {
	if (!ctx.model || !providerIds.has(ctx.model.provider) || ctx.model.api !== "openai-responses") return undefined;
	return selectWireProfile(profiles, ctx.model.id);
}

function bodyMetadata(metadata: ReturnType<MetadataRuntime["createSnapshot"]>): Record<string, string> {
	return {
		"x-codex-installation-id": metadata.installationId,
		session_id: metadata.sessionId,
		thread_id: metadata.threadId,
		turn_id: metadata.turnId,
		"x-codex-window-id": metadata.windowId,
		"x-codex-turn-metadata": metadata.turnMetadata,
	};
}

export default async function codexRequestCompat(pi: ExtensionAPI): Promise<void> {
	const config = await loadConfig();
	const providerIds = new Set(config.providerIds);
	const metadata = new MetadataRuntime(await loadInstallationId());
	const state: CompatRuntimeState = {
		metadata,
		userAgent: await buildUserAgent(),
		profiles: await loadWireProfiles(),
		endpoints: mergeEndpoints(config.baseUrls),
		logFailure: logTargetFailure,
	};
	const { instanceId, coordinator } = registerFetchRuntime(state);

	pi.on("session_start", (_event, ctx) => {
		let windowNumber = 0;
		try {
			windowNumber = ctx.sessionManager.getBranch().filter((entry) => entry.type === "compaction").length;
		} catch {
			// New and ephemeral sessions start at window zero.
		}
		metadata.startSession(ctx.sessionManager.getSessionId(), windowNumber);
		const discovered = ctx.modelRegistry
			.getAll()
			.filter((model) => providerIds.has(model.provider) && model.api === "openai-responses")
			.map((model) => model.baseUrl)
			.filter((baseUrl): baseUrl is string => typeof baseUrl === "string" && baseUrl.trim().length > 0);
		state.endpoints = mergeEndpoints([...config.baseUrls, ...discovered]);
	});

	pi.on("session_shutdown", () => {
		metadata.reset();
		unregisterFetchRuntime(instanceId);
	});

	pi.on("agent_start", () => metadata.startTurn());
	pi.on("agent_settled", () => metadata.reset());
	pi.on("session_before_compact", () => metadata.startCompaction());
	pi.on("session_compact", () => metadata.finishCompaction());
	pi.on("session_before_tree", (event) => {
		if (event.preparation.userWantsSummary) metadata.startCompaction();
	});
	pi.on("session_tree", () => metadata.finishTree());

	pi.on("before_provider_headers", (event, ctx) => {
		const profile = compatibleProfile(ctx, providerIds, state.profiles);
		if (!profile) return;
		const snapshot = metadata.createSnapshot();
		const headers = buildCompatHeaders(event.headers as HeadersInit, state, profile, snapshot);
		headers.forEach((value, key) => {
			event.headers[key] = value;
		});
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!compatibleProfile(ctx, providerIds, state.profiles) || !isObject(event.payload)) return;
		const snapshot = metadata.createSnapshot();
		return {
			...event.payload,
			client_metadata: {
				...(isObject(event.payload.client_metadata) ? event.payload.client_metadata : {}),
				...bodyMetadata(snapshot),
			},
		};
	});

	pi.registerCommand("codex-compat:doctor", {
		description: "Diagnose Codex request compatibility without making network requests",
		handler: async (_args, ctx) => {
			const report = await buildDoctorReport({
				config,
				endpoints: state.endpoints,
				coordinator,
				ctx,
				profiles: state.profiles,
			});
			presentDoctorReport(report, ctx);
		},
	});
}
