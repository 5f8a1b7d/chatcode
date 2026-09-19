/* eslint-disable header/header */
import { IRecallHit } from '../../../platform/latentRuntime/common/runtimeProtocol.js';

/** Recency reweight with a half-life in days; 0 disables the decay (Funes `--half-life`). */
export function recencyWeight(timestamp: number, now: number, halfLifeDays: number): number {
	if (halfLifeDays <= 0) {
		return 1;
	}
	const ageDays = Math.max(0, now - timestamp) / 86_400_000;
	return Math.pow(0.5, ageDays / halfLifeDays);
}

/** Query terms for FTS5: quoted tokens joined with OR so partial matches still rank. */
export function toFtsQuery(query: string): string {
	const terms = query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
	return terms.map(term => `"${term.replace(/"/g, '""')}"`).join(' OR ');
}

/** The stable, parseable agent format of one hit (Funes `recall` output contract). */
export function formatAgentHit(hit: Omit<IRecallHit, 'agentFormat'>): string {
	const header = `[${new Date(hit.timestamp).toISOString()}] ${hit.harness} ${hit.workdir}/${hit.sessionId.slice(0, 8)} ${hit.blockType}  score=${hit.score.toFixed(3)}`;
	const drill = `  → get ${hit.sessionId} --from ${Math.max(0, hit.seq - 1)} --to ${hit.seq + 1} --memory local`;
	const neighbors = hit.neighbors.map(neighbor => `  ~ [${neighbor.role} ${hit.blockType} seq${neighbor.seq}] ${neighbor.preview}`);
	return [header, drill, hit.text, ...neighbors, '---'].join('\n');
}

/** Combines BM25 rank (lower is better in FTS5) with recency into one descending score. */
export function combineScores(bm25Rank: number, timestamp: number, now: number, halfLifeDays: number): number {
	const relevance = 1 / (1 + Math.max(0, -bm25Rank));
	return Number((relevance * recencyWeight(timestamp, now, halfLifeDays)).toFixed(6));
}
