#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
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

interface ActiveLaneStartup {
	lane: PoolLane;
	config: PoolConfig;
	env: NodeJS.ProcessEnv;
	token: string;
	identity: FileIdentity;
	interrupted: boolean;
	endpointObserved: boolean;
}

interface LaneLaunchReceipt {
	version: 1;
	token: string;
	lane: number;
	port: number;
	profileSha256: string;
	state: string;
	[key: string]: unknown;
}

let activeLaneStartup: ActiveLaneStartup | undefined;

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

interface FileIdentity {
	dev: number;
	ino: number;
}

interface PoolLockLease {
	root: string;
	owner: PoolLockOwner;
	identity: FileIdentity;
}

export interface PoolLockTestHooks {
	afterPublish?: (lockRoot: string) => Promise<void>;
}

class PoolLockBusyError extends Error {}

class LanePreflightError extends Error {}

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
	return action === "attest_active" || action === "attest_offline";
}

export function poolAllowsCreateTarget(env: NodeJS.ProcessEnv): boolean {
	return env.GPT_CONTROL_DRIVER_DESKTOP_ALLOW_CREATE_TARGET === "1";
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
		if (request.action === "attest_active" || request.action === "attest_offline") {
			return success(await attestPoolState(config, lanes, env, request.action === "attest_offline"));
		}
		if (request.action === "create") {
			return await createInReservedLane(request, config, lanes, env);
		}
		if (request.action === "find_conversations") {
			return await findConversationsInRunningLane(lanes, config, request, env);
		}
		const sessionId = requestSessionId(request);
		if (!sessionId) throw new Error(`Desktop worker-pool action ${request.action} requires an exact session id.`);
		const lane = await exactSessionLane(lanes, sessionId);
		return await withLaneLifecycleLock(lane, async () => {
			const rebound = await exactSessionLane(lanes, sessionId);
			if (rebound.index !== lane.index) throw new Error(`Desktop worker-pool session ${sessionId} changed lanes before action ${request.action}.`);
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
			return addPoolLaneReceipt(response, lane.index);
		});
	} catch (error) {
		return failure(errorMessage(error));
	}
}

async function createInReservedLane(
	request: DesktopDriverRequest,
	config: PoolConfig,
	lanes: PoolLane[],
	env: NodeJS.ProcessEnv,
): Promise<DesktopDriverEnvelope> {
	const excluded = new Set<number>();
	const blockers: string[] = [];
	while (excluded.size < lanes.length) {
		const reservation = await reserveFreeLane(config, lanes, excluded);
		if (!reservation) break;
		const { lane, lease } = reservation;
		let released = false;
		const release = async () => {
			if (released) return;
			await releasePoolLock(lease);
			released = true;
		};
		try {
			await assertLanePrelaunchSafe(lane, config, env);
		} catch (error) {
			await release();
			excluded.add(lane.index);
			blockers.push(`lane ${lane.index}: ${errorMessage(error)}`);
			continue;
		}
		try {
			await ensureLaneReady(lane, config, env);
		} catch (error) {
			try {
				await proveLaneRetrySafe(lane, config, env);
			} catch (cleanupError) {
				await release();
				throw new Error(`ChatGPT Desktop lane ${lane.index} readiness failed and retry cleanup was not proved: ${errorMessage(error)}; ${errorMessage(cleanupError)}`);
			}
			await release();
			excluded.add(lane.index);
			blockers.push(`lane ${lane.index}: readiness failed after safe cleanup: ${errorMessage(error)}`);
			continue;
		}
		try {
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
			return await completeReservedLaneResponse(response, lane.index, release);
		} catch (error) {
			const retainedSessionIds = await laneSessionIds(lane).catch(() => []);
			let cleanupError: unknown;
			try {
				if (await endpointAlive(lane.endpoint)) await stopLane(lane, config, env);
				else await assertLaneIsOffline(lane);
				for (const retainedSessionId of retainedSessionIds) {
					await closeDesktopDriverSessionOffline(lane.stateRoot, retainedSessionId);
				}
			} catch (caught) {
				cleanupError = caught;
			}
			return await completeReservedLaneResponse(failure(
				`${errorMessage(error)}${cleanupError ? ` Cleanup failed: ${errorMessage(cleanupError)}${retainedSessionIds.length > 0 ? ` Retained session IDs: ${retainedSessionIds.join(", ")}.` : ""}` : ""}`,
			), lane.index, release);
		}
	}
	if (blockers.length > 0) {
		throw new Error(`No safe ChatGPT Desktop worker lane was available (${blockers.join("; ")}).`);
	}
	throw new Error(`ChatGPT Desktop worker pool is at capacity (${config.size} lanes).`);
}

