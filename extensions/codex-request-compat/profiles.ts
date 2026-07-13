import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { EXPECTED_PROFILE_SHAS, PACKAGED_PROFILE_PATHS } from "./constants.ts";

export type WireMode = "standard" | "responses-lite";
export type WireProfileId = keyof typeof PACKAGED_PROFILE_PATHS;

export interface CodexWireProfile {
	id: WireProfileId;
	modelIds: readonly string[];
	wireMode: WireMode;
	instructions: string;
	instructionsSha: string;
}

interface ProfileDefinition {
	id: WireProfileId;
	modelIds: readonly string[];
	wireMode: WireMode;
}

export const PROFILE_DEFINITIONS: readonly ProfileDefinition[] = [
	{ id: "gpt-5.4-standard", modelIds: ["gpt-5.4"], wireMode: "standard" },
	{ id: "gpt-5.5-standard", modelIds: ["gpt-5.5"], wireMode: "standard" },
	{
		id: "gpt-5.6-sol-responses-lite",
		modelIds: ["gpt-5.6-sol"],
		wireMode: "responses-lite",
	},
	{
		id: "gpt-5.6-terra-luna-responses-lite",
		modelIds: ["gpt-5.6-terra", "gpt-5.6-luna"],
		wireMode: "responses-lite",
	},
];

export function profileIdForModel(model: unknown): WireProfileId | undefined {
	if (typeof model !== "string") return undefined;
	const normalized = model.trim().toLowerCase();
	return PROFILE_DEFINITIONS.find((definition) => definition.modelIds.includes(normalized))?.id;
}

export function selectWireProfile(
	profiles: ReadonlyMap<WireProfileId, CodexWireProfile>,
	model: unknown,
): CodexWireProfile | undefined {
	const id = profileIdForModel(model);
	return id ? profiles.get(id) : undefined;
}

export async function loadWireProfiles(): Promise<ReadonlyMap<WireProfileId, CodexWireProfile>> {
	const profiles = new Map<WireProfileId, CodexWireProfile>();
	for (const definition of PROFILE_DEFINITIONS) {
		const instructions = await readFile(PACKAGED_PROFILE_PATHS[definition.id], "utf8");
		const instructionsSha = createHash("sha256").update(instructions).digest("hex");
		const expectedSha = EXPECTED_PROFILE_SHAS[definition.id];
		if (instructionsSha !== expectedSha) {
			throw new Error(`Codex wire profile ${definition.id} SHA mismatch`);
		}
		profiles.set(definition.id, { ...definition, instructions, instructionsSha });
	}
	return profiles;
}
