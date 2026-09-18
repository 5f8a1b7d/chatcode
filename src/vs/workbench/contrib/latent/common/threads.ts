/* eslint-disable header/header */
import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IChatRequestVariableEntry } from '../../chat/common/attachments/chatVariableEntries.js';
import { ITabKey } from './tabKey.js';

export type ThreadOrigin = 'workbench' | 'harness' | 'runtime';

/**
 * A Branch is one root-to-leaf path of a Thread. Every Branch is backed by its
 * own upstream chat session that contains the full prefix copied at the fork
 * point, so the session is self-contained and the original history is never
 * rewritten (P1-FR-061).
 */
export interface IThreadBranch {
	readonly id: string;
	readonly sessionResource: URI;
	/** The branch that owns the Turn this branch was forked from; undefined for the root branch. */
	readonly parentBranchId: string | undefined;
	/** Index of the user Turn that was edited to create this branch; undefined for the root branch. */
	readonly forkTurnIndex: number | undefined;
	readonly createdAt: number;
	readonly label: string;
}

export interface IThread {
	readonly id: string;
	readonly title: string;
	readonly tabKey: ITabKey | undefined;
	readonly origin: ThreadOrigin;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly activeBranchId: string;
	readonly branches: readonly IThreadBranch[];
}

export interface IThreadTurn {
	readonly index: number;
	readonly requestId: string;
	readonly role: 'user' | 'assistant';
	readonly text: string;
	readonly timestamp: number;
	readonly attachments: readonly IChatRequestVariableEntry[];
}

export interface IThreadVersionInfo {
	/** Ordered branch ids that hold a Version of the same user Turn. */
	readonly versions: readonly string[];
	readonly currentIndex: number;
}

export interface IEditTurnResult {
	readonly thread: IThread;
	readonly branch: IThreadBranch;
	/** The original text and attachments, to prefill the composer. */
	readonly text: string;
	readonly attachments: readonly IChatRequestVariableEntry[];
}

export const IThreadService = createDecorator<IThreadService>('latentThreadService');

export interface IThreadService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeThreads: Event<void>;
	readonly onDidChangeActiveBranch: Event<{ readonly threadId: string; readonly branchId: string }>;

	createThread(options?: { tabKey?: ITabKey; title?: string; origin?: ThreadOrigin }): Promise<IThread>;
	/** Adopts an existing chat session as a single-branch Thread (idempotent by session resource). */
	adoptSession(sessionResource: URI, options?: { tabKey?: ITabKey; title?: string; origin?: ThreadOrigin }): IThread;
	getThread(threadId: string): IThread | undefined;
	getThreadBySession(sessionResource: URI): IThread | undefined;
	listThreads(filter?: { tabKey?: ITabKey; query?: string }): readonly IThread[];
	getBranch(threadId: string, branchId: string): IThreadBranch | undefined;
	getActiveBranch(threadId: string): IThreadBranch | undefined;
	getTurns(threadId: string, branchId?: string): Promise<readonly IThreadTurn[]>;
	/** Versions of the user Turn at `turnIndex` on `branchId` (P1-FR-062). */
	getVersions(threadId: string, branchId: string, turnIndex: number): IThreadVersionInfo;
	/** Creates a new Branch forked before `turnIndex` and makes it active. Never mutates existing Turns. */
	editTurn(threadId: string, branchId: string, turnIndex: number): Promise<IEditTurnResult>;
	switchVersion(threadId: string, branchId: string, turnIndex: number, direction: 'previous' | 'next'): Promise<IThreadBranch | undefined>;
	setActiveBranch(threadId: string, branchId: string): Promise<void>;
	/** Drops a branch whose session never received a request after the fork (cancelled edit, P1-FR-063). */
	pruneEmptyBranch(threadId: string, branchId: string): Promise<boolean>;
	setTitle(threadId: string, title: string): void;
	deleteThread(threadId: string): Promise<void>;

	setActiveThread(tabKey: ITabKey, threadId: string): void;
	getActiveThread(tabKey: ITabKey): IThread | undefined;
	rekey(from: ITabKey, to: ITabKey): void;
}
