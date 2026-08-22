#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const driver = resolve(process.env.GPT_CONTROL_BROWSER_DRIVER ?? resolve(root, "bin/gpt-control-desktop-driver"));
const live = process.argv.includes("--live");
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
try {
	for (let index = 0; index < concurrency; index += 1) {
		const session = await call("create", { name: `gpt-control:desktop-smoke:${randomUUID()}`, url: "https://chatgpt.com/" });
		sessions.push(session);
	}
	const pageIds = new Set(sessions.map((session) => String(session.pageId)));
	if (pageIds.size !== sessions.length) throw new Error("Desktop smoke sessions do not own distinct renderer/page identities.");
	const runs = sessions.map(async (session, index) => {
		const token = `DESKTOP_CDP_PONG_${index + 1}_${randomUUID().replaceAll("-", "")}`;
		const prompt = `Reply with exactly ${token} and no other text.`;
		const initial = await waitReady(session);
		await call("fill", { session, prompt });
		await call("send", { session });
		const completion = await waitCompletion(session, initial.snapshot?.count ?? 0, token);
		return { sessionId: session.sessionId, pageId: session.pageId, token, response: completion.snapshot.text };
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

async function waitCompletion(session, baseline, token) {
	const deadline = Date.now() + 180_000;
	let last;
	let stable = 0;
	while (Date.now() < deadline) {
		last = await call("observe", { session });
		const final = last.snapshot?.count > baseline
			&& last.snapshot?.text === token
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
			if (!envelope.ok) { rejectCall(new Error(envelope.error || stderr.trim() || `Desktop driver ${action} failed.`)); return; }
			resolveCall(envelope.result);
		});
		child.stdin.end(request);
	});
}

function sleep(ms) {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
