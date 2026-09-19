/* eslint-disable header/header */
import { IIndexedTurn, IRecallHit, IRecallOptions } from '../../../platform/latentRuntime/common/runtimeProtocol.js';
import { RuntimeDatabase } from '../runtimeDatabase.js';
import { combineScores, formatAgentHit, toFtsQuery } from './recallRanking.js';

/**
 * Local Recall Index (spec 01 P1-FR-091/092): FTS5 BM25 candidates, recency
 * reweight, neighbour expansion, and the agent-format output. The index is
 * disposable; `rebuild` re-derives it from runtime sessions and re-pushed threads.
 */
export class RecallIndex {
	constructor(private readonly database: RuntimeDatabase) { }

	async index(turns: readonly IIndexedTurn[]): Promise<number> {
		let count = 0;
		for (const turn of turns) {
			if (!turn.text.trim()) {
				continue;
			}
			await this.database.run('INSERT OR REPLACE INTO recall_turns (session_id, thread_id, branch_id, seq, role, block_type, text, ts, harness, workdir) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [turn.sessionId, turn.threadId ?? null, turn.branchId ?? null, turn.seq, turn.role, turn.blockType, turn.text, turn.timestamp, turn.harness, turn.workdir]);
			await this.database.run('DELETE FROM recall_fts WHERE session_id = ? AND seq = ?', [turn.sessionId, turn.seq]);
			await this.database.run('INSERT INTO recall_fts (text, session_id, seq) VALUES (?, ?, ?)', [turn.text, turn.sessionId, turn.seq]);
			count++;
		}
		return count;
	}

	async recall(query: string, options: IRecallOptions = {}): Promise<IRecallHit[]> {
		const fts = toFtsQuery(query);
		if (!fts) {
			return [];
		}
		const k = options.k ?? 8;
		const candidates = options.candidates ?? 30;
		const halfLife = options.halfLifeDays ?? 30;
		const neighbors = options.neighbors ?? 1;
		const now = Date.now();
		const rows = await this.database.all<{ session_id: string; seq: number; rank: number }>('SELECT session_id, seq, rank FROM recall_fts WHERE recall_fts MATCH ? ORDER BY rank LIMIT ?', [fts, candidates]);
		const hits: IRecallHit[] = [];
		for (const row of rows) {
			const turn = await this.database.get<{ session_id: string; thread_id: string | null; branch_id: string | null; seq: number; role: string; block_type: string; text: string; ts: number; harness: string; workdir: string }>('SELECT * FROM recall_turns WHERE session_id = ? AND seq = ?', [row.session_id, row.seq]);
			if (!turn || (options.type && turn.block_type !== options.type) || (options.harness && turn.harness !== options.harness)) {
				continue;
			}
			const neighborRows = neighbors > 0
				? await this.database.all<{ seq: number; role: string; text: string }>('SELECT seq, role, text FROM recall_turns WHERE session_id = ? AND seq BETWEEN ? AND ? AND seq != ? ORDER BY seq', [turn.session_id, turn.seq - neighbors, turn.seq + neighbors, turn.seq])
				: [];
			const partial = {
				sessionId: turn.session_id,
				threadId: turn.thread_id ?? undefined,
				branchId: turn.branch_id ?? undefined,
				seq: turn.seq,
				timestamp: turn.ts,
				harness: turn.harness,
				workdir: turn.workdir,
				blockType: turn.block_type,
				role: turn.role,
				score: combineScores(row.rank, turn.ts, now, halfLife),
				text: turn.text,
				neighbors: neighborRows.map(neighbor => ({ seq: neighbor.seq, role: neighbor.role, preview: neighbor.text.replace(/\s+/g, ' ').slice(0, 160) })),
			};
			hits.push({ ...partial, agentFormat: formatAgentHit(partial) });
		}
		return hits.sort((a, b) => b.score - a.score).slice(0, k);
	}

	async rebuild(sessionTurns: () => Promise<readonly IIndexedTurn[]>): Promise<number> {
		await this.database.exec('DELETE FROM recall_fts; DELETE FROM recall_turns;');
		return this.index(await sessionTurns());
	}

	async count(): Promise<number> {
		return (await this.database.get<{ count: number }>('SELECT COUNT(*) AS count FROM recall_turns'))?.count ?? 0;
	}
}
