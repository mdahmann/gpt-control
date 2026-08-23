#!/usr/bin/env node
import { randomInt, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const driver = resolve(process.env.GPT_CONTROL_BROWSER_DRIVER ?? resolve(root, "bin/gpt-control-desktop-driver"));
const live = process.argv.includes("--live");
const archiveUrl = option("--archive-url");
const concurrency = Number(option("--concurrency") ?? 1);
const model = option("--model");
const effort = option("--effort");
const renameTitle = option("--rename");
const project = option("--project");
const uploadPath = option("--upload");
const discoverModels = process.argv.includes("--discover-models");
const discoverProjects = process.argv.includes("--discover-projects");
const exerciseReload = process.argv.includes("--reload");
const exerciseCancellation = process.argv.includes("--cancel");
const pin = process.argv.includes("--pin");
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 6) throw new Error("--concurrency must be an integer from 1 through 6.");
const advancedExercise = Boolean(model || effort || renameTitle || project || uploadPath || discoverModels || discoverProjects || exerciseReload || exerciseCancellation || pin);
if (concurrency > 1 && advancedExercise) throw new Error("Model, organization, upload, reload, and cancellation acceptance must use one exact session.");
if (exerciseReload && exerciseCancellation) throw new Error("Run --reload and --cancel as separate exact-session acceptance tests.");
await access(driver);
if (uploadPath) await access(resolve(uploadPath));

const probe = await call("probe", {});
const endpoint = process.env.GPT_CONTROL_DRIVER_DESKTOP_CDP_ENDPOINT ?? "http://127.0.0.1:9236";
const targetsResponse = await fetch(new URL("/json/list", endpoint), { signal: AbortSignal.timeout(5_000) });
if (!targetsResponse.ok) throw new Error(`CDP target list returned HTTP ${targetsResponse.status}.`);
const targets = await targetsResponse.json();
const diagnostic = {
	probe,
	endpoint,
	targets: Array.isArray(targets) ? targets.map((target) => ({ id: target.id, type: target.type, title: target.title, url: target.url })) : [],
	liveMutationAuthorized: process.env.GPT_CONTROL_DESKTOP_LIVE_MUTATION === "1",
};

if (archiveUrl) {
	if (process.env.GPT_CONTROL_DESKTOP_LIVE_MUTATION !== "1") {
		throw new Error("Archive mutation is disabled. Set GPT_CONTROL_DESKTOP_LIVE_MUTATION=1 for this exact cleanup.");
	}
	let session;
	try {
		session = await call("create", { name: `gpt-control:desktop-cleanup:${randomUUID()}`, url: archiveUrl });
		const result = await call("manage_conversation", { session, operation: { action: "archive" } });
		console.log(JSON.stringify({ mode: "archive", url: archiveUrl, ...result }, null, 2));
	} finally {
		if (session) await call("close", { sessionId: session.sessionId }).catch(() => undefined);
	}
	process.exit(0);
}

if (!live) {
	console.log(JSON.stringify({ mode: "diagnostic", ...diagnostic }, null, 2));
	process.exit(0);
}
if (process.env.GPT_CONTROL_DESKTOP_LIVE_MUTATION !== "1") {
	throw new Error("Live mutation is disabled. Set GPT_CONTROL_DESKTOP_LIVE_MUTATION=1 for this exact disposable test.");
}
if (concurrency > 1 && process.env.GPT_CONTROL_DRIVER_DESKTOP_ALLOW_CREATE_TARGET !== "1") {
	throw new Error("Concurrent live mutation requires GPT_CONTROL_DRIVER_DESKTOP_ALLOW_CREATE_TARGET=1.");
}

