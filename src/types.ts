/** Host-neutral contract shared by Oh My Pi and Pi extension runtimes. */

export type SchemaNode = Record<string, unknown>;

/** The TypeBox surface both hosts expose as `pi.typebox.Type`. */
export interface TypeBuilder {
	Object(properties: Record<string, SchemaNode>, options?: Record<string, unknown>): SchemaNode;
	Array(item: SchemaNode, options?: Record<string, unknown>): SchemaNode;
	String(options?: Record<string, unknown>): SchemaNode;
	Number(options?: Record<string, unknown>): SchemaNode;
	Integer(options?: Record<string, unknown>): SchemaNode;
	Boolean(options?: Record<string, unknown>): SchemaNode;
	Literal(value: string): SchemaNode;
	Union(nodes: SchemaNode[]): SchemaNode;
	Optional(node: SchemaNode): SchemaNode;
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

export interface ExecOptions {
	signal?: AbortSignal;
	timeout?: number;
	cwd?: string;
}

export type Exec = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

export interface ToolResult {
	content: Array<Record<string, unknown>>;
	details?: unknown;
	structuredContent?: unknown;
	isError?: boolean;
}

export interface ToolDefinition {
	name: string;
	label: string;
	description: string;
	parameters: SchemaNode;
	/** OMP-only hints; Pi ignores unknown keys. */
	loadMode?: "discoverable" | "essential";
	approval?: "read" | "write" | "exec";
	strict?: boolean;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<ToolResult>;
}

/**
 * The subset of the host API this extension relies on.
 *
 * `typebox` is present on both OMP and Pi. `exec` and the single-argument
 * `setLabel` are OMP-only, so both are treated as optional.
 */
export interface ExtensionAPI {
	typebox?: { Type: TypeBuilder };
	zod?: unknown;
	exec?: Exec;
	setLabel?(label: string): void;
	registerTool(definition: ToolDefinition): void;
}
