import { readFile } from "node:fs/promises";
import { PACKAGED_CONFIG_PATH, USER_CONFIG_PATH } from "./constants.ts";

export interface CompatConfig {
	providerIds: string[];
	baseUrls: string[];
	configSource: "packaged" | "user";
	configPath: string;
	warnings: string[];
}

type ConfigField = "providerIds" | "baseUrls";

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStrings(value: unknown, field: ConfigField, warnings: string[]): string[] | undefined {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		warnings.push(`${field} must be an array of strings`);
		return undefined;
	}
	const normalized = value.map((item) => item.trim()).filter(Boolean);
	return [...new Set(normalized)];
}

function normalizeBaseUrls(value: unknown, warnings: string[]): string[] | undefined {
	const strings = normalizeStrings(value, "baseUrls", warnings);
	if (!strings) return undefined;
	const urls: string[] = [];
	for (const candidate of strings) {
		try {
			const url = new URL(candidate);
			if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported scheme");
			if (url.username || url.password || url.search || url.hash) {
				throw new Error("userinfo, query, and fragment are not allowed");
			}
			url.pathname = url.pathname.replace(/\/+$/, "") || "/";
			const normalized = url.toString().replace(/\/$/, "");
			if (!urls.includes(normalized)) urls.push(normalized);
		} catch {
			warnings.push(`baseUrls ignored invalid HTTP(S) URL: ${JSON.stringify(candidate)}`);
		}
	}
	return urls;
}

async function readJson(path: string): Promise<unknown> {
	return JSON.parse(await readFile(path, "utf8"));
}

export async function loadConfig(): Promise<CompatConfig> {
	const warnings: string[] = [];
	const packaged = await readJson(PACKAGED_CONFIG_PATH);
	if (!isObject(packaged)) throw new Error(`Invalid packaged config: ${PACKAGED_CONFIG_PATH}`);
	const defaultProviders = normalizeStrings(packaged.providerIds, "providerIds", warnings);
	const defaultBaseUrls = normalizeBaseUrls(packaged.baseUrls, warnings);
	if (!defaultProviders || !defaultBaseUrls) {
		throw new Error(`Invalid packaged config fields: ${PACKAGED_CONFIG_PATH}`);
	}

	let providerIds = defaultProviders;
	let baseUrls = defaultBaseUrls;
	let configSource: CompatConfig["configSource"] = "packaged";
	let configPath = PACKAGED_CONFIG_PATH;
	try {
		const user = await readJson(USER_CONFIG_PATH);
		configSource = "user";
		configPath = USER_CONFIG_PATH;
		if (!isObject(user)) {
			warnings.push("user config must be a JSON object; packaged defaults are active");
		} else {
			if (Object.hasOwn(user, "providerIds")) {
				providerIds = normalizeStrings(user.providerIds, "providerIds", warnings) ?? providerIds;
			}
			if (Object.hasOwn(user, "baseUrls")) {
				baseUrls = normalizeBaseUrls(user.baseUrls, warnings) ?? baseUrls;
			}
		}
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
			warnings.push(`unable to load user config: ${error instanceof Error ? error.message : String(error)}`);
			configSource = "user";
			configPath = USER_CONFIG_PATH;
		}
	}

	return { providerIds, baseUrls, configSource, configPath, warnings };
}
