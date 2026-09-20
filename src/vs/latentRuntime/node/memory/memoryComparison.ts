/* eslint-disable header/header */
import { createHash } from 'crypto';
import { IMemoryWriteOp } from '../../../platform/latentRuntime/common/runtimeProtocol.js';
import { IMemoryComparisonEntry, IRemoteMemoryEntry, MemoryComparisonDecision } from '../../../platform/latentRuntime/common/runtimePlugin.js';

type MemoryTarget = IMemoryComparisonEntry['target'];

/** Bullet entries of `MEMORY.md` / `USER.md` (`- text`), the unit adapters mirror. */
export function memoryBullets(markdown: string): string[] {
	if (!markdown.trim()) { return []; }
	if (markdown.includes('\n§\n') || !/^\s*(#|- )/m.test(markdown)) { return markdown.split('\n§\n').map(entry => entry.trim()).filter(Boolean); }
	return markdown.split(/\r?\n/).filter(line => /^\s*-\s+\S/.test(line)).map(line => line.replace(/^\s*-\s+/, '').trim());
}

/** Stable key of an entry; whitespace differences do not change it. */
export function memoryEntryKey(target: MemoryTarget, content: string): string {
	return createHash('sha256').update(`${target}\0${content.trim().replace(/\s+/g, ' ')}`).digest('hex').slice(0, 24);
}

function words(text: string): Set<string> {
	return new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word.length > 1));
}

/** Jaccard similarity of the word sets of two entries. */
export function memorySimilarity(a: string, b: string): number {
	const left = words(a);
	const right = words(b);
	if (!left.size && !right.size) {
		return 1;
	}
	let shared = 0;
	for (const word of left) {
		if (right.has(word)) {
			shared++;
		}
	}
	return shared / (left.size + right.size - shared);
}

/**
 * Compares local memory (the source of record) with an adapter's remote copy
 * without changing either. A remote entry similar enough to an unmatched local
 * entry is reported as a `conflict`, so the user decides per entry which version wins.
 */
export function compareMemory(local: { readonly memory: string; readonly user: string }, remote: readonly IRemoteMemoryEntry[], conflictThreshold = 0.5): IMemoryComparisonEntry[] {
	const result: IMemoryComparisonEntry[] = [];
	for (const target of ['memory', 'user'] as const) {
		const unmatchedLocal = new Map(memoryBullets(target === 'memory' ? local.memory : local.user).map(content => [memoryEntryKey(target, content), content]));
		const unmatchedRemote: IRemoteMemoryEntry[] = [];
		for (const entry of remote.filter(candidate => candidate.target === target)) {
			const key = memoryEntryKey(target, entry.content);
			const localContent = unmatchedLocal.get(key);
			if (localContent !== undefined) {
				result.push({ target, key, local: localContent, remote: entry.content, remoteUpdatedAt: entry.updatedAt, status: 'same' });
				unmatchedLocal.delete(key);
			} else {
				unmatchedRemote.push(entry);
			}
		}
		for (const entry of unmatchedRemote) {
			let best: { key: string; content: string; score: number } | undefined;
			for (const [key, content] of unmatchedLocal) {
				const score = memorySimilarity(content, entry.content);
				if (score >= conflictThreshold && (!best || score > best.score)) {
					best = { key, content, score };
				}
			}
			if (best) {
				unmatchedLocal.delete(best.key);
				result.push({ target, key: best.key, local: best.content, remote: entry.content, remoteUpdatedAt: entry.updatedAt, status: 'conflict' });
			} else {
				result.push({ target, key: memoryEntryKey(target, entry.content), remote: entry.content, remoteUpdatedAt: entry.updatedAt, status: 'remoteOnly' });
			}
		}
		for (const [key, content] of unmatchedLocal) {
			result.push({ target, key, local: content, status: 'localOnly' });
		}
	}
	return result;
}

/**
 * The writes that settle one reviewed entry. `local` changes local memory (and is
 * then mirrored to every enabled adapter); `remote` goes only to the reviewed adapter.
 */
export function memoryResolutionWrites(entry: IMemoryComparisonEntry, decision: MemoryComparisonDecision): { readonly local?: IMemoryWriteOp; readonly remote?: IMemoryWriteOp } {
	const { target, local, remote } = entry;
	if (decision === 'keepLocal') {
		if (local !== undefined && remote !== undefined && local !== remote) {
			return { remote: { action: 'replace', target, oldText: remote, content: local } };
		}
		if (local !== undefined && remote === undefined) {
			return { remote: { action: 'add', target, content: local } };
		}
		if (local === undefined && remote !== undefined) {
			return { remote: { action: 'remove', target, oldText: remote } };
		}
		return {};
	}
	if (local !== undefined && remote !== undefined && local !== remote) {
		return { local: { action: 'replace', target, oldText: local, content: remote } };
	}
	if (local === undefined && remote !== undefined) {
		return { local: { action: 'add', target, content: remote } };
	}
	if (local !== undefined && remote === undefined) {
		return { local: { action: 'remove', target, oldText: local } };
	}
	return {};
}