export async function completeReservedLaneResponse(
	response: DesktopDriverEnvelope,
	laneIndex: number,
	release: () => Promise<void>,
): Promise<DesktopDriverEnvelope> {
	const owned = addPoolLaneReceipt(response, laneIndex);
	try {
		await release();
		return owned;
	} catch (error) {
		if (owned.ok && isRecord(owned.result)
			&& typeof owned.result.sessionId === "string"
			&& (typeof owned.result.pageId === "string" || typeof owned.result.pageId === "number")
			&& typeof owned.result.name === "string" && typeof owned.result.url === "string") {
			return success({ ...owned.result, desktopPoolLeaseState: "release_unproved" });
		}
		return failure(`${owned.error ?? "Desktop lane operation failed."} Lifecycle-lock release was not proved: ${errorMessage(error)}`);
	}
}

export async function provePoolLaneRetryBoundary(
	laneIndex: number,
	sessionIds: string[],
	endpointOnline: boolean,
	stop: () => Promise<void>,
	assertOffline: () => Promise<void>,
): Promise<void> {
	if (sessionIds.length > 0) throw new Error(`ChatGPT Desktop lane ${laneIndex} durable sessions remain: ${sessionIds.join(", ")}`);
	if (endpointOnline) await stop();
	await assertOffline();
}

async function proveLaneRetrySafe(lane: PoolLane, config: PoolConfig, env: NodeJS.ProcessEnv): Promise<void> {
	const sessions = await laneSessionIds(lane);
	await provePoolLaneRetryBoundary(
		lane.index,
		sessions,
		await endpointAlive(lane.endpoint),
		async () => stopLane(lane, config, env),
		async () => assertLaneIsOffline(lane),
	);
}

async function attestPoolState(
	config: PoolConfig,
	lanes: PoolLane[],
	env: NodeJS.ProcessEnv,
	requireOffline: boolean,
): Promise<Record<string, unknown>> {
	return withPoolAllocationLock(config.root, async () => withAllLaneLifecycleLocks(lanes, async () => {
		const receipts: Array<Record<string, unknown>> = [];
		for (const lane of lanes) {
			await secureDirectory(lane.profileRoot);
			await secureDirectory(lane.stateRoot);
			const sessionIds = await laneSessionIds(lane);
			const online = await endpointAlive(lane.endpoint);
			if (requireOffline) {
				if (sessionIds.length > 0) {
					throw new Error(`ChatGPT Desktop lane ${lane.index} retained durable sessions: ${sessionIds.join(", ")}.`);
				}
				await assertLaneIsOffline(lane);
				receipts.push({
					lane: lane.index,
					port: lane.port,
					profileSha256: sha256(resolve(lane.profileRoot)),
					sessionIds: [],
					state: "offline",
				});
				continue;
			}
			if (sessionIds.length > 0 && !online) {
				throw new Error(`ChatGPT Desktop lane ${lane.index} has durable sessions without an exact live endpoint.`);
			}
			if (!online) {
				receipts.push({
					lane: lane.index,
					port: lane.port,
					profileSha256: sha256(resolve(lane.profileRoot)),
					sessionIds,
					state: "offline",
				});
				continue;
			}
			const host = await laneEnvironment(lane, config, env).verifyHost();
			receipts.push({
				lane: lane.index,
				port: lane.port,
				profileSha256: sha256(resolve(lane.profileRoot)),
				sessionIds,
				state: "active",
				listenerPid: host.listenerPid,
				browserInstanceId: host.browserInstanceId,
				bundleId: host.bundleId,
				teamId: host.teamId,
			});
		}
		return {
			driver: POOL_DRIVER_ID,
			mode: requireOffline ? "offline" : "active",
			poolRootSha256: sha256(config.root),
			lanes: receipts,
			attestedAt: new Date().toISOString(),
		};
	}));
}

