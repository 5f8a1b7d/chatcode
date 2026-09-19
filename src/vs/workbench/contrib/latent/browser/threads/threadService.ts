/* eslint-disable header/header */
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableMap } from '../../../../../base/common/lifecycle.js';
import { isEqual } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IChatModelReference, IChatService } from '../../../chat/common/chatService/chatService.js';
import { IChatModel, IChatRequestModel } from '../../../chat/common/model/chatModel.js';
import { ChatAgentLocation } from '../../../chat/common/constants.js';
import { IEditTurnResult, IThread, IThreadBranch, IThreadService, IThreadTurn, IThreadVersionInfo, ThreadOrigin } from '../../common/threads.js';
import { ITabKey, tabKeyEquals, tabKeyFromJSON, tabKeyHash, tabKeyToJSON } from '../../common/tabKey.js';

const storageKey = 'latent.threads.v1';

interface ISerializedBranch {
	id: string;
	sessionResource: string;
	parentBranchId?: string;
	forkTurnIndex?: number;
	createdAt: number;
	label: string;
}

interface ISerializedThread {
	id: string;
	title: string;
	tabKey?: { groupId: number; typeId: string; resource: string };
	origin: ThreadOrigin;
	createdAt: number;
	updatedAt: number;
	activeBranchId: string;
	branches: ISerializedBranch[];
}

interface ISerializedState {
	version: 1;
	threads: ISerializedThread[];
	activeByTab: Record<string, string>;
}

class ThreadRecord implements IThread {
	constructor(
		readonly id: string,
		public title: string,
		public tabKey: ITabKey | undefined,
		readonly origin: ThreadOrigin,
		readonly createdAt: number,
		public updatedAt: number,
		public activeBranchId: string,
		public branches: IThreadBranch[],
	) { }
}

/**
 * Owns the Thread tree (P1-FR-060..065). Every Branch is a separate upstream
 * chat session; editing a Turn copies the prefix into a new session so the
 * original session is never rewritten.
 */
