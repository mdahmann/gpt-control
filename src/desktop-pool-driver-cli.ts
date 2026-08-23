#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commandLineHasExactArgument, createMacDesktopCdpEnvironment } from "./desktop-cdp-macos";
import {
	closeDesktopDriverSessionOffline,
	DESKTOP_DRIVER_VERSION,
	DESKTOP_STATE_WRITER_VERSION,
	handleDesktopDriverRequest,
	type DesktopDriverEnvelope,
	type DesktopDriverRequest,
} from "./desktop-driver";

const execFileAsync = promisify(execFile);
const POOL_DRIVER_ID = "chatgpt-desktop-pool/v1";
const OFFICIAL_TEAM_ID = "2DC432GLL2";
const DEFAULT_APP_PATH = "/Applications/ChatGPT.app";
const DEFAULT_POOL_PORT = 9237;
const DEFAULT_POOL_SIZE = 6;
const INPUT_LIMIT = 16 * 1024 * 1024;

interface PoolConfig {
	root: string;
	appPath: string;
	startPort: number;
	size: number;
	allowInteractiveBootstrap: boolean;
}

interface PoolLane {
	index: number;
	endpoint: string;
	port: number;
	profileRoot: string;
	stateRoot: string;
}

export function laneHasExactlyOneReadyShell(targets: Array<{ surface?: string }>): boolean {
	const count = targets.filter((target) => target.surface === "desktop_shell").length;
	if (count > 1) throw new Error(`ChatGPT Desktop worker lane has ambiguous ready shells (${count}).`);
	return count === 1;
}

export function assertLaneCanLaunch(laneIndex: number, sessionIds: string[]): void {
	if (sessionIds.length > 0) {
		throw new Error(`ChatGPT Desktop lane ${laneIndex} has durable work but its exact process is unavailable; explicit recovery is required.`);
	}
}

interface PoolLockOwner {
	version: 1;
	token: string;
	pid: number;
	hostname: string;
	processStartId: string;
	startedAt: string;
}

export function loadPoolConfig(env: NodeJS.ProcessEnv = process.env): PoolConfig {
	const root = resolve(env.GPT_CONTROL_DRIVER_DESKTOP_POOL_ROOT
		?? resolve(homedir(), ".gpt-control", "desktop-worker-pool"));
	const appPath = resolve(env.GPT_CONTROL_DRIVER_DESKTOP_APP_PATH ?? DEFAULT_APP_PATH);
	if (/\s/.test(root)) throw new Error("ChatGPT Desktop worker-pool paths containing whitespace are not supported for exact process identity.");
	const startPort = parseInteger(env.GPT_CONTROL_DRIVER_DESKTOP_POOL_START_PORT, DEFAULT_POOL_PORT, 1024, 65_535, "pool start port");
	const size = parseInteger(env.GPT_CONTROL_DRIVER_DESKTOP_POOL_SIZE, DEFAULT_POOL_SIZE, 1, 10, "pool size");
	if (startPort + size - 1 > 65_535) throw new Error("ChatGPT Desktop worker-pool port range exceeds 65535.");
	return {
		root,
		appPath,
		startPort,
		size,
		allowInteractiveBootstrap: env.GPT_CONTROL_DRIVER_DESKTOP_ALLOW_INTERACTIVE_BOOTSTRAP === "1",
	};
}

export function poolLanes(config: PoolConfig): PoolLane[] {
	return Array.from({ length: config.size }, (_, offset) => {
		const label = String(offset + 1).padStart(2, "0");
		const root = join(config.root, "lanes", label);
		const port = config.startPort + offset;
		return {
			index: offset + 1,
			endpoint: `http://127.0.0.1:${port}`,
			port,
			profileRoot: join(root, "profile"),
			stateRoot: join(root, "state"),
		};
	});
}

export function requestSessionId(request: DesktopDriverRequest): string | undefined {
	if (request.action === "show" || request.action === "close" || request.action === "set_state") {
		return typeof request.params.sessionId === "string" ? request.params.sessionId : undefined;
	}
	const session = request.params.session;
	return isRecord(session) && typeof session.sessionId === "string" ? session.sessionId : undefined;
}

export function requestRequiresPoolAllocationLock(action: string): boolean {
	return action === "create" || action === "find_conversations" || action === "close";
}

