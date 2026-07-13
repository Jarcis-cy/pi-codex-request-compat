import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_VERSION = "0.2.1";
export const CODEX_VERSION = "0.144.1";
export const ORIGINATOR = "codex_exec";
export const EXPECTED_PROFILE_SHAS = {
	"gpt-5.4-standard": "478e8a11b180adb2659f21aba51744711f79f665039bb0bc4a13d3c051fcb76c",
	"gpt-5.5-standard": "c2a980bc28af132eb89e0b4c68ae884043faae83a1afd3fd4889f7e8a1ada7b0",
	"gpt-5.6-sol-responses-lite": "e9778714d505f3dd04d44db4394024c5fab5bf6554fc9faa3cdf9cf776b63bb9",
	"gpt-5.6-terra-luna-responses-lite": "78a2fc84e1bffa421d865c1a2ade4185d3d33ef38e6a15157f0ff1a89b7d52ec",
} as const;
export const FETCH_PATCH_KEY = "__codexRequestCompatFetchPatchV2";
export const COMPAT_DIR = join(getAgentDir(), "codex-request-compat");
export const USER_CONFIG_PATH = join(COMPAT_DIR, "config.json");
export const INSTALLATION_ID_PATH = join(COMPAT_DIR, "installation-id");
export const DEBUG_LOG_PATH = join(COMPAT_DIR, "request-debug.log");
export const DEBUG_LAST_FAILURE_PATH = join(COMPAT_DIR, "last-failed-request.json");
export const PACKAGED_CONFIG_PATH = fileURLToPath(
	new URL("../../config/default.json", import.meta.url),
);
export const PACKAGED_PROFILE_PATHS = {
	"gpt-5.4-standard": fileURLToPath(
		new URL("../../assets/codex-0.144.1/gpt-5.4-standard.txt", import.meta.url),
	),
	"gpt-5.5-standard": fileURLToPath(
		new URL("../../assets/codex-0.144.1/gpt-5.5-standard.txt", import.meta.url),
	),
	"gpt-5.6-sol-responses-lite": fileURLToPath(
		new URL("../../assets/codex-0.144.1/gpt-5.6-responses-lite.txt", import.meta.url),
	),
	"gpt-5.6-terra-luna-responses-lite": fileURLToPath(
		new URL("../../assets/codex-0.144.1/gpt-5.6-terra-luna-responses-lite.txt", import.meta.url),
	),
} as const;
