import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import {
	STORAGE_VERSION,
	nowIso,
	type ConversationRecord,
	type RunRecord,
} from "./domain";
const ProviderSchema = z.enum(["chrome_bridge", "oracle_browser", "oracle_api"]);
const RunStatusSchema = z.enum(["queued", "running", "completed", "failed", "cancelled", "needs_user"]);
const AttachmentSchema = z.object({ path: z.string(), relativePath: z.string(), size: z.number(), sha256: z.string() });
const ManifestSchema = z.object({ workspaceRoot: z.string(), files: z.array(AttachmentSchema), totalBytes: z.number(), sha256: z.string() });
const ReceiptSchema = z.object({
	provider: ProviderSchema,
	model: z.string().optional(),
	transportVersion: z.string().optional(),
	promptSha256: z.string(),
	attachments: z.array(AttachmentSchema),
	resultSha256: z.string().optional(),
	startedAt: z.string(),
	completedAt: z.string().optional(),
	conversationId: z.string(),
	runId: z.string(),
	providerConversationId: z.string().optional(),
	providerRunId: z.string().optional(),
});
const ConversationSchema = z.object({
	version: z.literal(STORAGE_VERSION),
	id: z.string().startsWith("conv_"),
	provider: ProviderSchema,
	providerConversationId: z.string().optional(),
	bridgeSessionId: z.string().optional(),
	bridgeTabId: z.number().optional(),
	workspaceRoot: z.string(),
	createdAt: z.string(),
	updatedAt: z.string(),
	closedAt: z.string().optional(),
});
const RunSchema = z.object({
	version: z.literal(STORAGE_VERSION),
	id: z.string().startsWith("run_"),
	conversationId: z.string().startsWith("conv_"),
	kind: z.enum(["consult", "chat", "image"]),
	status: RunStatusSchema,
	promptSha256: z.string(),
	attachmentManifest: ManifestSchema,
	baselineMessageCount: z.number().optional(),
	providerRunId: z.string().optional(),
	resultMessageId: z.string().optional(),
	resultText: z.string().optional(),
	result: z.unknown().optional(),
	artifactUrls: z.array(z.string()).optional(),
	artifactPaths: z.array(z.string()).optional(),
	receipt: ReceiptSchema,
	error: z.string().optional(),
	createdAt: z.string(),
	updatedAt: z.string(),
	completedAt: z.string().optional(),
});

export function storageRoot(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(env.GPT_CONTROL_HOME ?? resolve(homedir(), ".gpt-control"));
}

export class RunStore {
	readonly root: string;

	constructor(root = storageRoot()) {
		this.root = root;
	}

	private conversationPath(id: string): string {
		return resolve(this.root, "conversations", `${id}.json`);
	}

	private runPath(id: string): string {
		return resolve(this.root, "runs", `${id}.json`);
	}

	async init(): Promise<void> {
		await Promise.all([
			mkdir(resolve(this.root, "conversations"), { recursive: true }),
			mkdir(resolve(this.root, "runs"), { recursive: true }),
			mkdir(resolve(this.root, "locks"), { recursive: true }),
		]);
	}

	async getConversation(id: string): Promise<ConversationRecord> {
		return ConversationSchema.parse(JSON.parse(await readFile(this.conversationPath(id), "utf8"))) as ConversationRecord;
	}

	async putConversation(record: ConversationRecord): Promise<void> {
		ConversationSchema.parse(record);
		await atomicWrite(this.conversationPath(record.id), record);
	}

	async updateConversation(id: string, update: Partial<ConversationRecord>): Promise<ConversationRecord> {
		const next = { ...(await this.getConversation(id)), ...update, id, updatedAt: nowIso() };
		await this.putConversation(next);
		return next;
	}

	async getRun(id: string): Promise<RunRecord> {
		return RunSchema.parse(JSON.parse(await readFile(this.runPath(id), "utf8"))) as RunRecord;
	}

	async putRun(record: RunRecord): Promise<void> {
		RunSchema.parse(record);
		await atomicWrite(this.runPath(record.id), record);
	}

	async updateRun(id: string, update: Partial<RunRecord>): Promise<RunRecord> {
		const next = { ...(await this.getRun(id)), ...update, id, updatedAt: nowIso() };
		await this.putRun(next);
		return next;
	}

	async withConversationLock<T>(conversationId: string, work: () => Promise<T>, timeoutMs = 30_000): Promise<T> {
		await this.init();
		const lock = resolve(this.root, "locks", `${conversationId}.lock`);
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			try {
				await mkdir(lock);
				break;
			} catch (error) {
				if (!isAlreadyExists(error)) throw error;
				try {
					const age = Date.now() - (await stat(lock)).mtimeMs;
					if (age > 10 * 60_000) {
						await rm(lock, { recursive: true, force: true });
						continue;
					}
				} catch {}
				if (Date.now() >= deadline) throw new Error(`Conversation ${conversationId} already has a run in progress.`);
				await new Promise((done) => setTimeout(done, 100));
			}
		}
		try {
			return await work();
		} finally {
			await rm(lock, { recursive: true, force: true });
		}
	}
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const scratch = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(scratch, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	await rename(scratch, path);
}

function isAlreadyExists(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "EEXIST";
}