async function withAllLaneLifecycleLocks<T>(lanes: PoolLane[], work: () => Promise<T>): Promise<T> {
	const leases: PoolLockLease[] = [];
	try {
		for (const lane of lanes) {
			await secureDirectory(dirname(lane.profileRoot));
			leases.push(await acquirePoolLock(
				join(dirname(lane.profileRoot), "lifecycle.lock"),
				Date.now() + 30_000,
				`ChatGPT Desktop lane ${lane.index} lifecycle attestation`,
			));
		}
		return await work();
	} finally {
		const failures: string[] = [];
		for (const lease of [...leases].reverse()) {
			try {
				await releasePoolLock(lease);
			} catch (error) {
				failures.push(errorMessage(error));
			}
		}
		if (failures.length > 0) throw new Error(`Pool attestation lifecycle-lock release failed: ${failures.join("; ")}`);
	}
}

async function assertLanePrelaunchSafe(lane: PoolLane, config: PoolConfig, env: NodeJS.ProcessEnv): Promise<void> {
	await secureDirectory(dirname(lane.profileRoot));
	await secureDirectory(lane.profileRoot);
	await secureDirectory(lane.stateRoot);
	await assertNoRetainedLaunch(lane);
	const sessions = await laneSessionIds(lane);
	if (sessions.length > 0) throw new LanePreflightError(`durable sessions appeared before launch: ${sessions.join(", ")}`);
	if (await endpointAlive(lane.endpoint)) {
		try {
			await laneEnvironment(lane, config, env).verifyHost();
			return;
		} catch (error) {
			throw new LanePreflightError(`existing listener is not the exact signed lane: ${errorMessage(error)}`);
		}
	}
	try {
		await assertLaneIsOffline(lane);
	} catch (error) {
		throw new LanePreflightError(errorMessage(error));
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

async function reserveFreeLane(
	config: PoolConfig,
	lanes: PoolLane[],
	excluded: ReadonlySet<number>,
): Promise<{ lane: PoolLane; lease: PoolLockLease } | undefined> {
	return withPoolAllocationLock(config.root, async () => {
		const cursor = await readAllocationCursor(config.root, config.size);
		const ordered = roundRobinLaneOrder(lanes, cursor);
		for (const lane of ordered) {
			if (excluded.has(lane.index) || (await laneSessionIds(lane)).length > 0) continue;
			const lockRoot = join(dirname(lane.profileRoot), "lifecycle.lock");
			let lease: PoolLockLease;
			try {
				lease = await acquirePoolLock(lockRoot, Date.now(), `ChatGPT Desktop lane ${lane.index} lifecycle`);
			} catch (error) {
				if (error instanceof PoolLockBusyError) continue;
				throw error;
			}
			try {
				await writeAllocationCursor(config.root, lane.index === config.size ? 1 : lane.index + 1);
				return { lane, lease };
			} catch (error) {
				await releasePoolLock(lease);
				throw error;
			}
		}
		return undefined;
	});
}

export async function withReservedFreePoolLane<T>(
	config: PoolConfig,
	lanes: PoolLane[],
	work: (lane: PoolLane) => Promise<T>,
): Promise<T> {
	await secureDirectory(config.root);
	const reservation = await reserveFreeLane(config, lanes, new Set());
	if (!reservation) throw new Error(`ChatGPT Desktop worker pool is at capacity (${config.size} lanes).`);
	try {
		return await work(reservation.lane);
	} finally {
		await releasePoolLock(reservation.lease);
	}
}

export function roundRobinLaneOrder<T extends { index: number }>(lanes: readonly T[], cursor: number): T[] {
	if (!Number.isSafeInteger(cursor) || cursor < 1 || cursor > lanes.length) {
		throw new Error("Invalid ChatGPT Desktop worker-pool round-robin cursor.");
	}
	const start = lanes.findIndex((lane) => lane.index === cursor);
	if (start < 0) throw new Error("ChatGPT Desktop worker-pool cursor does not identify a lane.");
	return [...lanes.slice(start), ...lanes.slice(0, start)];
}

async function readAllocationCursor(root: string, size: number): Promise<number> {
	const path = join(root, "allocation-cursor.json");
	try {
		const info = await lstat(path);
		if (info.isSymbolicLink() || !info.isFile()) throw new Error("Unsafe ChatGPT Desktop worker-pool allocation cursor.");
		const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		let raw: string;
		try {
			raw = await handle.readFile("utf8");
		} finally {
			await handle.close();
		}
		const value = JSON.parse(raw) as unknown;
		if (!isRecord(value) || value.version !== 1 || !Number.isSafeInteger(value.nextLane)
			|| Number(value.nextLane) < 1 || Number(value.nextLane) > size) {
			throw new Error("Invalid ChatGPT Desktop worker-pool allocation cursor.");
		}
		return Number(value.nextLane);
	} catch (error) {
		if (isMissing(error)) return 1;
		throw error;
	}
}

async function writeAllocationCursor(root: string, nextLane: number): Promise<void> {
	const path = join(root, "allocation-cursor.json");
	const temporary = `${path}.pending-${randomUUID()}`;
	await writeFile(temporary, `${JSON.stringify({ version: 1, nextLane, updatedAt: new Date().toISOString() })}\n`, {
		mode: 0o600,
		flag: "wx",
	});
	try {
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true }).catch(() => undefined);
	}
}

