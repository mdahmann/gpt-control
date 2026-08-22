import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdtemp, open, readFile, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { AttachmentManifest, AttachmentReceipt } from "./domain";
import { canonicalSecurityPath, secureDirectory } from "./store";

export const MAX_ATTACHMENTS = 20;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

const SENSITIVE_EXACT_BASENAMES = new Set([
	".env",
	".npmrc",
	".pnpmrc",
	".netrc",
	".git-credentials",
	".pypirc",
	"credentials",
	"credentials.json",
	"application_default_credentials.json",
	"service-account.json",
	"service_account.json",
	"id_rsa",
	"id_dsa",
	"id_ecdsa",
	"id_ed25519",
	"identity",
	"keychain",
	"login data",
	"cookies",
]);
const SENSITIVE_DIRECTORY_SEGMENTS = new Set([".ssh", ".aws", ".azure", ".kube"]);
const SENSITIVE_SUFFIXES = [".pem", ".p12", ".pfx", ".key", ".jks", ".keystore"];

export interface ManifestOptions {
	workspaceRoot?: string;
	snapshotRoot?: string;
	allowOutsideWorkspace?: boolean;
	allowSensitiveFiles?: boolean;
	maxFiles?: number;
	maxBytes?: number;
	/** Test-only race hook invoked after the source file descriptor is opened. */
	testAfterOpen?: (input: string) => void | Promise<void>;
}

/**
 * Opens each approved source exactly once, validates the opened inode, and
 * writes those exact bytes to a private immutable snapshot. Providers receive
 * only snapshot paths; original workspaces and parent directories are never
 * granted as attachment authority.
 */
export async function buildAttachmentManifest(
	paths: readonly string[],
	options: ManifestOptions = {},
): Promise<AttachmentManifest> {
	const maxFiles = options.maxFiles ?? MAX_ATTACHMENTS;
	const maxBytes = options.maxBytes ?? MAX_ATTACHMENT_BYTES;
	if (paths.length > maxFiles) {
		throw new Error(`Attachment limit exceeded: requested ${paths.length}, maximum ${maxFiles}.`);
	}

	const requestedWorkspace = resolve(options.workspaceRoot ?? process.cwd());
	await assertNoSymlinkComponents(requestedWorkspace);
	const workspaceRoot = await realpath(requestedWorkspace);
	const snapshotsBase = resolve(options.snapshotRoot ?? join(workspaceRoot, ".gpt-control-snapshots"));
	await secureDirectory(snapshotsBase);
	const snapshotRoot = await mkdtemp(join(snapshotsBase, "snapshot-"));
	await chmod(snapshotRoot, 0o700);

	try {
		const files: AttachmentReceipt[] = [];
		const usedNames = new Set<string>();
		let totalBytes = 0;

		for (let index = 0; index < paths.length; index += 1) {
			const input = paths[index];
			if (typeof input !== "string" || input.trim() === "") throw new Error("Attachment paths must be non-empty strings.");
			const candidate = isAbsolute(input) ? resolve(input) : resolve(workspaceRoot, input);
			await assertNoSymlinkComponents(candidate);
			const beforePath = await realpath(candidate);
			const handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
			try {
				const before = await handle.stat();
				if (!before.isFile()) throw new Error(`Attachment must be a regular file: ${input}`);
				await options.testAfterOpen?.(input);

				const currentPath = await realpath(candidate);
				const current = await stat(currentPath);
				if (currentPath !== beforePath || current.dev !== before.dev || current.ino !== before.ino) {
					throw new Error(`Attachment changed or was replaced while being approved: ${input}`);
				}

				const workspaceRelative = relative(workspaceRoot, beforePath);
				const outside = isOutside(workspaceRelative);
				if (outside && options.allowOutsideWorkspace !== true) {
					throw new Error(`${beforePath} is outside trusted workspace ${workspaceRoot}. Operator policy does not allow it.`);
				}
				if (isSensitive(beforePath) && options.allowSensitiveFiles !== true) {
					throw new Error(`Refused sensitive attachment ${beforePath}. Only trusted operator policy can override this guard.`);
				}

				const bytes = await handle.readFile();
				const after = await handle.stat();
				if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
					throw new Error(`Attachment changed while snapshot bytes were being read: ${input}`);
				}
				totalBytes += bytes.byteLength;
				if (totalBytes > maxBytes) {
					throw new Error(`Attachment byte limit exceeded: requested ${totalBytes}, maximum ${maxBytes}.`);
				}

				const relativePath = outside
					? `external/${String(index + 1).padStart(2, "0")}-${safeName(basename(beforePath))}`
					: normalizeRelative(workspaceRelative || basename(beforePath));
				if (usedNames.has(relativePath)) throw new Error(`Duplicate attachment snapshot name: ${relativePath}`);
				usedNames.add(relativePath);
				const snapshotPath = confinedSnapshotPath(snapshotRoot, relativePath);
				await secureDirectory(dirname(snapshotPath));
				const destination = await open(snapshotPath, "wx", 0o400);
				try {
					await destination.writeFile(bytes);
				} finally {
					await destination.close();
				}
				await chmod(snapshotPath, 0o400);
				files.push({
					path: snapshotPath,
					relativePath,
					size: bytes.byteLength,
					sha256: sha256Bytes(bytes),
					lineCount: physicalLineCount(bytes),
				});
			} finally {
				await handle.close();
			}
		}

		const manifestHash = createHash("sha256");
		for (const file of files) {
			manifestHash.update(`${file.relativePath}\0${file.size}\0${file.sha256}\0${file.lineCount ?? 0}\n`);
		}
		return {
			workspaceRoot,
			files,
			totalBytes,
			sha256: manifestHash.digest("hex"),
			snapshotRoot,
			snapshotId: `${basename(snapshotRoot)}-${randomUUID().slice(0, 8)}`,
		};
	} catch (error) {
		await rm(snapshotRoot, { recursive: true, force: true });
		throw error;
	}
}

