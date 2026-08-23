#!/usr/bin/env node
import { randomInt, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const driver = resolve(process.env.GPT_CONTROL_BROWSER_DRIVER ?? resolve(root, "bin/gpt-control-desktop-driver"));
const live = process.argv.includes("--live");
const archiveIndex = process.argv.indexOf("--archive-url");
const archiveUrl = archiveIndex >= 0 ? process.argv[archiveIndex + 1] : undefined;
const concurrencyIndex = process.argv.indexOf("--concurrency");
const concurrency = concurrencyIndex >= 0 ? Number(process.argv[concurrencyIndex + 1]) : 1;
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 6) throw new Error("--concurrency must be an integer from 1 through 6.");
await access(driver);

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
		const prompt = questions[(questionOffset + index) % questions.length];
		const initial = await waitReady(session);
		await call("fill", { session, prompt });
		await call("send", { session });
		const completion = await waitCompletion(session, initial.snapshot?.count ?? 0);
		const currentSession = await call("show", { sessionId: session.sessionId });
		await call("manage_conversation", { session: currentSession, operation: { action: "archive" } });
		return { sessionId: session.sessionId, pageId: session.pageId, response: completion.snapshot.text, archived: true };
	});
	const results = await Promise.all(runs);
	console.log(JSON.stringify({ mode: "live", concurrency, distinctPageIds: pageIds.size, results }, null, 2));
} finally {
	await Promise.all(sessions.map((session) => call("close", { sessionId: session.sessionId }).catch(() => undefined)));
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
