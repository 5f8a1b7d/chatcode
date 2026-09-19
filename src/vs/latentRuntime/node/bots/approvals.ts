/* eslint-disable header/header */
import { randomUUID } from 'crypto';
import { ApprovalDecision, IRuntimeApprovalRequest } from '../../../platform/latentRuntime/common/runtimeProtocol.js';

interface IPending {
	readonly request: IRuntimeApprovalRequest;
	readonly resolve: (decision: ApprovalDecision | 'timeout') => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

/** Approval requests for out-of-scope tool calls; unanswered requests time out as denied (P1-FR-083). */
export class ApprovalService {
	private readonly pending = new Map<string, IPending>();

	constructor(
		private readonly timeoutMs: () => number,
		private readonly notify: (event: { kind: 'approvalRequested'; request: IRuntimeApprovalRequest } | { kind: 'approvalResolved'; id: string; decision: ApprovalDecision | 'timeout' }) => void,
	) { }

	list(): IRuntimeApprovalRequest[] {
		return [...this.pending.values()].map(entry => entry.request);
	}

	request(input: Omit<IRuntimeApprovalRequest, 'id' | 'expiresAt'>): Promise<ApprovalDecision | 'timeout'> {
		const id = randomUUID();
		const request: IRuntimeApprovalRequest = { ...input, id, expiresAt: Date.now() + this.timeoutMs() };
		return new Promise(resolve => {
			const timer = setTimeout(() => this.resolve(id, 'timeout'), this.timeoutMs());
			this.pending.set(id, { request, resolve, timer });
			this.notify({ kind: 'approvalRequested', request });
		});
	}

	respond(id: string, decision: ApprovalDecision): boolean {
		return this.resolve(id, decision);
	}

	private resolve(id: string, decision: ApprovalDecision | 'timeout'): boolean {
		const entry = this.pending.get(id);
		if (!entry) {
			return false;
		}
		clearTimeout(entry.timer);
		this.pending.delete(id);
		entry.resolve(decision);
		this.notify({ kind: 'approvalResolved', id, decision });
		return true;
	}
}
