import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { AttachmentManifest, AttachmentReceipt } from "./domain";

export const MAX_ATTACHMENTS = 20;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

const SENSITIVE_SEGMENTS = new Set([
	".env",
	".ssh",
	".aws",
	".azure",
	".config/gcloud",
	"credentials",
	"credentials.json",
	"id_rsa",
	"id_ed25519",
	"keychain",
	"login data",
	"cookies",
]);
const SENSITIVE_SUFFIXES = [".pem", ".p12", ".pfx", ".key"];

export interface ManifestOptions {
	workspaceRoot?: string;
	allowOutsideWorkspace?: boolean;
	allowSensitiveFiles?: boolean;
	maxFiles?: number;
	maxBytes?: number;
}

export async function buildAttachmentManifest(paths: readonly string[], options: ManifestOptions = {}): Promise<AttachmentManifest> {
	if (paths.length > (options.maxFiles ?? MAX_ATTACHMENTS)) {
		throw new Error(`Attachment limit exceeded: requested ${paths.length}, maximum ${options.maxFiles ?? MAX_ATTACHMENTS}.`);
	}
	const workspaceRoot = await realpath(resolve(options.workspaceRoot ?? process.cwd()));
	const files: AttachmentReceipt[] = [];
	let totalBytes = 0;

	for (const input of paths) {
		const candidate = isAbsolute(input) ? input : resolve(workspaceRoot, input);
		const path = await realpath(candidate);
		const info = await stat(path);
		if (!info.isFile()) throw new Error(`Attachment must be a regular file: ${input}`);
		const relativePath = relative(workspaceRoot, path);
		const outside = relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
		if (outside && options.allowOutsideWorkspace !== true) {
			throw new Error(`${path} is outside workspace ${workspaceRoot}. Pass allow_outside_workspace=true to transmit it.`);
		}
		if (isSensitive(path) && options.allowSensitiveFiles !== true) {
			throw new Error(`Refused sensitive attachment ${path}. Pass allow_sensitive_files=true only when the user explicitly intends to transmit it.`);
		}
		totalBytes += info.size;
		if (totalBytes > (options.maxBytes ?? MAX_ATTACHMENT_BYTES)) {
			throw new Error(`Attachment byte limit exceeded: requested ${totalBytes}, maximum ${options.maxBytes ?? MAX_ATTACHMENT_BYTES}.`);
		}
		files.push({
			path,
			relativePath: outside ? path : relativePath || basename(path),
			size: info.size,
			sha256: await sha256File(path),
		});
	}

	const manifestHash = createHash("sha256");
	for (const file of files) manifestHash.update(`${file.relativePath}\0${file.size}\0${file.sha256}\n`);
	return { workspaceRoot, files, totalBytes, sha256: manifestHash.digest("hex") };
}


export function isSensitive(path: string): boolean {
	const normalized = path.toLowerCase().replaceAll("\\", "/");
	const parts = normalized.split("/");
	if (parts.some((part) => SENSITIVE_SEGMENTS.has(part))) return true;
	if ([...SENSITIVE_SEGMENTS].some((segment) => normalized.includes(`/${segment}/`) || normalized.endsWith(`/${segment}`))) return true;
	return SENSITIVE_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

async function sha256File(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}