export function addPoolLaneReceipt(response: DesktopDriverEnvelope, laneIndex: number): DesktopDriverEnvelope {
	if (!response.ok || !isRecord(response.result)) return response;
	return { ...response, result: { ...response.result, desktopPoolLane: laneIndex } };
}

export async function handleDesktopPoolRequest(
	request: DesktopDriverRequest,
	env: NodeJS.ProcessEnv = process.env,
): Promise<DesktopDriverEnvelope> {
	if (request.version !== 2 || typeof request.action !== "string" || !isRecord(request.params)) {
		return failure("Invalid browser-driver protocol-v2 request.");
	}
	try {
		const config = loadPoolConfig(env);
		await secureDirectory(config.root);
		if (request.action === "probe") return success(await passivePoolProbe(config));
		const lanes = poolLanes(config);
		const dispatch = async (): Promise<DesktopDriverEnvelope> => {
			if (request.action === "create") {
				const lane = await firstFreeLane(lanes);
				if (!lane) throw new Error(`ChatGPT Desktop worker pool is at capacity (${config.size} lanes).`);
				await ensureLaneReady(lane, config, env);
				const response = await invokeLane(lane, config, request, env);
				if (!response.ok) {
					const retainedSessionIds = await laneSessionIds(lane);
					try {
						await stopLane(lane, config, env);
						for (const retainedSessionId of retainedSessionIds) {
							await closeDesktopDriverSessionOffline(lane.stateRoot, retainedSessionId);
						}
					} catch (cleanupError) {
						return failure(`${response.error ?? "ChatGPT Desktop create failed."} Cleanup failed: ${errorMessage(cleanupError)}${retainedSessionIds.length > 0 ? ` Retained session IDs: ${retainedSessionIds.join(", ")}.` : ""}`);
					}
				}
				return addPoolLaneReceipt(response, lane.index);
			}
			if (request.action === "find_conversations") {
				const lane = await firstRunningLane(lanes, config, env) ?? lanes[0];
				const discoveryOnly = (await laneSessionIds(lane)).length === 0;
				await ensureLaneReady(lane, config, env);
				try {
					return await invokeLane(lane, config, request, env);
				} finally {
					if (discoveryOnly && (await laneSessionIds(lane)).length === 0) await stopLane(lane, config, env);
				}
			}
			const sessionId = requestSessionId(request);
			if (!sessionId) throw new Error(`Desktop worker-pool action ${request.action} requires an exact session id.`);
			const matches: PoolLane[] = [];
			for (const lane of lanes) if ((await laneSessionIds(lane)).includes(sessionId)) matches.push(lane);
			if (matches.length !== 1) {
				throw new Error(matches.length === 0
					? `Unknown ChatGPT Desktop worker-pool session: ${sessionId}`
					: `ChatGPT Desktop worker-pool session ${sessionId} is ambiguously bound to multiple lanes.`);
			}
			const lane = matches[0];
			if (request.action === "close") {
				const bound = await laneSessionIds(lane);
				if (bound.length !== 1 || bound[0] !== sessionId) {
					throw new Error(`ChatGPT Desktop lane ${lane.index} cannot close while another durable session is present.`);
				}
				await stopLane(lane, config, env);
				await closeDesktopDriverSessionOffline(lane.stateRoot, sessionId);
				return success({});
			}
			await ensureLaneReady(lane, config, env);
			const response = await invokeLane(lane, config, request, env);
			return response;
		};
		return requestRequiresPoolAllocationLock(request.action)
			? withPoolAllocationLock(config.root, dispatch)
			: dispatch();
	} catch (error) {
		return failure(errorMessage(error));
	}
}

async function passivePoolProbe(config: PoolConfig): Promise<Record<string, unknown>> {
	await execFileAsync("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", config.appPath], { timeout: 30_000 });
	const signature = await execFileAsync("/usr/bin/codesign", ["-dv", "--verbose=4", config.appPath], { timeout: 10_000 });
	const combined = `${signature.stdout}\n${signature.stderr}`;
	const identifier = /^Identifier=(.+)$/m.exec(combined)?.[1]?.trim();
	const teamId = /^TeamIdentifier=(.+)$/m.exec(combined)?.[1]?.trim();
	if ((identifier !== "com.openai.codex" && identifier !== "com.openai.chat") || teamId !== OFFICIAL_TEAM_ID) {
		throw new Error(`Refused unverified ChatGPT.app signature (bundle=${identifier ?? "unknown"}, team=${teamId ?? "unknown"}).`);
	}
	return {
		ready: true,
		driver: POOL_DRIVER_ID,
		driverVersion: DESKTOP_DRIVER_VERSION,
		stateWriterVersion: DESKTOP_STATE_WRITER_VERSION,
		secureInput: true,
		protocolVersion: 2,
		pool: { size: config.size, startPort: config.startPort, rootSha256: sha256(config.root) },
	};
}

