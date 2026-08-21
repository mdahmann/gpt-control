import { spawn } from "node:child_process";
import { z } from "zod";
import {
	attachFiles,
	captureScreenshot,
	closeSession,
	createSession,
	openChat,
	readAssistantSnapshot,
	setSessionState,
	showSession,
	submitPrompt,
	tabIdFromSession,
	tabUrl,
	type AssistantSnapshot,
} from "./chatgpt";
import { probeBridge, resolveBridgeLauncher, splitCommandLine, type Launcher } from "./transport";
import type { Exec } from "./types";

export const BROWSER_DRIVER_PROTOCOL_VERSION = 1;
export type DriverPageId = string | number;
export type DriverSessionState = "working" | "needs_user" | "completed";

export interface DriverProbe {
	ready: boolean;
	driver: string;
	reason?: string;
}

export interface DriverSession {
	sessionId: string;
	pageId: DriverPageId;
	name: string;
	url: string;
}

export interface WebChatDriver {
	readonly id: string;
	probe(signal?: AbortSignal): Promise<DriverProbe>;
	create(name: string, url: string, signal?: AbortSignal): Promise<DriverSession>;
	show(sessionId: string, signal?: AbortSignal): Promise<DriverSession>;
	upload(session: DriverSession, files: readonly string[], signal?: AbortSignal): Promise<void>;
	submit(session: DriverSession, prompt: string, signal?: AbortSignal): Promise<void>;
	snapshot(session: DriverSession, signal?: AbortSignal): Promise<AssistantSnapshot>;
	setState(sessionId: string, state: DriverSessionState, signal?: AbortSignal): Promise<void>;
	close(sessionId: string, signal?: AbortSignal): Promise<void>;
	screenshot(session: DriverSession, outputPath: string, signal?: AbortSignal): Promise<string | undefined>;
}

export async function waitForNewDriverSnapshot(
	driver: WebChatDriver,
	session: DriverSession,
	options: { baselineCount: number; timeoutMs: number; intervalMs?: number; stableRounds?: number; signal?: AbortSignal },
): Promise<{ settled: boolean; snapshot?: AssistantSnapshot }> {
	const intervalMs = options.intervalMs ?? browserPollIntervalMs();
	const stableRounds = options.stableRounds ?? 3;
	const deadline = Date.now() + options.timeoutMs;
	let latest: AssistantSnapshot | undefined;
	let previous: string | undefined;
	let steady = 0;
	let blank = 0;
	while (Date.now() < deadline) {
		await new Promise((done) => setTimeout(done, intervalMs));
		if (options.signal?.aborted) break;
		const snapshot = await driver.snapshot(session, options.signal);
		if (snapshot.count <= options.baselineCount) {
			steady = 0;
			previous = undefined;
			continue;
		}
		latest = snapshot;
		const fingerprint = `${snapshot.text}\u0000${snapshot.imageUrls.join(",")}`;
		if (fingerprint === "\u0000") {
			blank += 1;
			steady = 0;
			previous = undefined;
			if (blank >= stableRounds * 2) break;
			continue;
		}
		blank = 0;
		if (fingerprint === previous) {
			steady += 1;
			if (steady >= stableRounds) return { settled: true, snapshot };
		} else {
			steady = 0;
			previous = fingerprint;
		}
	}
	return { settled: false, snapshot: latest };
}

export function browserPollIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = Number(env.GPT_CONTROL_POLL_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : 2000;
}

export interface ResolvedBrowserDriver {
	driver?: WebChatDriver;
	probe: DriverProbe;
	source: string;
}

export async function resolveBrowserDriver(
	exec: Exec,
	env: NodeJS.ProcessEnv = process.env,
	signal?: AbortSignal,
): Promise<ResolvedBrowserDriver> {
	const external = env.GPT_CONTROL_BROWSER_DRIVER?.trim();
	if (external) {
		const parts = splitCommandLine(external);
		if (parts.length === 0) return { probe: { ready: false, driver: "external", reason: "GPT_CONTROL_BROWSER_DRIVER is empty" }, source: "GPT_CONTROL_BROWSER_DRIVER" };
		const driver = new ExternalCommandBrowserDriver(parts[0], parts.slice(1));
		const probe = await driver.probe(signal).catch((error): DriverProbe => ({ ready: false, driver: driver.id, reason: message(error) }));
		return { driver: probe.ready ? driver : undefined, probe, source: "GPT_CONTROL_BROWSER_DRIVER" };
	}
	const launcher = resolveBridgeLauncher(env);
	if (launcher) {
		const driver = new ChromeBridgeBrowserDriver(exec, launcher);
		const probe = await driver.probe(signal).catch((error): DriverProbe => ({ ready: false, driver: driver.id, reason: message(error) }));
		return { driver: probe.ready ? driver : undefined, probe, source: launcher.origin };
	}
	return {
		probe: {
			ready: false,
			driver: "none",
			reason: "No browser driver configured. Set GPT_CONTROL_BROWSER_DRIVER or install an adapter such as Chrome Bridge.",
		},
		source: "none",
	};
}

export class ChromeBridgeBrowserDriver implements WebChatDriver {
	readonly id = "chrome-bridge";
	private readonly exec: Exec;
	private readonly launcher: Launcher;

	constructor(exec: Exec, launcher: Launcher) {
		this.exec = exec;
		this.launcher = launcher;
	}

	async probe(signal?: AbortSignal): Promise<DriverProbe> {
		const result = await probeBridge(this.exec, this.launcher, signal);
		return { ready: result.ready, driver: this.id, reason: result.reason };
	}

