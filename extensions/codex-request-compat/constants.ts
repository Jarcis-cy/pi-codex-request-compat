import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_VERSION = "0.2.0";
export const CODEX_VERSION = "0.144.1";
export const ORIGINATOR = "codex_exec";
export const EXPECTED_PROMPT_SHA = "e9778714d505f3dd04d44db4394024c5fab5bf6554fc9faa3cdf9cf776b63bb9";
export const FETCH_PATCH_KEY = "__codexRequestCompatFetchPatchV2";
export const COMPAT_DIR = join(getAgentDir(), "codex-request-compat");
export const USER_CONFIG_PATH = join(COMPAT_DIR, "config.json");
export const INSTALLATION_ID_PATH = join(COMPAT_DIR, "installation-id");
export const DEBUG_LOG_PATH = join(COMPAT_DIR, "request-debug.log");
export const DEBUG_LAST_FAILURE_PATH = join(COMPAT_DIR, "last-failed-request.json");
export const LEGACY_INSTRUCTIONS_PATH = join(COMPAT_DIR, "codex-instructions.txt");
export const PACKAGED_CONFIG_PATH = fileURLToPath(
	new URL("../../config/default.json", import.meta.url),
);
export const PACKAGED_INSTRUCTIONS_PATH = fileURLToPath(
	new URL("../../assets/codex-instructions.txt", import.meta.url),
);
export const FALLBACK_CODEX_INSTRUCTIONS =
	"You are Codex, based on GPT-5. You are running as a coding agent in the Codex CLI on a user's computer.";