async function firstFreeLane(lanes: PoolLane[]): Promise<PoolLane | undefined> {
	for (const lane of lanes) if ((await laneSessionIds(lane)).length === 0) return lane;
	return undefined;
}

async function firstRunningLane(lanes: PoolLane[], config: PoolConfig, env: NodeJS.ProcessEnv): Promise<PoolLane | undefined> {
	for (const lane of lanes) {
		if (!await endpointAlive(lane.endpoint)) continue;
		try {
			await laneEnvironment(lane, config, env).verifyHost();
			return lane;
		} catch {
			// A listener that is not this exact signed lane is never adopted.
		}
	}
	return undefined;
}

async function ensureLaneReady(lane: PoolLane, config: PoolConfig, env: NodeJS.ProcessEnv): Promise<void> {
	await secureDirectory(dirname(lane.profileRoot));
	await secureDirectory(lane.profileRoot);
	await secureDirectory(lane.stateRoot);
	const bootstrapped = await laneBootstrapComplete(lane);
	const environment = laneEnvironment(lane, config, env);
	const sessionIds = await laneSessionIds(lane);
	if (await endpointAlive(lane.endpoint)) {
		const host = await environment.verifyHost();
		try {
			if (laneHasExactlyOneReadyShell(await environment.listTargets())) {
				await quietWorkerWindows(host.listenerPid, await currentFrontmostPid());
				await markLaneBootstrapped(lane);
				return;
			}
		} catch (error) {
			if (sessionIds.length > 0) throw error;
		}
		if (sessionIds.length > 0) {
			throw new Error(`ChatGPT Desktop lane ${lane.index} has durable work but no exact eligible shell.`);
		}
		await stopLane(lane, config, env);
	}
	assertLaneCanLaunch(lane.index, sessionIds);
	const interactiveBootstrap = !bootstrapped && config.allowInteractiveBootstrap;
	const frontmostPid = await currentFrontmostPid();
	await execFileAsync("/usr/bin/open", [
		...(!interactiveBootstrap ? ["-g", "-j"] : []), "-n", config.appPath, "--args",
		`--user-data-dir=${lane.profileRoot}`,
		"--remote-debugging-address=127.0.0.1",
		`--remote-debugging-port=${lane.port}`,
	], { timeout: 15_000 });
	const deadline = Date.now() + (interactiveBootstrap ? 5 * 60_000 : 30_000);
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			const host = await environment.verifyHost();
			if (!interactiveBootstrap) await quietWorkerWindows(host.listenerPid, frontmostPid);
			if (!laneHasExactlyOneReadyShell(await environment.listTargets())) {
				lastError = new Error(`ChatGPT Desktop lane ${lane.index} has not exposed one ready ChatGPT shell.`);
				await sleep(150);
				continue;
			}
			await quietWorkerWindows(host.listenerPid, frontmostPid);
			await markLaneBootstrapped(lane);
			return;
		} catch (error) {
			lastError = error;
			await sleep(150);
		}
	}
	const startupError = errorMessage(lastError);
	await stopLane(lane, config, env).catch((cleanupError) => {
		throw new Error(`ChatGPT Desktop lane ${lane.index} did not become ready: ${startupError}; cleanup failed: ${errorMessage(cleanupError)}`);
	});
	throw new Error(!bootstrapped && !interactiveBootstrap
		? `ChatGPT Desktop lane ${lane.index} could not bootstrap in the background: ${startupError}. Set GPT_CONTROL_DRIVER_DESKTOP_ALLOW_INTERACTIVE_BOOTSTRAP=1 for an authorized one-time visible setup run.`
		: `ChatGPT Desktop lane ${lane.index} did not become ready: ${startupError}`);
}

