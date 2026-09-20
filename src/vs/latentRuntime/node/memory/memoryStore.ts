/* eslint-disable header/header */
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';
import { IMemorySnapshot, IMemoryWriteOp, IMemoryWriteResult } from '../../../platform/latentRuntime/common/runtimeProtocol.js';
import { memoryThreat } from './memorySafety.js';

const delimiter = '\n§\n';
const limits = { memory: 2200, user: 1375 };
interface PendingChange { readonly id: string; readonly summary: string; readonly op: IMemoryWriteOp }

/** Port of Hermes' bounded entry store: atomic writes, unique matching, deduplication and frozen prompt snapshots. */
export class MemoryStore {
	private readonly root: string;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(home: string) { this.root = join(home, '..', 'memory'); }
	get directory(): string { return this.root; }

	async initialize(): Promise<void> {
		await fs.mkdir(join(this.root, 'entries'), { recursive: true });
		for (const file of ['MEMORY.md', 'USER.md']) {
			try { await fs.writeFile(join(this.root, file), '', { encoding: 'utf8', flag: 'wx', mode: 0o600 }); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; } }
		}
	}

	private fileFor(target: 'memory' | 'user'): string { return join(this.root, target === 'memory' ? 'MEMORY.md' : 'USER.md'); }

	/** Preserves legacy Markdown bullets while accepting Hermes' multiline §-delimited entries. */
	private entries(raw: string): string[] {
		const text = raw.replace(/^\uFEFF/, '').trim();
		if (/^# (Memory|User profile)\s*(\n|$)/.test(text)) {
			return text.replace(/^# (Memory|User profile)\s*/, '').split(/\n(?=- )/).map(entry => entry.replace(/^- /, '').trim()).filter(Boolean);
		}
		return text.split(delimiter).map(entry => entry.trim()).filter(Boolean);
	}

	private async read(target: 'memory' | 'user'): Promise<string> {
		// Fatal UTF-8 decoding refuses to rewrite an unreadable/corrupted memory file as an empty one.
		return new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(this.fileFor(target)));
	}

	private async atomicWrite(path: string, content: string): Promise<void> {
		const temporary = `${path}.${randomUUID()}.tmp`;
		try {
			await fs.writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
			await fs.rename(temporary, path);
		} finally { await fs.rm(temporary, { force: true }); }
	}

	private async pending(): Promise<PendingChange[]> {
		try { return JSON.parse(await fs.readFile(join(this.root, 'pending.json'), 'utf8')) as PendingChange[]; }
		catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return []; } throw error; }
	}

	/** Serializes in-process mutations and coordinates multiple runtime instances through an exclusive lock. */
	private locked<T>(task: () => Promise<T>): Promise<T> {
		const next = this.queue.then(async () => {
			const path = join(this.root, '.write.lock');
			let lock;
			for (let attempt = 0; !lock; attempt++) {
				try { lock = await fs.open(path, 'wx', 0o600); await lock.writeFile(String(process.pid)); }
				catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 100) { throw new Error('Memory is locked by another writer. Retry after it finishes.'); }
					try {
						const owner = Number(await fs.readFile(path, 'utf8'));
						if (Number.isInteger(owner) && owner > 0) {
							try { process.kill(owner, 0); }
							catch (probeError) { if ((probeError as NodeJS.ErrnoException).code === 'ESRCH') { await fs.rm(path, { force: true }); } }
						}
					} catch { /* A competing writer may already have released the lock. */ }
					await new Promise(resolve => setTimeout(resolve, 20));
				}
			}
			try { return await task(); }
			finally { await lock.close(); await fs.rm(path, { force: true }); }
		});
		this.queue = next.catch(() => undefined);
		return next;
	}

	write(op: IMemoryWriteOp, options: { confirmed?: boolean } = {}): Promise<IMemoryWriteResult> {
		return this.locked(() => this.apply(op, options.confirmed === true));
	}

	private async apply(op: IMemoryWriteOp, confirmed: boolean): Promise<IMemoryWriteResult> {
		if (op.target !== 'memory' && op.target !== 'user') { return { applied: false, message: 'Invalid memory target.' }; }
		const raw = await this.read(op.target);
		const original = this.entries(raw);
		const entries = [...new Set(original)];
		const operations = op.operations ?? [op];
		if (!operations.length || operations.length > 50) { return { applied: false, message: 'Provide between 1 and 50 memory operations.' }; }
		for (const operation of operations) {
			const content = operation.content?.trim() ?? '';
			const old = operation.oldText?.trim() ?? '';
			if (!['add', 'replace', 'remove'].includes(operation.action)) { return { applied: false, message: 'Unknown memory action.' }; }
			if (operation.action !== 'remove') {
				if (!content || content.includes(delimiter)) { return { applied: false, message: 'Provide a non-empty entry without the entry delimiter.' }; }
				const threat = memoryThreat(content);
				if (threat) { return { applied: false, message: `Blocked memory content: ${threat}.` }; }
			}
			if (operation.action === 'add') {
				if (!entries.includes(content)) { entries.push(content); }
			} else {
				if (!old) { return { applied: false, message: 'oldText is required for replace/remove.' }; }
				const matches = entries.filter(entry => entry.includes(old));
				if (matches.length !== 1) { return { applied: false, message: matches.length ? 'Multiple entries matched. Use a more specific oldText.' : 'No entry matched oldText.' }; }
				entries.splice(entries.indexOf(matches[0]), 1, ...(operation.action === 'replace' ? [content] : []));
			}
		}
		const content = [...new Set(entries)].join(delimiter);
		if (op.operations && original.length && !entries.length) { return { applied: false, message: 'A consolidation batch cannot empty memory. Use a deliberate single remove instead.' }; }
		if (content.length > limits[op.target] && content.length >= original.join(delimiter).length) {
			return { applied: false, message: `Memory would use ${content.length}/${limits[op.target]} characters. Consolidate existing entries before adding more.` };
		}
		if (content === original.join(delimiter)) { return { applied: true, message: 'Entry already exists. No duplicate added.' }; }
		if (operations.some(operation => operation.action !== 'add') && !confirmed) {
			const pending = await this.pending();
			const change = { id: randomUUID(), summary: `${op.target}: ${operations.map(operation => `${operation.action} ${(operation.oldText ?? operation.content ?? '').slice(0, 80)}`).join('; ')}`, op };
			await this.atomicWrite(join(this.root, 'pending.json'), JSON.stringify([...pending, change]));
			return { applied: false, staged: { id: change.id, summary: change.summary }, message: 'Staged for confirmation.' };
		}
		// An external editor may not take our lock. Refuse to overwrite an edit made since this operation started.
		if (await this.read(op.target) !== raw) { return { applied: false, message: 'Memory changed on disk. Read it again and retry.' }; }
		await this.atomicWrite(this.fileFor(op.target), content);
		return { applied: true, message: `Saved ${op.target} (${content.length}/${limits[op.target]} characters). This update is complete; do not repeat it.` };
	}

	confirmStaged(id: string, accept: boolean, onApplied?: (op: IMemoryWriteOp) => Promise<void>): Promise<IMemoryWriteResult> {
		return this.locked(async () => {
			const pending = await this.pending();
			const change = pending.find(change => change.id === id);
			if (!change) { return { applied: false, message: 'Unknown staged change.' }; }
			const result = accept ? await this.apply(change.op, true) : { applied: false, message: 'Discarded.' };
			if (!accept || result.applied) { await this.atomicWrite(join(this.root, 'pending.json'), JSON.stringify(pending.filter(change => change.id !== id))); }
			if (result.applied) { await onApplied?.(change.op); }
			return result;
		});
	}

	/** Call once per session and persist the result; writes during a conversation do not change its prefix. */
	async prompt(): Promise<string> {
		const blocks = await Promise.all((['memory', 'user'] as const).map(async target => {
			const entries = this.entries(await this.read(target));
			if (!entries.length) { return ''; }
			const safe = entries.map(entry => memoryThreat(entry) ? '[BLOCKED: unsafe memory entry; review the original memory file.]' : entry).join(delimiter);
			return `${target === 'memory' ? 'MEMORY (your personal notes)' : 'USER PROFILE (who the user is)'} [${safe.length}/${limits[target]} chars]\n${safe}`;
		}));
		return blocks.filter(Boolean).join('\n\n');
	}

	async snapshot(): Promise<IMemorySnapshot> {
		const files = await fs.readdir(join(this.root, 'entries'));
		return {
			directory: this.root,
			memory: await this.read('memory'), user: await this.read('user'),
			entries: await Promise.all(files.filter(file => file.endsWith('.md')).map(async file => ({ file, title: (await fs.readFile(join(this.root, 'entries', file), 'utf8')).split('\n')[0].replace(/^#\s*/, ''), updatedAt: (await fs.stat(join(this.root, 'entries', file))).mtimeMs }))),
			staged: (await this.pending()).map(({ id, summary }) => ({ id, summary })),
		};
	}
}