const sessions = [];
const archivedSessionIds = new Set();
const cleanupUrls = new Map();
const questions = [
	"When would you use CSS Grid instead of Flexbox?",
	"What makes a website feel fast to a visitor?",
	"What's one simple way to improve a form's accessibility?",
	"How do you decide what belongs in a React component?",
	"What is a good use case for a container query?",
	"Why is semantic HTML useful?",
];
const questionOffset = randomInt(questions.length);
try {
	for (let index = 0; index < concurrency; index += 1) {
		const session = await call("create", { name: `gpt-control:desktop-smoke:${randomUUID()}`, url: "https://chatgpt.com/" });
		sessions.push(session);
	}
	const pageIds = new Set(sessions.map((session) => String(session.pageId)));
	if (pageIds.size !== sessions.length) throw new Error("Desktop smoke sessions do not own distinct renderer/page identities.");
	const runs = sessions.map(async (session, index) => {
		const prompt = exerciseCancellation
			? "Could you compare server-side rendering, static generation, incremental regeneration, and client rendering for a large web application, including tradeoffs and several practical examples?"
			: uploadPath
			? "Could you review the attached web-development note and suggest one practical improvement?"
			: questions[(questionOffset + index) % questions.length];
		const initial = await waitReady(session);
		const receipts = {};
		if (discoverModels) receipts.modelCatalog = await call("discover_models", { session });
		if (discoverProjects) receipts.projectCatalog = await call("discover_projects", { session });
		const selection = model || effort ? { ...(model ? { model } : {}), ...(effort ? { effort } : {}) } : undefined;
		if (selection) receipts.selectedModel = await call("select_model", { session, model: selection });
		if (uploadPath) {
			await call("upload", { session, files: [resolve(uploadPath)] });
			receipts.uploaded = true;
		}
		await call("fill", { session, prompt });
		if (selection) receipts.preSendModel = await call("verify_model", { session, model: selection });
		await call("send", { session });
		if (exerciseCancellation) {
			await sleep(250);
			const current = await call("show", { sessionId: session.sessionId });
			await call("recover", { session: current, action: "stop" });
			receipts.cancelled = await waitStopped(current);
		} else {
			const completion = await waitCompletion(session, initial.snapshot?.count ?? 0);
			receipts.response = completion.snapshot.text;
			if (exerciseReload) {
				const beforeReload = await call("show", { sessionId: session.sessionId });
				await call("recover", { session: beforeReload, action: "reload" });
				const recovered = await waitRecovered(session.sessionId, beforeReload.url);
				const followUp = "Could you give one brief example?";
				const beforeFollowUp = await call("observe", { session: recovered });
				await call("fill", { session: recovered, prompt: followUp });
				if (selection) receipts.postReloadModel = await call("verify_model", { session: recovered, model: selection });
				await call("send", { session: recovered });
				const continued = await waitCompletion(recovered, beforeFollowUp.snapshot?.count ?? 0);
				receipts.recoveredUrl = recovered.url;
				receipts.continuation = continued.snapshot.text;
			}
		}
		let currentSession = await call("show", { sessionId: session.sessionId });
		cleanupUrls.set(session.sessionId, currentSession.url);
		if (concurrency > 1) {
			return { sessionId: session.sessionId, pageId: session.pageId, ...receipts, archived: false };
		}
		if (pin) {
			receipts.pin = await call("manage_conversation", { session: currentSession, operation: { action: "pin" } });
			currentSession = await call("show", { sessionId: session.sessionId });
		}
		if (renameTitle) {
			receipts.rename = await call("manage_conversation", { session: currentSession, operation: { action: "rename", title: renameTitle } });
			currentSession = await call("show", { sessionId: session.sessionId });
		}
		if (project) {
			try {
				receipts.move = await call("manage_conversation", { session: currentSession, operation: { action: "move", project } });
			} catch (error) {
				throw new Error(`Desktop live project move failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			currentSession = await call("show", { sessionId: session.sessionId });
		}
		try {
			receipts.archive = await call("manage_conversation", { session: currentSession, operation: { action: "archive" } });
		} catch (error) {
			throw new Error(`Desktop live archive cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		archivedSessionIds.add(session.sessionId);
		return { sessionId: session.sessionId, pageId: session.pageId, ...receipts, archived: true };
	});
	const results = await Promise.all(runs);
	if (concurrency > 1) {
		for (const result of results) {
			let current = await call("show", { sessionId: result.sessionId });
			try {
				result.archive = await call("manage_conversation", { session: current, operation: { action: "archive" } });
			} catch {
				await call("recover", { session: current, action: "reload" });
				current = await waitRecovered(result.sessionId, current.url);
				result.archive = await call("manage_conversation", { session: current, operation: { action: "archive" } });
			}
			result.archived = true;
			archivedSessionIds.add(result.sessionId);
		}
	}
	console.log(JSON.stringify({ mode: "live", concurrency, distinctPageIds: pageIds.size, results }, null, 2));
} finally {
	await Promise.all(sessions.filter((session) => !archivedSessionIds.has(session.sessionId)).map(async (session) => {
		try {
			let current = await call("show", { sessionId: session.sessionId });
			if (/^https:\/\/chatgpt\.com\/c\//.test(current.url)) {
				try {
					await call("manage_conversation", { session: current, operation: { action: "archive" } });
				} catch {
					await call("recover", { session: current, action: "reload" });
					current = await waitRecovered(session.sessionId, current.url);
					await call("manage_conversation", { session: current, operation: { action: "archive" } });
				}
			}
		} catch {}
	}));
	await Promise.all(sessions.map((session) => call("close", { sessionId: session.sessionId }).catch(() => undefined)));
	for (const session of sessions.filter((candidate) => !archivedSessionIds.has(candidate.sessionId))) {
		const url = cleanupUrls.get(session.sessionId);
		if (!url || !/^https:\/\/chatgpt\.com\/c\//.test(url)) continue;
		let cleanup;
		try {
			cleanup = await call("create", { name: `gpt-control:desktop-cleanup:${randomUUID()}`, url });
			await call("manage_conversation", { session: cleanup, operation: { action: "archive" } });
			archivedSessionIds.add(session.sessionId);
		} catch {} finally {
			if (cleanup) await call("close", { sessionId: cleanup.sessionId }).catch(() => undefined);
		}
	}
}

async function waitReady(session) {
	const deadline = Date.now() + 60_000;
	let last;
	while (Date.now() < deadline) {
		last = await call("observe", { session });
		if (last.composerReady) return last;
		await sleep(500);
	}
	throw new Error(`Desktop composer did not become ready: ${last?.stateSummary ?? "no observation"}`);
}

async function waitCompletion(session, baseline) {
	const deadline = Date.now() + 180_000;
	let last;
	let stable = 0;
	while (Date.now() < deadline) {
		last = await call("observe", { session });
		const final = last.snapshot?.count > baseline
			&& (last.snapshot?.text ?? "").trim().length >= 10
			&& !last.answering
			&& !last.thinking
			&& !last.toolRunning;
		stable = final ? stable + 1 : 0;
		if (stable >= 2) return last;
		await sleep(750);
	}
	throw new Error(`Desktop assistant turn did not complete exactly: ${last?.stateSummary ?? "no observation"}`);
}

async function waitStopped(session) {
	const deadline = Date.now() + 30_000;
	let last;
	let stable = 0;
	while (Date.now() < deadline) {
		last = await call("observe", { session });
		const stopped = !last.answering && !last.thinking && !last.toolRunning;
		stable = stopped ? stable + 1 : 0;
		if (stable >= 2) return { stopped: true, stateSummary: last.stateSummary };
		await sleep(250);
	}
	throw new Error(`Desktop turn did not stop: ${last?.stateSummary ?? "no observation"}`);
}

async function waitRecovered(sessionId, exactUrl) {
	const deadline = Date.now() + 60_000;
	let lastError;
	while (Date.now() < deadline) {
		try {
			const session = await call("show", { sessionId });
			if (session.url !== exactUrl) throw new Error(`recovered URL changed from ${exactUrl} to ${session.url}`);
			const observed = await call("observe", { session });
			if (observed.composerReady) return session;
		} catch (error) {
			lastError = error;
		}
		await sleep(250);
	}
	throw new Error(`Desktop exact-conversation reload did not recover: ${lastError instanceof Error ? lastError.message : String(lastError ?? "unknown")}`);
}

async function call(action, params) {
	const request = JSON.stringify({ version: 2, action, params });
	return new Promise((resolveCall, rejectCall) => {
		const child = spawn(driver, [], { cwd: root, stdio: ["pipe", "pipe", "pipe"], env: process.env });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => child.kill("SIGTERM"), 120_000);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("error", rejectCall);
		child.on("exit", () => {
			clearTimeout(timer);
			let envelope;
			try { envelope = JSON.parse(stdout.trim()); } catch { rejectCall(new Error(stderr.trim() || `Desktop driver returned invalid JSON: ${stdout.slice(0, 400)}`)); return; }
			if (!envelope.ok) { rejectCall(new Error(`Desktop driver ${action} failed: ${envelope.error || stderr.trim() || "unknown error"}`)); return; }
			resolveCall(envelope.result);
		});
		child.stdin.end(request);
	});
}

function sleep(ms) {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function option(name) {
	const index = process.argv.indexOf(name);
	if (index < 0) return undefined;
	const value = process.argv[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
	return value;
}