async function laneBootstrapComplete(lane: PoolLane): Promise<boolean> {
	const path = join(dirname(lane.profileRoot), "bootstrap.json");
	try {
		const info = await lstat(path);
		if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Refused unsafe ChatGPT Desktop lane ${lane.index} bootstrap receipt.`);
		const value = JSON.parse(await readFile(path, "utf8")) as unknown;
		return isRecord(value) && value.version === 1 && value.profileSha256 === sha256(resolve(lane.profileRoot));
	} catch (error) {
		if (isMissing(error)) return false;
		throw error;
	}
}

async function markLaneBootstrapped(lane: PoolLane): Promise<void> {
	if (await laneBootstrapComplete(lane)) return;
	const path = join(dirname(lane.profileRoot), "bootstrap.json");
	try {
		await writeFile(path, `${JSON.stringify({
			version: 1,
			profileSha256: sha256(resolve(lane.profileRoot)),
			completedAt: new Date().toISOString(),
		})}\n`, { mode: 0o600, flag: "wx" });
	} catch (error) {
		if (isAlreadyExists(error) && await laneBootstrapComplete(lane)) return;
		throw error;
	}
}

async function invokeLane(
	lane: PoolLane,
	config: PoolConfig,
	request: DesktopDriverRequest,
	env: NodeJS.ProcessEnv,
): Promise<DesktopDriverEnvelope> {
	return handleDesktopDriverRequest(request, {
		environment: laneEnvironment(lane, config, env),
		stateRoot: lane.stateRoot,
		allowCreateTarget: true,
	});
}

function laneEnvironment(lane: PoolLane, config: PoolConfig, env: NodeJS.ProcessEnv) {
	return createMacDesktopCdpEnvironment({
		...env,
		GPT_CONTROL_DRIVER_DESKTOP_CDP_ENDPOINT: lane.endpoint,
		GPT_CONTROL_DRIVER_DESKTOP_APP_PATH: config.appPath,
		GPT_CONTROL_DRIVER_DESKTOP_DEDICATED_PROCESS: "1",
		GPT_CONTROL_DRIVER_DESKTOP_DEDICATED_PROFILE_ROOT: lane.profileRoot,
	});
}

async function stopLane(lane: PoolLane, config: PoolConfig, env: NodeJS.ProcessEnv): Promise<void> {
	if (!await endpointAlive(lane.endpoint)) {
		await assertLaneIsOffline(lane);
		return;
	}
	const host = await laneEnvironment(lane, config, env).verifyHost();
	const identities = await processTreeIdentities(host.listenerPid, lane);
	for (const identity of [...identities].reverse()) await signalExactProcess(identity, "SIGTERM");
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if ((await Promise.all(identities.map(exactProcessIsAlive))).every((alive) => !alive) && !await endpointAlive(lane.endpoint)) {
			try {
				await assertLaneIsOffline(lane);
				return;
			} catch {}
		}
		await sleep(100);
	}
	for (const identity of [...identities].reverse()) await signalExactProcess(identity, "SIGKILL");
	const killDeadline = Date.now() + 5_000;
	while (Date.now() < killDeadline) {
		if ((await Promise.all(identities.map(exactProcessIsAlive))).every((alive) => !alive) && !await endpointAlive(lane.endpoint)) {
			try {
				await assertLaneIsOffline(lane);
				return;
			} catch {}
		}
		await sleep(100);
	}
	throw new Error(`ChatGPT Desktop lane ${lane.index} process tree rooted at ${host.listenerPid} did not stop.`);
}

interface ProcessIdentity {
	pid: number;
	processStartId: string;
}

export function descendantProcessIds(processList: string, rootPid: number): number[] {
	const children = new Map<number, number[]>();
	for (const line of processList.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
		if (!match) continue;
		const pid = Number(match[1]);
		const parent = Number(match[2]);
		children.set(parent, [...(children.get(parent) ?? []), pid]);
	}
	const result = [rootPid];
	for (let index = 0; index < result.length; index += 1) {
		for (const child of children.get(result[index]) ?? []) if (!result.includes(child)) result.push(child);
	}
	return result;
}

async function processTreeIdentities(rootPid: number, lane: PoolLane): Promise<ProcessIdentity[]> {
	const [treeList, commandList, listenerList] = await Promise.all([
		execFileAsync("/bin/ps", ["-axo", "pid=,ppid="], { timeout: 5_000, maxBuffer: 1024 * 1024, encoding: "utf8" }).then(({ stdout }) => stdout),
		execFileAsync("/bin/ps", ["-axo", "pid=,command="], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }).then(({ stdout }) => stdout),
		execFileAsync("/usr/sbin/lsof", ["-nP", `-iTCP:${lane.port}`, "-sTCP:LISTEN", "-Fp"], { timeout: 5_000, maxBuffer: 1024 * 1024, encoding: "utf8" }).then(({ stdout }) => stdout),
	]);
	const pids = new Set([
		...descendantProcessIds(treeList, rootPid),
		...profileAssociatedProcessPids(commandList, resolve(lane.profileRoot)),
		...listenerProcessPids(listenerList),
	]);
	const identities = (await Promise.all([...pids].map(async (pid) => {
		const processStartId = await localProcessStartId(pid).catch(() => undefined);
		return processStartId ? { pid, processStartId } : undefined;
	}))).filter((identity): identity is ProcessIdentity => Boolean(identity));
	if (!identities.some(({ pid }) => pid === rootPid)) throw new Error(`ChatGPT Desktop worker root process ${rootPid} disappeared before shutdown identity was recorded.`);
	return identities;
}

async function exactProcessIsAlive(identity: ProcessIdentity): Promise<boolean> {
	if (!processIsAlive(identity.pid)) return false;
	return await localProcessStartId(identity.pid).catch(() => undefined) === identity.processStartId;
}

async function signalExactProcess(identity: ProcessIdentity, signal: NodeJS.Signals): Promise<void> {
	if (!await exactProcessIsAlive(identity)) return;
	process.kill(identity.pid, signal);
}

async function laneSessionIds(lane: PoolLane): Promise<string[]> {
	await secureDirectory(dirname(lane.stateRoot));
	await secureDirectory(lane.stateRoot);
	try {
		const path = join(lane.stateRoot, "state.json");
		const info = await lstat(path);
		if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Refused unsafe ChatGPT Desktop lane ${lane.index} state.`);
		const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		let raw: string;
		try {
			raw = await handle.readFile("utf8");
		} finally {
			await handle.close();
		}
		const value = JSON.parse(raw) as unknown;
		if (!isRecord(value) || !isRecord(value.sessions)) throw new Error("invalid lane state");
		return Object.keys(value.sessions);
	} catch (error) {
		if (isMissing(error)) return [];
		throw new Error(`Invalid ChatGPT Desktop lane ${lane.index} state: ${errorMessage(error)}`);
	}
}

