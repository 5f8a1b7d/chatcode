/* eslint-disable header/header */
import { promises as fs } from 'fs';
import { join, resolve } from 'path';
import { IRuntimeTool, IRuntimeToolContext } from '../../../platform/latentRuntime/common/runtimePlugin.js';

export type IToolContext = IRuntimeToolContext;

/** Built-in bot tools; every call passes through the authorization scope first. */
export const builtinTools: Record<string, IRuntimeTool> = {
	read_file: {
		definition: { name: 'read_file', description: 'Read a UTF-8 text file relative to the working directory.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
		run: async (args, context) => (await fs.readFile(resolveInside(context.workingDirectory, String(args.path)), 'utf8')).slice(0, 100_000),
	},
	write_file: {
		definition: { name: 'write_file', description: 'Write a UTF-8 text file relative to the working directory, creating folders as needed.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
		run: async (args, context) => {
			const target = resolveInside(context.workingDirectory, String(args.path));
			await fs.mkdir(join(target, '..'), { recursive: true });
			await fs.writeFile(target, String(args.content ?? ''), 'utf8');
			return `wrote ${String(args.path)}`;
		},
	},
	list_dir: {
		definition: { name: 'list_dir', description: 'List entries of a directory relative to the working directory.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
		run: async (args, context) => (await fs.readdir(resolveInside(context.workingDirectory, String(args.path ?? '.')), { withFileTypes: true })).map(entry => `${entry.isDirectory() ? 'd' : 'f'} ${entry.name}`).join('\n'),
	},
	http_fetch: {
		definition: { name: 'http_fetch', description: 'Fetch a URL with GET and return up to 50k characters of the body.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
		run: async args => {
			const response = await fetch(String(args.url));
			return `HTTP ${response.status}\n${(await response.text()).slice(0, 50_000)}`;
		},
	},
	recall: {
		definition: { name: 'recall', description: 'Search the local memory of past threads and runtime sessions.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
		run: (args, context) => context.recall(String(args.query)),
	},
	memory_write: {
		definition: { name: 'memory_write', description: 'Append a note to local memory (target "memory") or the user profile (target "user").', parameters: { type: 'object', properties: { target: { type: 'string', enum: ['memory', 'user'] }, content: { type: 'string' } }, required: ['target', 'content'] } },
		run: (args, context) => context.memoryWrite(args.target === 'user' ? 'user' : 'memory', String(args.content ?? '')),
	},
	create_artifact: {
		definition: { name: 'create_artifact', description: 'Store a produced file as an artifact of this run.', parameters: { type: 'object', properties: { name: { type: 'string' }, content: { type: 'string' }, mimeType: { type: 'string' } }, required: ['name', 'content'] } },
		run: (args, context) => context.artifact(String(args.name), String(args.content ?? ''), typeof args.mimeType === 'string' ? args.mimeType : 'text/plain'),
	},
};

/** Model-facing function names only allow `[A-Za-z0-9_-]`; scope keys such as `zotero.search` are mapped. */
export function wireToolName(name: string): string {
	return name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

/** Built-in tools plus tools contributed by runtime plugins (`latent.botTools`). */
export class ToolRegistry {
	private readonly contributed = new Map<string, IRuntimeTool>();

	register(tool: IRuntimeTool): void {
		if (builtinTools[tool.definition.name]) {
			throw new Error(`Tool ${tool.definition.name} is built in and cannot be replaced.`);
		}
		this.contributed.set(tool.definition.name, tool);
	}

	unregister(name: string): void {
		this.contributed.delete(name);
	}

	all(): IRuntimeTool[] {
		return [...Object.values(builtinTools), ...this.contributed.values()];
	}

	/** Resolves a model-facing function name back to its tool. */
	byWireName(wireName: string): IRuntimeTool | undefined {
		return this.all().find(tool => wireToolName(tool.definition.name) === wireName);
	}
}

function resolveInside(root: string, relative: string): string {
	const target = resolve(root, relative);
	if (!target.startsWith(resolve(root))) {
		throw new Error(`Path ${relative} leaves the working directory.`);
	}
	return target;
}
