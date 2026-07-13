import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { arch, release, type } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { CODEX_VERSION, COMPAT_DIR, INSTALLATION_ID_PATH, ORIGINATOR } from "./constants.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const execFileAsync = promisify(execFile);

export type RequestKind = "turn" | "compaction";
export interface MetadataSnapshot {
	installationId: string;
	sessionId: string;
	threadId: string;
	turnId: string;
	windowId: string;
	turnMetadata: string;
}

type TurnIdentity = { turnId: string; turnStartedAtUnixMs: number };

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

async function readInstallationId(): Promise<string | undefined> {
	try {
		const value = (await readFile(INSTALLATION_ID_PATH, "utf8")).trim();
		return UUID_PATTERN.test(value) ? value : undefined;
	} catch (error) {
		if (isErrno(error, "ENOENT")) return undefined;
		throw error;
	}
}

export async function loadInstallationId(): Promise<string> {
	const lockPath = `${INSTALLATION_ID_PATH}.lock`;
	await mkdir(COMPAT_DIR, { recursive: true, mode: 0o700 });
	await chmod(COMPAT_DIR, 0o700);
	for (;;) {
		const existing = await readInstallationId();
		if (existing) {
			await chmod(INSTALLATION_ID_PATH, 0o600);
			return existing;
		}
		const candidate = randomUUID();
		try {
			await writeFile(INSTALLATION_ID_PATH, `${candidate}\n`, { flag: "wx", mode: 0o600 });
			return candidate;
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
		const tempPath = `${INSTALLATION_ID_PATH}.${process.pid}.${randomUUID()}.tmp`;
		try {
			const winner = await readInstallationId();
			if (winner) return winner;
			await writeFile(tempPath, `${candidate}\n`, { flag: "wx", mode: 0o600 });
			await rename(tempPath, INSTALLATION_ID_PATH);
			await chmod(INSTALLATION_ID_PATH, 0o600);
			return candidate;
		} finally {
			await unlinkIfExists(tempPath);
			await unlinkIfExists(lockPath);
		}
	}
}

function sanitizeHeaderValue(value: string): string {
	return value.replace(/[^\x20-\x7e]/g, "_");
}

export async function buildUserAgent(): Promise<string> {
	let osToken = `${type()} ${release()}`;
	if (process.platform === "darwin") {
		try {
			const { stdout } = await execFileAsync("sw_vers", ["-productVersion"], { timeout: 2000 });
			if (stdout.trim()) osToken = `Mac OS ${stdout.trim()}`;
		} catch {
			// The generic OS token remains valid.
		}
	}
	const program = process.env.TERM_PROGRAM?.trim();
	const version = process.env.TERM_PROGRAM_VERSION?.trim();
	const terminal = program
		? version
			? `${program}/${version}`
			: program
		: process.env.TERM?.trim() || "unknown";
	return sanitizeHeaderValue(
		`${ORIGINATOR}/${CODEX_VERSION} (${osToken}; ${arch()}) ${terminal} (${ORIGINATOR}; ${CODEX_VERSION})`,
	);
}

export class MetadataRuntime {
	private sessionId: string = randomUUID();
	private windowNumber = 0;
	private requestKind: RequestKind = "turn";
	private turn: TurnIdentity | undefined;
	private readonly installationId: string;

	constructor(installationId: string) {
		this.installationId = installationId;
	}

	startSession(sessionId: string, windowNumber: number): void {
		this.sessionId = sessionId;
		this.windowNumber = windowNumber;
		this.requestKind = "turn";
		this.turn = undefined;
	}

	startTurn(): void {
		this.requestKind = "turn";
		this.turn = { turnId: randomUUID(), turnStartedAtUnixMs: Date.now() };
	}

	startCompaction(): void {
		if (this.requestKind !== "compaction") {
			this.requestKind = "compaction";
			this.turn = { turnId: randomUUID(), turnStartedAtUnixMs: Date.now() };
		}
	}

	finishCompaction(): void {
		this.windowNumber += 1;
		this.reset();
	}

	finishTree(): void {
		this.reset();
	}

	reset(): void {
		this.requestKind = "turn";
		this.turn = undefined;
	}

	getWindowNumber(): number {
		return this.windowNumber;
	}

	getRequestKind(): RequestKind {
		return this.requestKind;
	}

	createSnapshot(): MetadataSnapshot {
		this.turn ??= { turnId: randomUUID(), turnStartedAtUnixMs: Date.now() };
		const threadId = this.sessionId;
		const windowId = `${threadId}:${this.windowNumber}`;
		const turnMetadata = JSON.stringify({
			installation_id: this.installationId,
			session_id: this.sessionId,
			thread_id: threadId,
			turn_id: this.turn.turnId,
			window_id: windowId,
			request_kind: this.requestKind,
			thread_source: "user",
			sandbox: "none",
			turn_started_at_unix_ms: this.turn.turnStartedAtUnixMs,
		});
		return {
			installationId: this.installationId,
			sessionId: this.sessionId,
			threadId,
			turnId: this.turn.turnId,
			windowId,
			turnMetadata,
		};
	}
}