export async function withPoolAllocationLock<T>(root: string, work: () => Promise<T>): Promise<T> {
	const lockRoot = join(root, "allocation.lock");
	const ownerPath = join(lockRoot, "owner.json");
	const owner: PoolLockOwner = {
		version: 1,
		token: randomUUID(),
		pid: process.pid,
		hostname: hostname(),
		processStartId: await localProcessStartId(process.pid),
		startedAt: new Date().toISOString(),
	};
	const deadline = Date.now() + 30_000;
	while (true) {
		let identity: { dev: number; ino: number } | undefined;
		try {
			await mkdir(lockRoot, { mode: 0o700 });
			const info = await lstat(lockRoot);
			identity = { dev: info.dev, ino: info.ino };
			try {
				await writeFile(ownerPath, `${JSON.stringify(owner)}\n`, { mode: 0o600, flag: "wx" });
			} catch (error) {
				const current = await lstat(lockRoot).catch(() => undefined);
				if (current && current.dev === identity.dev && current.ino === identity.ino) {
					await rm(lockRoot, { recursive: true, force: true }).catch(() => undefined);
				}
				throw error;
			}
			break;
		} catch (error) {
			if (!isAlreadyExists(error)) throw error;
			if (await recoverPoolLock(lockRoot, ownerPath)) continue;
			if (Date.now() >= deadline) throw new Error("Timed out waiting for the ChatGPT Desktop worker-pool allocation lock.");
			await sleep(50);
		}
	}
	try {
		return await work();
	} finally {
		const existing = await readPoolLockOwner(ownerPath).catch(() => undefined);
		if (existing?.token === owner.token) await rm(lockRoot, { recursive: true, force: true });
	}
}

async function readPoolLockOwner(path: string): Promise<PoolLockOwner> {
	const info = await lstat(path);
	if (info.isSymbolicLink() || !info.isFile()) throw new Error("Unsafe ChatGPT Desktop worker-pool lock owner.");
	const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	let raw: string;
	try {
		raw = await handle.readFile("utf8");
	} finally {
		await handle.close();
	}
	const value = JSON.parse(raw) as unknown;
	if (!isRecord(value) || value.version !== 1 || typeof value.token !== "string"
		|| typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0
		|| typeof value.hostname !== "string" || typeof value.processStartId !== "string"
		|| value.processStartId === "" || typeof value.startedAt !== "string") {
		throw new Error("Invalid ChatGPT Desktop worker-pool lock owner.");
	}
	return value as unknown as PoolLockOwner;
}