	async create(name: string, url: string, signal?: AbortSignal): Promise<DriverSession> {
		const sessionId = await createSession(this.exec, this.launcher, name, signal);
		const pageId = await openChat(this.exec, this.launcher, sessionId, url, signal);
		return { sessionId, pageId, name, url };
	}

	async show(sessionId: string, signal?: AbortSignal): Promise<DriverSession> {
		const session = await showSession(this.exec, this.launcher, sessionId, signal);
		const pageId = tabIdFromSession(session);
		if (pageId === undefined) throw new Error(`Browser session ${sessionId} owns no page.`);
		const url = await tabUrl(this.exec, this.launcher, pageId, signal);
		return { sessionId, pageId, name: typeof session.name === "string" ? session.name : "", url: url ?? "" };
	}

	async upload(session: DriverSession, files: readonly string[], signal?: AbortSignal): Promise<void> {
		await attachFiles(this.exec, this.launcher, numericPageId(session.pageId), files, signal);
	}

	async submit(session: DriverSession, prompt: string, signal?: AbortSignal): Promise<void> {
		await submitPrompt(this.exec, this.launcher, numericPageId(session.pageId), prompt, signal);
	}

	async snapshot(session: DriverSession, signal?: AbortSignal): Promise<AssistantSnapshot> {
		return readAssistantSnapshot(this.exec, this.launcher, numericPageId(session.pageId), signal);
	}

	async setState(sessionId: string, state: DriverSessionState, signal?: AbortSignal): Promise<void> {
		await setSessionState(this.exec, this.launcher, sessionId, state, signal);
	}

	async close(sessionId: string, signal?: AbortSignal): Promise<void> {
		await closeSession(this.exec, this.launcher, sessionId, signal);
	}

	async screenshot(session: DriverSession, outputPath: string, signal?: AbortSignal): Promise<string | undefined> {
		return captureScreenshot(this.exec, this.launcher, numericPageId(session.pageId), outputPath, signal);
	}
}

const SessionSchema = z.object({ sessionId: z.string().min(1), pageId: z.union([z.string(), z.number()]), name: z.string(), url: z.string() });
const SnapshotSchema = z.object({ count: z.number().int().nonnegative(), text: z.string(), imageUrls: z.array(z.string()) });
const ProbeSchema = z.object({ ready: z.boolean(), driver: z.string(), reason: z.string().optional() });
const EnvelopeSchema = z.object({
	version: z.literal(BROWSER_DRIVER_PROTOCOL_VERSION),
	ok: z.boolean(),
	result: z.unknown().optional(),
	error: z.string().optional(),
});

export class ExternalCommandBrowserDriver implements WebChatDriver {
	readonly id = "external-command";
	private readonly command: string;
	private readonly args: string[];

	constructor(command: string, args: string[] = []) {
		this.command = command;
		this.args = args;
	}

	async probe(signal?: AbortSignal): Promise<DriverProbe> {
		return ProbeSchema.parse(await this.call("probe", {}, signal));
	}

	async create(name: string, url: string, signal?: AbortSignal): Promise<DriverSession> {
		return SessionSchema.parse(await this.call("create", { name, url }, signal));
	}

	async show(sessionId: string, signal?: AbortSignal): Promise<DriverSession> {
		return SessionSchema.parse(await this.call("show", { sessionId }, signal));
	}

	async upload(session: DriverSession, files: readonly string[], signal?: AbortSignal): Promise<void> {
		await this.call("upload", { session, files }, signal);
	}

	async submit(session: DriverSession, prompt: string, signal?: AbortSignal): Promise<void> {
		await this.call("submit", { session, prompt }, signal);
	}

	async snapshot(session: DriverSession, signal?: AbortSignal): Promise<AssistantSnapshot> {
		return SnapshotSchema.parse(await this.call("snapshot", { session }, signal));
	}

	async setState(sessionId: string, state: DriverSessionState, signal?: AbortSignal): Promise<void> {
		await this.call("set_state", { sessionId, state }, signal);
	}

	async close(sessionId: string, signal?: AbortSignal): Promise<void> {
		await this.call("close", { sessionId }, signal);
	}

	async screenshot(session: DriverSession, outputPath: string, signal?: AbortSignal): Promise<string | undefined> {
		const result = await this.call("screenshot", { session, outputPath }, signal);
		return typeof result === "string" ? result : undefined;
	}

	private async call(action: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		const request = JSON.stringify({ version: BROWSER_DRIVER_PROTOCOL_VERSION, action, params });
		const response = await invokeJsonCommand(this.command, this.args, request, signal);
		const envelope = EnvelopeSchema.parse(response);
		if (!envelope.ok) throw new Error(envelope.error ?? `Browser driver ${action} failed.`);
		return envelope.result;
	}
}

async function invokeJsonCommand(
	command: string,
	args: string[],
	request: string,
	signal?: AbortSignal,
): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], signal });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		const limit = 16 * 1024 * 1024;
		child.stdout.on("data", (chunk: Buffer) => {
			stdoutBytes += chunk.length;
			if (stdoutBytes > limit) child.kill();
			else stdout.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderrBytes += chunk.length;
			if (stderrBytes <= limit) stderr.push(chunk);
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (stdoutBytes > limit) return reject(new Error("Browser driver response exceeded 16 MiB."));
			const output = Buffer.concat(stdout).toString("utf8").trim();
			if (code !== 0) return reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `Browser driver exited ${code}.`));
			try {
				resolve(JSON.parse(output));
			} catch {
				reject(new Error(`Browser driver returned invalid JSON: ${output.slice(0, 400)}`));
			}
		});
		child.stdin.end(`${request}\n`);
	});
}

function numericPageId(value: DriverPageId): number {
	if (typeof value !== "number") throw new Error(`Chrome Bridge requires a numeric page id, received ${value}.`);
	return value;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
