/* eslint-disable header/header */
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';
import { IMemorySnapshot, IMemoryWriteOp, IMemoryWriteResult } from '../../../platform/latentRuntime/common/runtimeProtocol.js';

/**
 * Plain-file memory (spec 01 P1-FR-090/092): `MEMORY.md`, `USER.md`, dated
 * entries. Additions apply immediately; replace/remove are staged behind the
 * Hermes-style write gate until confirmed.
 */
export class MemoryStore {
	private readonly staged = new Map<string, { summary: string; op: IMemoryWriteOp }>();
	private readonly root: string;

	constructor(home: string) {
		this.root = join(home, '..', 'memory');
	}

	get directory(): string {
		return this.root;
	}

	async initialize(): Promise<void> {
		await fs.mkdir(join(this.root, 'entries'), { recursive: true });
		for (const file of ['MEMORY.md', 'USER.md']) {
			try {
				await fs.access(join(this.root, file));
			} catch {
				await fs.writeFile(join(this.root, file), `# ${file === 'MEMORY.md' ? 'Memory' : 'User profile'}\n\n`, 'utf8');
			}
		}
	}

	private fileFor(target: 'memory' | 'user'): string {
		return join(this.root, target === 'memory' ? 'MEMORY.md' : 'USER.md');
	}

	async write(op: IMemoryWriteOp, options: { confirmed?: boolean } = {}): Promise<IMemoryWriteResult> {
		if (op.action === 'add') {
			const content = (op.content ?? '').trim();
			if (!content) {
				return { applied: false, message: 'Nothing to add.' };
			}
			await fs.appendFile(this.fileFor(op.target), `- ${content}\n`, 'utf8');
			const slug = `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}.md`;
			await fs.writeFile(join(this.root, 'entries', slug), `# ${content.split('\n')[0].slice(0, 80)}\n\n${content}\n\nsource: ${op.target}\n`, 'utf8');
			return { applied: true, message: `Added to ${op.target}.` };
		}
		if (!options.confirmed) {
			const id = randomUUID();
			const summary = op.action === 'remove' ? `Remove "${(op.oldText ?? '').slice(0, 80)}" from ${op.target}` : `Replace "${(op.oldText ?? '').slice(0, 60)}" in ${op.target}`;
			this.staged.set(id, { summary, op });
			return { applied: false, staged: { id, summary }, message: 'Staged for confirmation.' };
		}
		const file = this.fileFor(op.target);
		const current = await fs.readFile(file, 'utf8');
		if (!op.oldText || !current.includes(op.oldText)) {
			return { applied: false, message: 'The text to change was not found.' };
		}
		await fs.writeFile(file, current.replace(op.oldText, op.action === 'remove' ? '' : (op.content ?? '')), 'utf8');
		return { applied: true, message: `${op.action === 'remove' ? 'Removed from' : 'Replaced in'} ${op.target}.` };
	}

	async confirmStaged(id: string, accept: boolean): Promise<IMemoryWriteResult> {
		const entry = this.staged.get(id);
		if (!entry) {
			return { applied: false, message: 'Unknown staged change.' };
		}
		this.staged.delete(id);
		if (!accept) {
			return { applied: false, message: 'Discarded.' };
		}
		return this.write(entry.op, { confirmed: true });
	}

	async snapshot(): Promise<IMemorySnapshot> {
		const entries = await fs.readdir(join(this.root, 'entries')).catch(() => [] as string[]);
		const list = await Promise.all(entries.filter(file => file.endsWith('.md')).map(async file => {
			const stat = await fs.stat(join(this.root, 'entries', file));
			const first = (await fs.readFile(join(this.root, 'entries', file), 'utf8')).split('\n')[0].replace(/^#\s*/, '');
			return { file, title: first, updatedAt: stat.mtimeMs };
		}));
		return {
			memory: await fs.readFile(this.fileFor('memory'), 'utf8'),
			user: await fs.readFile(this.fileFor('user'), 'utf8'),
			entries: list.sort((a, b) => b.updatedAt - a.updatedAt),
			staged: [...this.staged].map(([id, entry]) => ({ id, summary: entry.summary })),
		};
	}
}
