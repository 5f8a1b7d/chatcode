/* eslint-disable header/header */
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IThread } from './threads.js';

/** Additional Thread sources for Sessions search (harness sessions, runtime sessions). */
export interface ISessionsSearchSource {
	readonly id: string;
	readonly onDidChange?: Event<void>;
	search(query: string, token: CancellationToken): Promise<readonly IThread[]>;
}

class SessionsSearchSourceRegistry {
	private readonly sources = new Map<string, ISessionsSearchSource>();
	private readonly _onDidChange = new Emitter<void>();
	readonly onDidChange = this._onDidChange.event;

	register(source: ISessionsSearchSource): IDisposable {
		this.sources.set(source.id, source);
		this._onDidChange.fire();
		return toDisposable(() => {
			if (this.sources.get(source.id) === source) {
				this.sources.delete(source.id);
				this._onDidChange.fire();
			}
		});
	}

	all(): readonly ISessionsSearchSource[] {
		return [...this.sources.values()];
	}
}

export const sessionsSearchSources = new SessionsSearchSourceRegistry();