export async function renderAttachments(manifest: AttachmentManifest): Promise<string> {
	if (manifest.files.length === 0) return "";
	const sections: string[] = [];
	for (const file of manifest.files) {
		const bytes = await readFile(file.path);
		if (sha256Bytes(bytes) !== file.sha256 || bytes.byteLength !== file.size) {
			throw new Error(`Attachment snapshot integrity check failed for ${file.relativePath}.`);
		}
		sections.push(
			`\n--- FILE: ${file.relativePath} (${file.size} bytes, ${file.lineCount ?? 0} lines, sha256:${file.sha256}) ---\n${bytes.toString("utf8")}`,
		);
	}
	return sections.join("\n");
}

export function isSensitive(path: string): boolean {
	const normalized = path.toLowerCase().replaceAll("\\", "/");
	const parts = normalized.split("/").filter(Boolean);
	const name = parts.at(-1) ?? "";
	if (SENSITIVE_EXACT_BASENAMES.has(name)) return true;
	if (name.startsWith(".env.")) return true;
	if (/^(?:secret|secrets|credentials?)(?:[._-].*)?$/.test(name)) return true;
	if (/^service[-_]?account.*\.json$/.test(name)) return true;
	if (/^id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?$/.test(name)) return true;
	if (SENSITIVE_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true;
	if (parts.some((part) => SENSITIVE_DIRECTORY_SEGMENTS.has(part))) return true;
	if (normalized.includes("/.config/gcloud/") || normalized.endsWith("/.config/gcloud")) return true;
	if (normalized.includes("/.config/gh/") || normalized.endsWith("/.config/gh")) return true;
	if (normalized.includes("/.docker/") && name === "config.json") return true;
	if (normalized.includes("/.kube/") && name === "config") return true;
	return false;
}

function isOutside(relativePath: string): boolean {
	return relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
}

function normalizeRelative(value: string): string {
	const normalized = value.split(sep).join("/");
	if (normalized === "" || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
		throw new Error(`Unsafe attachment name: ${value}`);
	}
	return normalized;
}

function safeName(value: string): string {
	const safe = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+$/, "file");
	return safe || "file";
}

function confinedSnapshotPath(root: string, relativePath: string): string {
	const path = resolve(root, ...relativePath.split("/"));
	if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error(`Snapshot path escaped private root: ${relativePath}`);
	return path;
}

async function assertNoSymlinkComponents(path: string): Promise<void> {
	const absolute = await canonicalSecurityPath(resolve(path));
	const root = parse(absolute).root;
	let current = root;
	for (const component of relative(root, absolute).split(sep).filter(Boolean)) {
		current = join(current, component);
		const info = await lstat(current);
		if (info.isSymbolicLink()) throw new Error(`Refused symlink in security-sensitive path: ${current}`);
	}
}

function sha256Bytes(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function physicalLineCount(bytes: Uint8Array): number {
	if (bytes.byteLength === 0) return 0;
	let lines = 0;
	for (const byte of bytes) if (byte === 0x0a) lines += 1;
	return lines + (bytes[bytes.byteLength - 1] === 0x0a ? 0 : 1);
}
