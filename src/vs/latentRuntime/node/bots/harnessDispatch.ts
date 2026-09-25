/* eslint-disable header/header */
import { randomUUID } from 'crypto';
import { IBotConfig, IBotInput, IRuntimeSessionRef } from '../../../platform/latentRuntime/common/runtimeProtocol.js';

interface IDispatch {
	readonly requestId: string;
	readonly bot: IBotConfig;
	readonly input: IBotInput;
	readonly origin: IRuntimeSessionRef['origin'];
	claimed: boolean;
	readonly settle: (value: { sessionId: string; text: string } | Error) => void;
}

/** Bounded transport to an attached harness client, not an execution engine. No retries. */
export class HarnessDispatch {
	private readonly pending = new Map<string, IDispatch>();
	private lastPoll = 0;
	private readonly cancelled = new Set<string>();
	poll(): { runs: Omit<IDispatch, 'claimed' | 'settle'>[]; cancelled: string[] } {
		this.lastPoll = Date.now();
		const runs = [...this.pending.values()].filter(entry => !entry.claimed).map(entry => {
			entry.claimed = true;
			return { requestId: entry.requestId, bot: entry.bot, input: entry.input, origin: entry.origin };
		});
		const cancelled = [...this.cancelled]; this.cancelled.clear();
		return { runs, cancelled };
	}
	run(bot: IBotConfig, input: IBotInput, origin: IRuntimeSessionRef['origin']): Promise<{ sessionId: string; text: string }> {
		if (Date.now() - this.lastPoll > 10_000) { return Promise.reject(new Error('No Codex client is attached. Open the application to run this Bot.')); }
		const requestId = input.requestId ?? randomUUID();
		if (this.pending.has(requestId)) { return Promise.reject(new Error('Duplicate harness request.')); }
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => this.cancel(requestId), 30 * 60_000);
			this.pending.set(requestId, { requestId, bot, input: { ...input, requestId }, origin, claimed: false, settle: value => { clearTimeout(timer); this.pending.delete(requestId); if (value instanceof Error) { reject(value); } else { resolve(value); } } });
		});
	}
	finish(requestId: string, result: { sessionId: string; text: string } | Error): boolean {
		const entry = this.pending.get(requestId);
		if (!entry?.claimed) { return false; }
		entry.settle(result); return true;
	}
	cancel(requestId: string): boolean {
		const entry = this.pending.get(requestId);
		if (!entry) { return false; }
		if (entry.claimed) { this.cancelled.add(requestId); }
		entry.settle(new Error('Harness request cancelled or timed out.')); return true;
	}
	dispose(): void { for (const id of this.pending.keys()) { this.cancel(id); } this.lastPoll = 0; }
}