async function exactSessionLane(lanes: PoolLane[], sessionId: string): Promise<PoolLane> {
	const matches: PoolLane[] = [];
	for (const lane of lanes) {
		if ((await laneSessionIds(lane)).includes(sessionId)) matches.push(lane);
	}
	if (matches.length !== 1) {
		throw new Error(matches.length === 0
			? `Desktop worker-pool session ${sessionId} is not durably bound to a lane.`
			: `Desktop worker-pool session ${sessionId} is ambiguously bound to lanes ${matches.map(({ index }) => index).join(", ")}.`);
	}
	return matches[0];
}

export async function withLaneLifecycleLock<T>(lane: PoolLane, work: () => Promise<T>): Promise<T> {
	await secureDirectory(dirname(lane.profileRoot));
	const lease = await acquirePoolLock(
		join(dirname(lane.profileRoot), "lifecycle.lock"),
		Date.now() + 30_000,
		`ChatGPT Desktop lane ${lane.index} lifecycle`,
	);
	try {
		return await work();
	} finally {
		await releasePoolLock(lease);
	}
}

async function findConversationsInRunningLane(
	lanes: PoolLane[],
	config: PoolConfig,
	request: DesktopDriverRequest,
	env: NodeJS.ProcessEnv,
): Promise<DesktopDriverEnvelope> {
	const blockers: string[] = [];
	for (const lane of lanes) {
		if (!await endpointAlive(lane.endpoint)) continue;
		await secureDirectory(dirname(lane.profileRoot));
		let lease: PoolLockLease;
		try {
			lease = await acquirePoolLock(
				join(dirname(lane.profileRoot), "lifecycle.lock"),
				Date.now(),
				`ChatGPT Desktop lane ${lane.index} discovery`,
			);
		} catch (error) {
			if (error instanceof PoolLockBusyError) continue;
			throw error;
		}
		try {
			if (!await endpointAlive(lane.endpoint)) continue;
			await laneEnvironment(lane, config, env).verifyHost();
			return await invokeLane(lane, config, request, env);
		} catch (error) {
			blockers.push(`lane ${lane.index}: ${errorMessage(error)}`);
		} finally {
			await releasePoolLock(lease);
		}
	}
	throw new Error(blockers.length > 0
		? `Conversation discovery found no usable already-running ChatGPT Desktop lane (${blockers.join("; ")}). No app was launched.`
		: "Conversation discovery requires an already-running unreserved ChatGPT Desktop worker lane. No app was launched.");
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
	await assertLaneIsOffline(lane);
	const interactiveBootstrap = !bootstrapped && config.allowInteractiveBootstrap;
	const frontmostPid = await currentFrontmostPid();
	const startup = await beginLaneStartup(lane, config, env);
	try {
		await execFileAsync("/usr/bin/open", [
			...(!interactiveBootstrap ? ["-g", "-j"] : []), "-n", config.appPath, "--args",
			`--user-data-dir=${lane.profileRoot}`,
			"--remote-debugging-address=127.0.0.1",
			`--remote-debugging-port=${lane.port}`,
		], { timeout: 15_000 });
	} catch (error) {
		if (startup.interrupted) throw error;
		try {
			if (await endpointAlive(lane.endpoint)) {
				startup.endpointObserved = true;
				await stopLane(lane, config, env);
			} else {
				await assertLaneIsOffline(lane);
			}
			await finishLaneStartup(startup);
		} catch (cleanupError) {
			await retainInterruptedLaneStartup(startup, errorMessage(cleanupError)).catch(() => undefined);
			throw new Error(`ChatGPT Desktop lane ${lane.index} launch command failed: ${errorMessage(error)}; cleanup was not proved: ${errorMessage(cleanupError)}`);
		}
		throw error;
	}
	// Keep the complete startup plus proved cleanup below every protocol caller's
	// timeout. Interactive bootstrap remains an explicit operator opt-in.
	const deadline = Date.now() + (interactiveBootstrap ? 60_000 : 30_000);
	let lastError: unknown;
	while (Date.now() < deadline) {
		if (startup.interrupted) throw new Error(`ChatGPT Desktop lane ${lane.index} startup was interrupted; its exact retained launch receipt blocks reuse.`);
		try {
			const host = await environment.verifyHost();
			startup.endpointObserved = true;
			if (!interactiveBootstrap) await quietWorkerWindows(host.listenerPid, frontmostPid);
			if (!laneHasExactlyOneReadyShell(await environment.listTargets())) {
				lastError = new Error(`ChatGPT Desktop lane ${lane.index} has not exposed one ready ChatGPT shell.`);
				await sleep(150);
				continue;
			}
			await quietWorkerWindows(host.listenerPid, frontmostPid);
			await markLaneBootstrapped(lane);
			await finishLaneStartup(startup);
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
	await finishLaneStartup(startup);
	throw new Error(!bootstrapped && !interactiveBootstrap
		? `ChatGPT Desktop lane ${lane.index} could not bootstrap in the background: ${startupError}. Set GPT_CONTROL_DRIVER_DESKTOP_ALLOW_INTERACTIVE_BOOTSTRAP=1 for an authorized one-time visible setup run.`
		: `ChatGPT Desktop lane ${lane.index} did not become ready: ${startupError}`);
}

function laneLaunchReceiptPath(lane: PoolLane): string {
	return join(dirname(lane.profileRoot), "launch.json");
}

export async function assertNoRetainedLaunch(lane: PoolLane): Promise<void> {
	const path = laneLaunchReceiptPath(lane);
	try {
		const { value } = await readLaneLaunchReceipt(path, lane);
		throw new Error(`ChatGPT Desktop lane ${lane.index} has a retained ${value.state} launch receipt. Explicit recovery is required before reuse.`);
	} catch (error) {
		if (isMissing(error)) return;
		throw error;
	}
}

export async function beginLaneStartup(lane: PoolLane, config: PoolConfig, env: NodeJS.ProcessEnv): Promise<ActiveLaneStartup> {
	if (activeLaneStartup) throw new Error("This desktop-pool command already owns a lane startup.");
	const token = randomUUID();
	const path = laneLaunchReceiptPath(lane);
	await writeFile(path, `${JSON.stringify({
		version: 1,
		token,
		lane: lane.index,
		port: lane.port,
		profileSha256: sha256(resolve(lane.profileRoot)),
		state: "launching",
		ownerPid: process.pid,
		startedAt: new Date().toISOString(),
	})}\n`, { mode: 0o600, flag: "wx" });
	const receipt = await readLaneLaunchReceipt(path, lane);
	if (receipt.value.token !== token) throw new Error(`ChatGPT Desktop lane ${lane.index} launch receipt ownership was not published.`);
	const startup: ActiveLaneStartup = {
		lane,
		config,
		env,
		token,
		identity: receipt.identity,
		interrupted: false,
		endpointObserved: false,
	};
	activeLaneStartup = startup;
	return startup;
}

export async function finishLaneStartup(startup: ActiveLaneStartup): Promise<void> {
	const path = laneLaunchReceiptPath(startup.lane);
	const current = await readLaneLaunchReceipt(path, startup.lane);
	if (current.value.token !== startup.token || current.identity.dev !== startup.identity.dev
		|| current.identity.ino !== startup.identity.ino) {
		throw new Error(`ChatGPT Desktop lane ${startup.lane.index} launch receipt ownership changed.`);
	}
	const released = `${path}.released-${startup.token}`;
	await rename(path, released);
	try {
		const moved = await readLaneLaunchReceipt(released, startup.lane);
		if (moved.identity.dev !== current.identity.dev || moved.identity.ino !== current.identity.ino
			|| moved.value.token !== startup.token) {
			throw new Error(`ChatGPT Desktop lane ${startup.lane.index} launch receipt changed during release.`);
		}
		await rm(released);
	} catch (error) {
		await rename(released, path).catch(() => undefined);
		throw error;
	}
	if (activeLaneStartup?.token === startup.token) activeLaneStartup = undefined;
}

export async function retainInterruptedLaneStartup(startup: ActiveLaneStartup, detail: string): Promise<void> {
	const path = laneLaunchReceiptPath(startup.lane);
	const current = await readLaneLaunchReceipt(path, startup.lane);
	if (current.value.token !== startup.token || current.identity.dev !== startup.identity.dev
		|| current.identity.ino !== startup.identity.ino) {
		throw new Error(`ChatGPT Desktop lane ${startup.lane.index} launch receipt ownership changed during interruption.`);
	}
	const temporary = `${path}.pending-${randomUUID()}`;
	await writeFile(temporary, `${JSON.stringify({
		...current.value,
		state: "interrupted_cleanup_unproved",
		detailSha256: sha256(detail),
		interruptedAt: new Date().toISOString(),
	})}\n`, { mode: 0o600, flag: "wx" });
	const old = `${path}.interrupted-${startup.token}`;
	await rename(path, old);
	try {
		const moved = await readLaneLaunchReceipt(old, startup.lane);
		if (moved.identity.dev !== current.identity.dev || moved.identity.ino !== current.identity.ino
			|| moved.value.token !== startup.token) {
			throw new Error(`ChatGPT Desktop lane ${startup.lane.index} launch receipt changed during interruption.`);
		}
		await rename(temporary, path);
		await rm(old);
	} catch (error) {
		await rename(old, path).catch(() => undefined);
		throw error;
	} finally {
		await rm(temporary, { force: true }).catch(() => undefined);
	}
	if (activeLaneStartup?.token === startup.token) activeLaneStartup = undefined;
}

async function readLaneLaunchReceipt(
	path: string,
	lane: PoolLane,
): Promise<{ value: LaneLaunchReceipt; identity: FileIdentity }> {
	const before = await lstat(path);
	if (before.isSymbolicLink() || !before.isFile()) throw new Error(`Refused unsafe ChatGPT Desktop lane ${lane.index} launch receipt.`);
	const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	let raw: string;
	let identity: FileIdentity;
	try {
		const after = await handle.stat();
		if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino) {
			throw new Error(`ChatGPT Desktop lane ${lane.index} launch receipt identity changed before read.`);
		}
		identity = { dev: after.dev, ino: after.ino };
		raw = await handle.readFile("utf8");
	} finally {
		await handle.close();
	}
	const value = JSON.parse(raw) as unknown;
	if (!isRecord(value) || value.version !== 1 || value.lane !== lane.index
		|| value.port !== lane.port || value.profileSha256 !== sha256(resolve(lane.profileRoot))
		|| typeof value.token !== "string" || typeof value.state !== "string") {
		throw new Error(`Invalid ChatGPT Desktop lane ${lane.index} launch receipt.`);
	}
	return { value: value as LaneLaunchReceipt, identity };
}

async function cleanupInterruptedLaneStartup(startup: ActiveLaneStartup): Promise<void> {
	startup.interrupted = true;
	try {
		if (await endpointAlive(startup.lane.endpoint)) startup.endpointObserved = true;
		if (!startup.endpointObserved) {
			await retainInterruptedLaneStartup(startup, "The exact CDP endpoint was not observed before interruption.");
			return;
		}
		await stopLane(startup.lane, startup.config, startup.env);
		await finishLaneStartup(startup);
	} catch (error) {
		await retainInterruptedLaneStartup(startup, errorMessage(error)).catch(() => undefined);
		throw error;
	}
}

async function laneBootstrapComplete(lane: PoolLane): Promise<boolean> {
	const path = join(dirname(lane.profileRoot), "bootstrap.json");
	try {
		const info = await lstat(path);
		if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Refused unsafe ChatGPT Desktop lane ${lane.index} bootstrap receipt.`);
		const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		let raw: string;
		try {
			raw = await handle.readFile("utf8");
		} finally {
			await handle.close();
		}
		const value = JSON.parse(raw) as unknown;
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
	const environment = laneEnvironment(lane, config, env);
	const previousFrontmostPid = await currentFrontmostPid();
	let response: DesktopDriverEnvelope;
	try {
		response = await handleDesktopDriverRequest(request, {
			environment,
			stateRoot: lane.stateRoot,
			allowCreateTarget: poolAllowsCreateTarget(env),
		});
	} catch (error) {
		const host = await environment.verifyHost();
		await quietWorkerWindows(host.listenerPid, previousFrontmostPid);
		throw error;
	}
	try {
		const host = await environment.verifyHost();
		await quietWorkerWindows(host.listenerPid, previousFrontmostPid);
	} catch (quietError) {
		return failure(`${response.ok ? "Desktop driver action completed but native-window containment failed." : response.error ?? "Desktop driver action failed."} ${errorMessage(quietError)}`);
	}
	return response;
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
	const environment = laneEnvironment(lane, config, env);
	const host = await environment.verifyHost();
	await environment.closeBrowser(host.browserInstanceId);
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (!await endpointAlive(lane.endpoint)) {
			try {
				await assertLaneIsOffline(lane);
				return;
			} catch {}
		}
		await sleep(100);
	}
	throw new Error(`ChatGPT Desktop lane ${lane.index} did not stop after its exact CDP Browser.close request. No operating-system signal was sent.`);
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

export async function withPoolAllocationLock<T>(
	root: string,
	work: () => Promise<T>,
	hooks: PoolLockTestHooks = {},
): Promise<T> {
	const lease = await acquirePoolLock(
		join(root, "allocation.lock"),
		Date.now() + 30_000,
		"ChatGPT Desktop worker-pool allocation",
		hooks,
	);
	try {
		return await work();
	} finally {
		await releasePoolLock(lease);
	}
}

async function acquirePoolLock(
	lockRoot: string,
	deadline: number,
	label: string,
	hooks: PoolLockTestHooks = {},
): Promise<PoolLockLease> {
	const owner: PoolLockOwner = {
		version: 1,
		token: randomUUID(),
		pid: process.pid,
		hostname: hostname(),
		processStartId: await localProcessStartId(process.pid),
		startedAt: new Date().toISOString(),
	};
	while (true) {
		const pending = `${lockRoot}.pending-${owner.token}`;
		try {
			await writeFile(pending, `${JSON.stringify(owner)}\n`, { mode: 0o600, flag: "wx" });
			const prepared = await lstat(pending);
			const identity = { dev: prepared.dev, ino: prepared.ino };
			// link(2) is the no-clobber publication primitive. Unlike directory
			// rename, it cannot replace an ownerless empty artifact.
			await link(pending, lockRoot);
			await rm(pending, { force: true });
			await hooks.afterPublish?.(lockRoot);
			await verifyPoolLockOwnership(lockRoot, owner, identity);
			return { root: lockRoot, owner, identity };
		} catch (error) {
			await rm(pending, { recursive: true, force: true }).catch(() => undefined);
			if (!isAlreadyExists(error) && !isDirectoryNotEmpty(error)) throw error;
			if (await recoverPoolLock(lockRoot)) continue;
			if (Date.now() >= deadline) throw new PoolLockBusyError(`Timed out waiting for the ${label} lock.`);
			await sleep(50);
		}
	}
}

async function verifyPoolLockOwnership(lockRoot: string, owner: PoolLockOwner, identity: FileIdentity): Promise<void> {
	const info = await lstat(lockRoot);
	if (info.isSymbolicLink() || !info.isFile() || info.dev !== identity.dev || info.ino !== identity.ino) {
		throw new Error(`ChatGPT Desktop worker-pool lock identity changed before use: ${lockRoot}`);
	}
	const current = await readPoolLockOwner(lockRoot);
	if (current.token !== owner.token) throw new Error(`ChatGPT Desktop worker-pool lock fencing token changed before use: ${lockRoot}`);
}

async function releasePoolLock(lease: PoolLockLease): Promise<void> {
	await verifyPoolLockOwnership(lease.root, lease.owner, lease.identity);
	const released = `${lease.root}.released-${lease.owner.token}`;
	await rename(lease.root, released);
	const info = await lstat(released);
	const owner = await readPoolLockOwner(released);
	if (info.dev !== lease.identity.dev || info.ino !== lease.identity.ino || owner.token !== lease.owner.token) {
		throw new Error(`ChatGPT Desktop worker-pool lock changed during release: ${lease.root}`);
	}
	await rm(released, { recursive: true, force: true });
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

async function recoverPoolLock(lockRoot: string): Promise<boolean> {
	const info = await lstat(lockRoot).catch((error) => {
		if (isMissing(error)) return undefined;
		throw error;
	});
	if (!info) return true;
	if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error(`Refused unsafe worker-pool lock: ${lockRoot}`);
	// Version 0.5.0-alpha.3 used a directory plus owner.json. Read it only for
	// dead-owner migration; new locks are one fully initialized atomic file.
	const ownerPath = info.isDirectory() ? join(lockRoot, "owner.json") : lockRoot;
	let first: PoolLockOwner;
	try {
		first = await readPoolLockOwner(ownerPath);
	} catch (error) {
		throw new Error(`Refused ownerless or invalid worker-pool lock: ${lockRoot}: ${errorMessage(error)}`);
	}
	if (await poolLockOwnerIsAlive(first)) return false;
	const secondInfo = await lstat(lockRoot);
	const second = await readPoolLockOwner(ownerPath);
	if (info.dev !== secondInfo.dev || info.ino !== secondInfo.ino || first.token !== second.token) return false;
	if (await poolLockOwnerIsAlive(second)) return false;
	const stale = `${lockRoot}.stale-${randomUUID()}`;
	try {
		await rename(lockRoot, stale);
		const staleInfo = await lstat(stale);
		const staleOwner = await readPoolLockOwner(staleInfo.isDirectory() ? join(stale, "owner.json") : stale);
		if (staleInfo.dev !== info.dev || staleInfo.ino !== info.ino || staleOwner.token !== first.token) {
			throw new Error(`Worker-pool lock changed during dead-owner recovery: ${lockRoot}`);
		}
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
	const { stdout } = await execFileAsync("/usr/bin/osascript", [
		"-e", `tell application \"System Events\"
set workerProcess to first application process whose unix id is ${pid}
set unminimizedCount to 0
repeat with workerWindow in windows of workerProcess
	try
		set value of attribute \"AXMinimized\" of workerWindow to true
	end try
	try
		if value of attribute \"AXMinimized\" of workerWindow is not true then set unminimizedCount to unminimizedCount + 1
	on error
		set unminimizedCount to unminimizedCount + 1
	end try
end repeat
return (count of windows of workerProcess as text) & \",\" & (unminimizedCount as text)
end tell`,
	], { timeout: 5_000 });
	assertMinimizedWindowReceipt(pid, stdout);
}

export function assertMinimizedWindowReceipt(pid: number, raw: string): void {
	const match = /^(\d+),(\d+)$/.exec(raw.trim());
	if (!match) throw new Error(`ChatGPT Desktop worker process ${pid} returned an invalid native-window receipt.`);
	const windowCount = Number(match[1]);
	const unminimizedCount = Number(match[2]);
	if (!Number.isSafeInteger(windowCount) || !Number.isSafeInteger(unminimizedCount) || unminimizedCount !== 0) {
		throw new Error(`ChatGPT Desktop worker process ${pid} retained ${unminimizedCount} of ${windowCount} unminimized windows.`);
	}
}

async function quietWorkerWindows(pid: number, previousFrontmostPid: number | undefined): Promise<void> {
	await minimizeWorkerWindows(pid);
	const currentPid = await currentFrontmostPid();
	if (previousFrontmostPid && previousFrontmostPid !== pid && currentPid === pid) {
		await restoreFrontmostPid(previousFrontmostPid);
	}
	const finalPid = await currentFrontmostPid();
	if (!finalPid) throw new Error("Could not verify the frontmost macOS application after desktop-worker containment.");
	if (finalPid === pid) throw new Error(`ChatGPT Desktop worker process ${pid} remained frontmost.`);
	await minimizeWorkerWindows(pid);
}

async function restoreFrontmostPid(pid: number): Promise<void> {
	if (!processIsAlive(pid)) return;
	await execFileAsync("/usr/bin/osascript", [
		"-e", `tell application \"System Events\" to tell first application process whose unix id is ${pid} to set frontmost to true`,
	], { timeout: 5_000 });
	const observed = await currentFrontmostPid();
	assertRestoredFrontmostPid(pid, observed);
}

export function assertRestoredFrontmostPid(expectedPid: number, observedPid: number | undefined): void {
	if (observedPid !== expectedPid) throw new Error(`Could not restore frontmost macOS application process ${expectedPid}.`);
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

function isDirectoryNotEmpty(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOTEMPTY";
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
	let terminating = false;
	const processSignals = process as unknown as {
		once(event: string, listener: () => void): void;
		off(event: string, listener: () => void): void;
	};
	const terminate = () => {
		if (terminating) return;
		terminating = true;
		void (async () => {
			if (activeLaneStartup) await cleanupInterruptedLaneStartup(activeLaneStartup);
		})().finally(() => process.exit(143));
	};
	processSignals.once("SIGTERM", terminate);
	processSignals.once("SIGINT", terminate);
	let response: DesktopDriverEnvelope;
	try {
		response = await handleDesktopPoolRequest(request);
	} finally {
		processSignals.off("SIGTERM", terminate);
		processSignals.off("SIGINT", terminate);
	}
	if (terminating) return;
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