async function recoverPoolLock(lockRoot: string, ownerPath: string): Promise<boolean> {
	const info = await lstat(lockRoot).catch((error) => {
		if (isMissing(error)) return undefined;
		throw error;
	});
	if (!info) return true;
	if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Refused unsafe worker-pool lock: ${lockRoot}`);
	const first = await readPoolLockOwner(ownerPath).catch(() => undefined);
	if (!first) {
		if (Date.now() - info.mtimeMs <= 2_000) return false;
	} else if (await poolLockOwnerIsAlive(first)) {
		return false;
	}
	const second = await readPoolLockOwner(ownerPath).catch(() => undefined);
	if ((first?.token ?? "") !== (second?.token ?? "")) return false;
	if (second && await poolLockOwnerIsAlive(second)) return false;
	const stale = `${lockRoot}.stale-${randomUUID()}`;
	try {
		await rename(lockRoot, stale);
		await rm(stale, { recursive: true, force: true });
		return true;
	} catch (error) {
		if (isMissing(error)) return false;
		throw error;
	}
}

async function poolLockOwnerIsAlive(owner: PoolLockOwner): Promise<boolean> {
	if (owner.hostname !== hostname()) return true;
	if (!processIsAlive(owner.pid)) return false;
	return await localProcessStartId(owner.pid).catch(() => undefined) === owner.processStartId;
}

async function localProcessStartId(pid: number): Promise<string> {
	const result = await execFileAsync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
		timeout: 5_000,
		maxBuffer: 64 * 1024,
		encoding: "utf8",
	});
	const value = result.stdout.trim();
	if (!value) throw new Error(`Process ${pid} is unavailable.`);
	return value;
}

async function secureDirectory(path: string): Promise<void> {
	try {
		const info = await lstat(path);
		if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Refused unsafe worker-pool directory: ${path}`);
	} catch (error) {
		if (!isMissing(error)) throw error;
		await mkdir(path, { recursive: true, mode: 0o700 });
	}
	await chmod(path, 0o700);
	const canonical = await realpath(path);
	if (canonical !== resolve(path)) throw new Error(`Refused worker-pool directory through a symlinked path: ${path}`);
}

async function endpointAlive(endpoint: string): Promise<boolean> {
	try {
		const response = await fetch(new URL("/json/version", endpoint), { signal: AbortSignal.timeout(500) });
		return response.ok;
	} catch {
		return false;
	}
}

export function profileAssociatedProcessPids(processList: string, profileRoot: string): number[] {
	const userDataArgument = `--user-data-dir=${profileRoot}`;
	const crashDatabaseArgument = `--database=${join(profileRoot, "Crashpad")}`;
	const pids: number[] = [];
	for (const line of processList.split("\n")) {
		const match = /^\s*(\d+)\s+(.+)$/.exec(line);
		if (!match) continue;
		if (!commandLineHasExactArgument(match[2], userDataArgument)
			&& !commandLineHasExactArgument(match[2], crashDatabaseArgument)) continue;
		const pid = Number(match[1]);
		if (Number.isSafeInteger(pid) && pid > 0) pids.push(pid);
	}
	return pids;
}

export function listenerProcessPids(lsofOutput: string): number[] {
	return [...new Set(lsofOutput.split("\n")
		.filter((line) => /^p\d+$/.test(line))
		.map((line) => Number(line.slice(1)))
		.filter((pid) => Number.isSafeInteger(pid) && pid > 0))];
}

async function assertLaneIsOffline(lane: PoolLane): Promise<void> {
	let listeners = "";
	try {
		listeners = (await execFileAsync("/usr/sbin/lsof", [
			"-nP", `-iTCP:${lane.port}`, "-sTCP:LISTEN", "-Fp",
		], { timeout: 5_000, maxBuffer: 1024 * 1024, encoding: "utf8" })).stdout;
	} catch (error) {
		if (!(isRecord(error) && error.code === 1 && String(error.stdout ?? "") === "")) throw error;
	}
	if (/^p\d+$/m.test(listeners)) {
		throw new Error(`ChatGPT Desktop lane ${lane.index} still has a listener on port ${lane.port}; offline close was refused.`);
	}
	const processList = (await execFileAsync("/bin/ps", ["-axo", "pid=,command="], {
		timeout: 5_000,
		maxBuffer: 4 * 1024 * 1024,
		encoding: "utf8",
	})).stdout;
	const pids = profileAssociatedProcessPids(processList, await realpath(lane.profileRoot));
	if (pids.length > 0) {
		throw new Error(`ChatGPT Desktop lane ${lane.index} profile is still used by process ${pids.join(", ")}; offline close was refused.`);
	}
}