export class ThreadService extends Disposable implements IThreadService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeThreads = this._register(new Emitter<void>());
	readonly onDidChangeThreads: Event<void> = this._onDidChangeThreads.event;
	private readonly _onDidChangeActiveBranch = this._register(new Emitter<{ readonly threadId: string; readonly branchId: string }>());
	readonly onDidChangeActiveBranch = this._onDidChangeActiveBranch.event;

	private readonly threads = new Map<string, ThreadRecord>();
	private readonly activeByTab = new Map<string, string>();
	/** Sessions this service created; holding the reference keeps them alive. */
	private readonly ownedSessions = this._register(new DisposableMap<string, IChatModelReference>());

	constructor(
		@IChatService private readonly chatService: IChatService,
		@IStorageService private readonly storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.load();
		this._register(this.chatService.onDidSubmitRequest(event => {
			const thread = this.getThreadBySession(event.chatSessionResource);
			if (thread) {
				thread.updatedAt = Date.now();
				const title = this.chatService.getSessionTitle(event.chatSessionResource);
				if (title) {
					thread.title = title;
				}
				this.save();
			}
		}));
		this._register(this.chatService.onDidDisposeSession(event => {
			let changed = false;
			for (const thread of [...this.threads.values()]) {
				const remaining = thread.branches.filter(branch => !event.sessionResources.some(resource => isEqual(resource, branch.sessionResource)));
				if (remaining.length !== thread.branches.length) {
					changed = true;
					if (remaining.length === 0) {
						this.threads.delete(thread.id);
					} else {
						thread.branches = remaining;
						if (!remaining.some(branch => branch.id === thread.activeBranchId)) {
							thread.activeBranchId = remaining[remaining.length - 1].id;
						}
					}
				}
			}
			if (changed) {
				this.save();
			}
		}));
	}

	async createThread(options?: { tabKey?: ITabKey; title?: string; origin?: ThreadOrigin; createdAt?: number; updatedAt?: number }): Promise<IThread> {
		const reference = this.chatService.startNewLocalSession(ChatAgentLocation.Chat, { debugOwner: 'LatentThreadService#createThread' });
		const thread = this.register(reference.object.sessionResource, options);
		this.ownedSessions.set(reference.object.sessionResource.toString(), reference);
		if (options?.tabKey) {
			this.setActiveThread(options.tabKey, thread.id);
		}
		return thread;
	}

	adoptSession(sessionResource: URI, options?: { tabKey?: ITabKey; title?: string; origin?: ThreadOrigin; createdAt?: number; updatedAt?: number }): IThread {
		if (!this.ownedSessions.has(sessionResource.toString())) {
			const reference = this.chatService.acquireExistingSession(sessionResource, 'LatentThreadService#adoptSession');
			if (reference) { this.ownedSessions.set(sessionResource.toString(), reference); }
		}
		const existing = this.getThreadBySession(sessionResource);
		if (existing) {
			if (options?.tabKey && !existing.tabKey) {
				existing.tabKey = options.tabKey;
				this.save();
			}
			return existing;
		}
		return this.register(sessionResource, options);
	}

	private register(sessionResource: URI, options?: { tabKey?: ITabKey; title?: string; origin?: ThreadOrigin; createdAt?: number; updatedAt?: number }): ThreadRecord {
		const now = Date.now();
		const branch: IThreadBranch = { id: generateUuid(), sessionResource, parentBranchId: undefined, forkTurnIndex: undefined, createdAt: now, label: localize('latent.thread.rootBranch', "Original") };
		const thread = new ThreadRecord(generateUuid(), options?.title || this.chatService.getSessionTitle(sessionResource) || localize('latent.thread.untitled', "New Thread"), options?.tabKey, options?.origin ?? 'workbench', options?.createdAt ?? now, options?.updatedAt ?? now, branch.id, [branch]);
		this.threads.set(thread.id, thread);
		this.save();
		return thread;
	}

	getThread(threadId: string): IThread | undefined {
		return this.threads.get(threadId);
	}

	getThreadBySession(sessionResource: URI): ThreadRecord | undefined {
		for (const thread of this.threads.values()) {
			if (thread.branches.some(branch => isEqual(branch.sessionResource, sessionResource))) {
				return thread;
			}
		}
		return undefined;
	}

	listThreads(filter?: { tabKey?: ITabKey; query?: string }): readonly IThread[] {
		const query = filter?.query?.trim().toLowerCase();
		return [...this.threads.values()]
			.filter(thread => !filter?.tabKey || tabKeyEquals(thread.tabKey, filter.tabKey))
			.filter(thread => !query || this.matches(thread, query))
			.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	private matches(thread: ThreadRecord, query: string): boolean {
		if (thread.title.toLowerCase().includes(query) || thread.tabKey?.resource.path.toLowerCase().includes(query)) {
			return true;
		}
		for (const branch of thread.branches) {
			const session = this.chatService.getSession(branch.sessionResource);
			if (session?.getRequests().some(request => request.message.text.toLowerCase().includes(query) || request.response?.response.toString().toLowerCase().includes(query))) {
				return true;
			}
		}
		return false;
	}

	getBranch(threadId: string, branchId: string): IThreadBranch | undefined {
		return this.threads.get(threadId)?.branches.find(branch => branch.id === branchId);
	}

	getActiveBranch(threadId: string): IThreadBranch | undefined {
		const thread = this.threads.get(threadId);
		return thread && this.getBranch(threadId, thread.activeBranchId);
	}

	async getTurns(threadId: string, branchId?: string): Promise<readonly IThreadTurn[]> {
		const thread = this.threads.get(threadId);
		const branch = thread && this.getBranch(threadId, branchId ?? thread.activeBranchId);
		if (!branch) {
			return [];
		}
		const session = await this.resolveSession(branch.sessionResource);
		if (!session) {
			return [];
		}
		const turns: IThreadTurn[] = [];
		session.getRequests().forEach((request: IChatRequestModel, index: number) => {
			turns.push({ index, requestId: request.id, role: 'user', text: request.message.text, timestamp: request.timestamp, attachments: request.attachedContext ?? [] });
			if (request.response) {
				turns.push({ index, requestId: request.id, role: 'assistant', text: request.response.response.toString(), timestamp: request.response.timestamp, attachments: [] });
			}
		});
		return turns;
	}

	getVersions(threadId: string, branchId: string, turnIndex: number): IThreadVersionInfo {
		const thread = this.threads.get(threadId);
		const branch = thread && this.getBranch(threadId, branchId);
		if (!thread || !branch) {
			return { versions: [], currentIndex: -1 };
		}
		const owner = this.ownerOfTurn(thread, branch, turnIndex);
		const versions = [owner, ...thread.branches.filter(candidate => candidate.parentBranchId === owner.id && candidate.forkTurnIndex === turnIndex).sort((a, b) => a.createdAt - b.createdAt)].map(candidate => candidate.id);
		let cursor: IThreadBranch | undefined = branch;
		while (cursor && !versions.includes(cursor.id)) {
			cursor = cursor.parentBranchId ? this.getBranch(threadId, cursor.parentBranchId) : undefined;
		}
		return { versions, currentIndex: cursor ? versions.indexOf(cursor.id) : 0 };
	}

	/** The branch whose session owns the Turn at `turnIndex` along `branch`'s lineage. */
	private ownerOfTurn(thread: ThreadRecord, branch: IThreadBranch, turnIndex: number): IThreadBranch {
		let cursor = branch;
		while (cursor.forkTurnIndex !== undefined && turnIndex <= cursor.forkTurnIndex) {
			const parent = cursor.parentBranchId ? thread.branches.find(candidate => candidate.id === cursor.parentBranchId) : undefined;
			if (!parent) {
				break;
			}
			cursor = parent;
		}
		return cursor;
	}

	async editTurn(threadId: string, branchId: string, turnIndex: number): Promise<IEditTurnResult> {
		const thread = this.threads.get(threadId);
		const branch = thread && this.getBranch(threadId, branchId);
		if (!thread || !branch) {
			throw new Error(localize('latent.thread.missing', "The thread or branch no longer exists."));
		}
		const session = await this.resolveSession(branch.sessionResource);
		const request = session?.getRequests()[turnIndex];
		if (!session || !request) {
			throw new Error(localize('latent.thread.missingTurn', "The message to edit no longer exists."));
		}
		// Export-only data is treated as an imported transcript and excluded from
		// the upstream session store. A branch must be an independently saved session.
		const data = session.toJSON();
		data.sessionId = generateUuid();
		data.creationDate = Date.now();
		data.customTitle = undefined;
		data.inputState = undefined;
		data.pendingRequests = undefined;
		data.requests = data.requests.slice(0, turnIndex);
		const reference = this.chatService.loadSessionFromData(data, 'LatentThreadService#editTurn');
		this.ownedSessions.set(reference.object.sessionResource.toString(), reference);
		const owner = this.ownerOfTurn(thread, branch, turnIndex);
		const siblingCount = thread.branches.filter(candidate => candidate.parentBranchId === owner.id && candidate.forkTurnIndex === turnIndex).length;
		const newBranch: IThreadBranch = {
			id: generateUuid(),
			sessionResource: reference.object.sessionResource,
			parentBranchId: owner.id,
			forkTurnIndex: turnIndex,
			createdAt: Date.now(),
			label: localize('latent.thread.versionLabel', "Version {0} of message {1}", siblingCount + 2, turnIndex + 1),
		};
		thread.branches.push(newBranch);
		thread.activeBranchId = newBranch.id;
		thread.updatedAt = newBranch.createdAt;
		this.save();
		this._onDidChangeActiveBranch.fire({ threadId, branchId: newBranch.id });
		return { thread, branch: newBranch, text: request.message.text, attachments: request.attachedContext ?? [] };
	}

	async switchVersion(threadId: string, branchId: string, turnIndex: number, direction: 'previous' | 'next'): Promise<IThreadBranch | undefined> {
		const info = this.getVersions(threadId, branchId, turnIndex);
		const target = info.versions[info.currentIndex + (direction === 'next' ? 1 : -1)];
		if (!target) {
			return undefined;
		}
		const targetBranch = this.leafOf(threadId, target, turnIndex);
		await this.setActiveBranch(threadId, targetBranch.id);
		return targetBranch;
	}

	/** The most recently active descendant of `branchId` that does not fork the same Turn again (P1-FR-062). */
	private leafOf(threadId: string, branchId: string, turnIndex: number): IThreadBranch {
		const thread = this.threads.get(threadId)!;
		let current = this.getBranch(threadId, branchId)!;
		for (; ;) {
			const children = thread.branches.filter(candidate => candidate.parentBranchId === current.id && candidate.forkTurnIndex !== undefined && candidate.forkTurnIndex > turnIndex).sort((a, b) => b.createdAt - a.createdAt);
			if (!children.length) {
				return current;
			}
			current = children[0];
		}
	}

	async setActiveBranch(threadId: string, branchId: string): Promise<void> {
		const thread = this.threads.get(threadId);
		if (!thread || !this.getBranch(threadId, branchId) || thread.activeBranchId === branchId) {
			return;
		}
		thread.activeBranchId = branchId;
		this.save();
		this._onDidChangeActiveBranch.fire({ threadId, branchId });
	}

	async pruneEmptyBranch(threadId: string, branchId: string): Promise<boolean> {
		const thread = this.threads.get(threadId);
		const branch = thread && this.getBranch(threadId, branchId);
		if (!thread || !branch || branch.forkTurnIndex === undefined) {
			return false;
		}
		const session = this.chatService.getSession(branch.sessionResource);
		if (session && session.getRequests().length > branch.forkTurnIndex) {
			return false;
		}
		thread.branches = thread.branches.filter(candidate => candidate.id !== branchId);
		if (thread.activeBranchId === branchId) {
			thread.activeBranchId = branch.parentBranchId ?? thread.branches[0].id;
			this._onDidChangeActiveBranch.fire({ threadId, branchId: thread.activeBranchId });
		}
		this.ownedSessions.deleteAndDispose(branch.sessionResource.toString());
		this.save();
		return true;
	}

	setTitle(threadId: string, title: string): void {
		const thread = this.threads.get(threadId);
		if (thread && thread.title !== title) {
			thread.title = title;
			this.save();
		}
	}

	async deleteThread(threadId: string): Promise<void> {
		const thread = this.threads.get(threadId);
		if (!thread) {
			return;
		}
		for (const branch of thread.branches) {
			this.ownedSessions.deleteAndDispose(branch.sessionResource.toString());
		}
		this.threads.delete(threadId);
		for (const [tab, id] of [...this.activeByTab]) {
			if (id === threadId) {
				this.activeByTab.delete(tab);
			}
		}
		this.save();
	}

	setActiveThread(tabKey: ITabKey, threadId: string): void {
		const thread = this.threads.get(threadId);
		if (!thread) {
			return;
		}
		if (!thread.tabKey) {
			thread.tabKey = tabKey;
		}
		this.activeByTab.set(tabKeyHash(tabKey), threadId);
		this.save();
	}

	getActiveThread(tabKey: ITabKey): IThread | undefined {
		const id = this.activeByTab.get(tabKeyHash(tabKey));
		return id ? this.threads.get(id) : undefined;
	}

	rekey(from: ITabKey, to: ITabKey): void {
		if (tabKeyEquals(from, to)) {
			return;
		}
		const active = this.activeByTab.get(tabKeyHash(from));
		this.activeByTab.delete(tabKeyHash(from));
		if (active) {
			this.activeByTab.set(tabKeyHash(to), active);
		}
		for (const thread of this.threads.values()) {
			if (tabKeyEquals(thread.tabKey, from)) {
				thread.tabKey = to;
			}
		}
		this.save();
	}

	private async resolveSession(sessionResource: URI): Promise<IChatModel | undefined> {
		const loaded = this.chatService.getSession(sessionResource);
		if (loaded && this.ownedSessions.has(sessionResource.toString())) {
			return loaded;
		}
		try {
			const reference = await this.chatService.acquireOrLoadSession(sessionResource, ChatAgentLocation.Chat, CancellationToken.None, 'LatentThreadService#resolveSession');
			if (reference) {
				this.ownedSessions.set(sessionResource.toString(), reference);
				return reference.object;
			}
		} catch (error) {
			this.logService.warn('[LatentThreads] Unable to load a branch session.', error);
		}
		return undefined;
	}

	private load(): void {
		const raw = this.storageService.get(storageKey, StorageScope.PROFILE);
		if (!raw) {
			return;
		}
		try {
			const state: ISerializedState = JSON.parse(raw);
			for (const thread of state.threads ?? []) {
				this.threads.set(thread.id, new ThreadRecord(
					thread.id,
					thread.title,
					thread.tabKey ? tabKeyFromJSON(thread.tabKey) : undefined,
					thread.origin,
					thread.createdAt,
					thread.updatedAt,
					thread.activeBranchId,
					thread.branches.map((branch): IThreadBranch => ({ id: branch.id, parentBranchId: branch.parentBranchId, forkTurnIndex: branch.forkTurnIndex, createdAt: branch.createdAt, label: branch.label, sessionResource: URI.parse(branch.sessionResource) })),
				));
			}
			for (const [tab, id] of Object.entries(state.activeByTab ?? {})) {
				this.activeByTab.set(tab, id);
			}
		} catch (error) {
			this.logService.error('[LatentThreads] Thread store is corrupt; starting empty.', error);
			this.storageService.store(storageKey + '.corrupt', raw, StorageScope.PROFILE, StorageTarget.MACHINE);
		}
	}

	private save(): void {
		const state: ISerializedState = {
			version: 1,
			threads: [...this.threads.values()].map(thread => ({
				id: thread.id,
				title: thread.title,
				tabKey: thread.tabKey ? tabKeyToJSON(thread.tabKey) : undefined,
				origin: thread.origin,
				createdAt: thread.createdAt,
				updatedAt: thread.updatedAt,
				activeBranchId: thread.activeBranchId,
				branches: thread.branches.map(branch => ({ ...branch, sessionResource: branch.sessionResource.toString() })),
			})),
			activeByTab: Object.fromEntries(this.activeByTab),
		};
		this.storageService.store(storageKey, JSON.stringify(state), StorageScope.PROFILE, StorageTarget.MACHINE);
		this._onDidChangeThreads.fire();
	}
}
