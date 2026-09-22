/* eslint-disable header/header */
import { randomUUID } from 'crypto';
import { IRuntimeQuestionRequest } from '../../../platform/latentRuntime/common/runtimeProtocol.js';

interface IPendingQuestion {
	readonly request: IRuntimeQuestionRequest;
	readonly resolve: (answers: Readonly<Record<string, string>> | undefined) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

/** Blocking Bot questions mirrored to every connected workbench. */
export class QuestionService {
	private readonly pending = new Map<string, IPendingQuestion>();

	constructor(
		private readonly timeoutMs: () => number,
		private readonly notify: (event: { kind: 'questionRequested'; request: IRuntimeQuestionRequest } | { kind: 'questionResolved'; id: string }) => void,
	) { }

	list(): IRuntimeQuestionRequest[] { return [...this.pending.values()].map(entry => entry.request); }

	request(input: Omit<IRuntimeQuestionRequest, 'id' | 'expiresAt'>, signal?: AbortSignal): Promise<Readonly<Record<string, string>> | undefined> {
		if (signal?.aborted) { return Promise.resolve(undefined); }
		const id = randomUUID();
		const request: IRuntimeQuestionRequest = { ...input, id, expiresAt: Date.now() + this.timeoutMs() };
		return new Promise(resolve => {
			const timer = setTimeout(() => this.resolve(id, undefined), this.timeoutMs());
			const abort = () => this.resolve(id, undefined);
			this.pending.set(id, { request, resolve: answers => { signal?.removeEventListener('abort', abort); resolve(answers); }, timer });
			signal?.addEventListener('abort', abort, { once: true });
			this.notify({ kind: 'questionRequested', request });
		});
	}

	respond(id: string, answers: Readonly<Record<string, string>>): boolean { return this.resolve(id, answers); }

	private resolve(id: string, answers: Readonly<Record<string, string>> | undefined): boolean {
		const entry = this.pending.get(id);
		if (!entry) { return false; }
		clearTimeout(entry.timer);
		this.pending.delete(id);
		entry.resolve(answers);
		this.notify({ kind: 'questionResolved', id });
		return true;
	}
}