async function currentFrontmostPid(): Promise<number | undefined> {
	try {
		const { stdout } = await execFileAsync("/usr/bin/osascript", [
			"-e", "tell application \"System Events\" to return unix id of first application process whose frontmost is true",
		], { timeout: 5_000 });
		const pid = Number(stdout.trim());
		return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}

async function minimizeWorkerWindows(pid: number): Promise<void> {
	const script = `tell application \"System Events\" to tell first application process whose unix id is ${pid} to if (count of windows) > 0 then set value of attribute \"AXMinimized\" of every window to true`;
	await execFileAsync("/usr/bin/osascript", ["-e", script], { timeout: 5_000 });
	const { stdout } = await execFileAsync("/usr/bin/osascript", [
		"-e", `tell application \"System Events\" to tell first application process whose unix id is ${pid} to return count of windows`,
	], { timeout: 5_000 });
	const count = Number(stdout.trim());
	if (!Number.isSafeInteger(count) || count < 0) {
		throw new Error(`ChatGPT Desktop worker process ${pid} returned an invalid native-window count.`);
	}
}

async function quietWorkerWindows(pid: number, previousFrontmostPid: number | undefined): Promise<void> {
	await minimizeWorkerWindows(pid);
	const currentPid = await currentFrontmostPid();
	if (previousFrontmostPid && previousFrontmostPid !== pid && currentPid === pid) {
		await restoreFrontmostPid(previousFrontmostPid);
	}
}

async function restoreFrontmostPid(pid: number): Promise<void> {
	if (!processIsAlive(pid)) return;
	await execFileAsync("/usr/bin/osascript", [
		"-e", `tell application \"System Events\" to tell first application process whose unix id is ${pid} to set frontmost to true`,
	], { timeout: 5_000 }).catch(() => undefined);
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return isRecord(error) && error.code !== "ESRCH";
	}
}

function parseInteger(raw: string | undefined, fallback: number, min: number, max: number, label: string): number {
	const value = raw === undefined ? fallback : Number(raw);
	if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${label}; expected ${min}-${max}.`);
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
	return isRecord(error) && error.code === "EEXIST";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function success(result: unknown): DesktopDriverEnvelope {
	return { version: 2, ok: true, result };
}

function failure(error: string): DesktopDriverEnvelope {
	return { version: 2, ok: false, error };
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function readStdin(): Promise<string> {
	let raw = "";
	process.stdin.setEncoding("utf8");
	for await (const chunk of process.stdin) {
		raw += chunk;
		if (Buffer.byteLength(raw, "utf8") > INPUT_LIMIT) throw new Error("Desktop worker-pool request exceeded 16 MiB.");
	}
	return raw;
}

export async function runDesktopPoolCli(): Promise<void> {
	let request: DesktopDriverRequest;
	try {
		const parsed = JSON.parse(await readStdin()) as unknown;
		if (!isRecord(parsed)) throw new Error("invalid request shape");
		request = parsed as unknown as DesktopDriverRequest;
	} catch (error) {
		process.stdout.write(`${JSON.stringify(failure(`Desktop worker-pool driver received invalid JSON: ${errorMessage(error)}`))}\n`);
		return;
	}
	let response = await handleDesktopPoolRequest(request);
	if (request.action === "probe" && response.ok && isRecord(response.result)) {
		const bundlePath = fileURLToPath(import.meta.url);
		response = {
			...response,
			result: {
				...response.result,
				runtimeExecutable: process.execPath,
				runtimeBundlePath: bundlePath,
				runtimeBundleSha256: createHash("sha256").update(await readFile(bundlePath)).digest("hex"),
			},
		};
	}
	process.stdout.write(`${JSON.stringify(response)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	runDesktopPoolCli().catch((error) => {
		process.stdout.write(`${JSON.stringify(failure(errorMessage(error)))}\n`);
		process.exitCode = 1;
	});
}
