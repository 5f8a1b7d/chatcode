/* eslint-disable header/header */
import './media/sessionsSearch.css';
import { $, addDisposableListener, append, clearNode, EventType } from '../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { KeyCode } from '../../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { AnythingQuickAccessProviderRunOptions, IQuickAccessRegistry, Extensions as QuickAccessExtensions } from '../../../../../platform/quickinput/common/quickAccess.js';
import { IQuickPick, QuickPickFocus } from '../../../../../platform/quickinput/common/quickInput.js';
import { IPickerQuickAccessItem, PickerQuickAccessProvider } from '../../../../../platform/quickinput/browser/pickerQuickAccess.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IAgentSessionsService } from '../../../chat/browser/agentSessions/agentSessionsService.js';
import { IAnythingQuickAccessContentProvider, IAnythingQuickPickItem, registerAnythingQuickAccessContentProvider } from '../../../search/browser/anythingQuickAccess.js';
import { sessionsSearchSources } from '../../common/sessionsSearch.js';
import { IThread, IThreadBranch, IThreadService, IThreadTurn } from '../../common/threads.js';
import { ISideChatOpener } from '../sideChat/sideChatOpener.js';

type SessionsViewMode = 'list' | 'columns';

interface IColumnsContext {
	readonly threads: HTMLElement;
	readonly branches: HTMLElement;
	readonly turns: HTMLElement;
	readonly preview: HTMLElement;
	readonly branchDisposables: DisposableStore;
	readonly turnDisposables: DisposableStore;
	readonly picker: IQuickPick<IAnythingQuickPickItem, { useSeparators: true }>;
	readonly token: CancellationToken;
}

class SessionsQuickAccessContentProvider extends Disposable implements IAnythingQuickAccessContentProvider {
	private viewMode: SessionsViewMode = 'list';
	private selectedThreadId: string | undefined;
	private selectedBranchId: string | undefined;
	private selectedTurnIndex: number | undefined;

	constructor(
		@IThreadService private readonly threadService: IThreadService,
		@ISideChatOpener private readonly sideChatOpener: ISideChatOpener,
		@IAgentSessionsService private readonly agentSessionsService: IAgentSessionsService,
		@ILogService private readonly logService: ILogService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
	}

	provide(picker: IQuickPick<IAnythingQuickPickItem, { useSeparators: true }>, token: CancellationToken, runOptions?: AnythingQuickAccessProviderRunOptions): IDisposable {
		if (!runOptions?.includeHelp || runOptions.from !== 'commandCenter') {
			return Disposable.None;
		}

		const disposables = new DisposableStore();
		const renderDisposables = disposables.add(new DisposableStore());
		const refreshCancellation = disposables.add(new MutableDisposable<CancellationTokenSource>());
		const root = $('.latent-sessions-quick-access');
		root.setAttribute('aria-label', localize('latent.sessions.quickAccessLabel', "Sessions"));
		const header = append(root, $('.latent-sessions-quick-access-header'));
		const heading = append(header, $('.latent-sessions-quick-access-title'));
		heading.textContent = localize('latent.sessions.quickAccessTitle', "Sessions");
		const modes = append(header, $('.latent-sessions-quick-access-modes'));
		modes.setAttribute('role', 'group');
		modes.setAttribute('aria-label', localize('latent.sessions.viewMode', "Sessions view mode"));
		const modeButtons = new Map<SessionsViewMode, HTMLButtonElement>();
		this.viewMode = this.storageService.get('latent.sessions.viewMode', StorageScope.WORKSPACE) === 'columns' ? 'columns' : 'list';
		for (const mode of ['list', 'columns'] as const) {
			const label = mode === 'list' ? localize('latent.sessions.list', "List") : localize('latent.sessions.columns', "Columns");
			const button = append(modes, $('button.latent-sessions-quick-access-mode')) as HTMLButtonElement;
			button.type = 'button';
			button.title = label;
			button.setAttribute('aria-label', label);
			append(button, $(`.codicon.${mode === 'list' ? 'codicon-list-flat' : 'codicon-layout'}`));
			modeButtons.set(mode, button);
		}
		const list = append(root, $('.latent-sessions-quick-access-list'));
		list.setAttribute('role', 'list');
		const columns = append(root, $('.latent-sessions-quick-access-columns'));
		const updateMode = () => {
			list.hidden = this.viewMode !== 'list';
			columns.hidden = this.viewMode !== 'columns';
			for (const [mode, button] of modeButtons) {
				button.setAttribute('aria-pressed', String(mode === this.viewMode));
			}
		};
		updateMode();
		const additionalContent = { element: root };
		picker.additionalContent = additionalContent;
		disposables.add(toDisposable(() => {
			if (picker.additionalContent === additionalContent) {
				picker.additionalContent = undefined;
			}
		}));

		let syncingSessions = false;
		const refresh = () => {
			if (syncingSessions || token.isCancellationRequested) {
				return;
			}
			refreshCancellation.value?.cancel();
			const source = new CancellationTokenSource(token);
			refreshCancellation.value = source;
			void this.render(picker.value.trim(), root, list, columns, picker, renderDisposables, source.token);
		};
		const syncSessions = () => {
			if (syncingSessions) {
				return;
			}
			syncingSessions = true;
			try {
				for (const session of this.agentSessionsService.model.sessions) {
					if (!this.threadService.getThreadBySession(session.resource)) {
						this.threadService.adoptSession(session.resource, {
							title: session.label,
							origin: session.providerType === 'local' ? 'workbench' : 'harness',
							createdAt: session.timing.created,
							updatedAt: session.timing.lastRequestEnded ?? session.timing.lastRequestStarted ?? session.timing.created,
						});
					}
				}
			} finally {
				syncingSessions = false;
			}
			refresh();
		};

		disposables.add(picker.onDidChangeValue(refresh));
		for (const [mode, button] of modeButtons) {
			disposables.add(addDisposableListener(button, EventType.CLICK, () => {
				if (this.viewMode === mode) {
					return;
				}
				this.viewMode = mode;
				this.storageService.store('latent.sessions.viewMode', mode, StorageScope.WORKSPACE, StorageTarget.USER);
				updateMode();
				refresh();
			}));
		}
		disposables.add(this.threadService.onDidChangeThreads(refresh));
		disposables.add(sessionsSearchSources.onDidChange(refresh));
		disposables.add(this.agentSessionsService.model.onDidChangeSessions(syncSessions));
		disposables.add(addDisposableListener(list, EventType.KEY_DOWN, event => this.handleKeyDown(event, root, picker)));
		void this.agentSessionsService.model.resolve(undefined).then(syncSessions, error => {
			this.logService.warn('[LatentSessions] Agent sessions could not be resolved.', error);
			refresh();
		});
		syncSessions();

		return disposables;
	}

	private async render(query: string, root: HTMLElement, list: HTMLElement, columns: HTMLElement, picker: IQuickPick<IAnythingQuickPickItem, { useSeparators: true }>, renderDisposables: DisposableStore, token: CancellationToken): Promise<void> {
		const threads = new Map<string, IThread>();
		for (const thread of this.threadService.listThreads({ query })) {
			threads.set(thread.id, thread);
		}
		for (const source of sessionsSearchSources.all()) {
			try {
				for (const thread of await source.search(query, token)) {
					threads.set(thread.id, thread);
				}
			} catch (error) {
				this.logService.warn(`[LatentSessions] Search source ${source.id} failed.`, error);
			}
		}
		if (token.isCancellationRequested) {
			return;
		}

		const sortedThreads = [...threads.values()].sort((a, b) => b.updatedAt - a.updatedAt);
		renderDisposables.clear();
		clearNode(list);
		clearNode(columns);
		root.hidden = sortedThreads.length === 0;
		if (this.viewMode === 'columns') {
			this.renderColumns(sortedThreads, columns, picker, renderDisposables, token);
			return;
		}
		for (const thread of sortedThreads) {
			const { row, title, detail } = this.createRow(list, thread.title || localize('latent.sessions.untitled', "New Thread"), thread.tabKey ? `${thread.origin} · ${thread.tabKey.resource.path.split('/').pop()}` : thread.origin);
			row.setAttribute('aria-label', `${title.textContent}, ${detail.textContent}`);
			renderDisposables.add(addDisposableListener(row, EventType.CLICK, () => {
				picker.hide();
				void this.sideChatOpener.open(thread.id, 'commandPalette');
			}));
		}
	}

	private renderColumns(threads: readonly IThread[], columns: HTMLElement, picker: IQuickPick<IAnythingQuickPickItem, { useSeparators: true }>, renderDisposables: DisposableStore, token: CancellationToken): void {
		const threadsColumn = append(columns, $('.latent-sessions-quick-access-column.threads'));
		const branchesColumn = append(columns, $('.latent-sessions-quick-access-column.branches'));
		const turnsColumn = append(columns, $('.latent-sessions-quick-access-column.turns'));
		const preview = append(columns, $('.latent-sessions-quick-access-preview'));
		threadsColumn.setAttribute('role', 'list');
		threadsColumn.setAttribute('aria-label', localize('latent.sessions.threads', "Threads"));
		branchesColumn.setAttribute('role', 'list');
		branchesColumn.setAttribute('aria-label', localize('latent.sessions.branches', "Branches"));
		turnsColumn.setAttribute('role', 'list');
		turnsColumn.setAttribute('aria-label', localize('latent.sessions.turns', "Turns"));
		preview.setAttribute('role', 'region');
		preview.setAttribute('aria-label', localize('latent.sessions.preview', "Preview"));

		const context: IColumnsContext = {
			threads: threadsColumn,
			branches: branchesColumn,
			turns: turnsColumn,
			preview,
			branchDisposables: renderDisposables.add(new DisposableStore()),
			turnDisposables: renderDisposables.add(new DisposableStore()),
			picker,
			token,
		};
		for (const thread of threads) {
			const { row } = this.createRow(threadsColumn, thread.title || localize('latent.sessions.untitled', "New Thread"), thread.tabKey ? `${thread.origin} · ${thread.tabKey.resource.path.split('/').pop()}` : thread.origin);
			row.dataset.threadId = thread.id;
			renderDisposables.add(addDisposableListener(row, EventType.CLICK, () => void this.selectThread(thread, context)));
			this.registerOpenGesture(row, renderDisposables, () => this.openThread(picker, thread.id));
		}

		const selected = threads.find(thread => thread.id === this.selectedThreadId) ?? threads[0];
		if (selected) {
			void this.selectThread(selected, context);
		}
	}

	private async selectThread(thread: IThread, context: IColumnsContext): Promise<void> {
		if (context.token.isCancellationRequested) {
			return;
		}
		this.selectedThreadId = thread.id;
		this.selectedBranchId = thread.branches.some(branch => branch.id === this.selectedBranchId) ? this.selectedBranchId : thread.activeBranchId;
		this.selectedTurnIndex = undefined;
		this.updateSelectedRows(context.threads, 'threadId', thread.id);
		context.branchDisposables.clear();
		context.turnDisposables.clear();
		clearNode(context.branches);
		clearNode(context.turns);
		clearNode(context.preview);

		for (const branch of thread.branches) {
			const createdAt = new Date(branch.createdAt).toLocaleString();
			const { row, detail } = this.createRow(context.branches, branch.label, createdAt);
			row.dataset.branchId = branch.id;
			context.branchDisposables.add(addDisposableListener(row, EventType.CLICK, () => void this.selectBranch(thread, branch, context)));
			this.registerOpenGesture(row, context.branchDisposables, () => this.openThread(context.picker, thread.id, branch.id));
			void this.threadService.getTurns(thread.id, branch.id).then(turns => {
				if (!context.token.isCancellationRequested && this.selectedThreadId === thread.id && detail.isConnected) {
					detail.textContent = localize('latent.sessions.branchDetail', "{0} turns · {1}", turns.filter(turn => turn.role === 'user').length, createdAt);
				}
			});
		}

		const branch = thread.branches.find(candidate => candidate.id === this.selectedBranchId) ?? thread.branches[0];
		if (branch) {
			await this.selectBranch(thread, branch, context);
		}
	}

	private async selectBranch(thread: IThread, branch: IThreadBranch, context: IColumnsContext): Promise<void> {
		this.selectedBranchId = branch.id;
		this.selectedTurnIndex = undefined;
		this.updateSelectedRows(context.branches, 'branchId', branch.id);
		context.turnDisposables.clear();
		clearNode(context.turns);
		clearNode(context.preview);
		const turns = await this.threadService.getTurns(thread.id, branch.id);
		if (context.token.isCancellationRequested || this.selectedThreadId !== thread.id || this.selectedBranchId !== branch.id) {
			return;
		}
		for (const turn of turns) {
			const title = `${turn.role === 'user' ? localize('latent.sessions.you', "You") : localize('latent.sessions.assistant', "Assistant")} · ${turn.index + 1}`;
			const { row } = this.createRow(context.turns, title, turn.text.replace(/\s+/g, ' ').slice(0, 120));
			row.dataset.turnIndex = String(turn.index);
			context.turnDisposables.add(addDisposableListener(row, EventType.CLICK, () => this.selectTurn(turn, context)));
			this.registerOpenGesture(row, context.turnDisposables, () => this.openThread(context.picker, thread.id, branch.id));
		}
		const turn = turns.find(candidate => candidate.index === this.selectedTurnIndex) ?? turns[0];
		if (turn) {
			this.selectTurn(turn, context);
		}
	}

	private selectTurn(turn: IThreadTurn, context: IColumnsContext): void {
		this.selectedTurnIndex = turn.index;
		this.updateSelectedRows(context.turns, 'turnIndex', String(turn.index));
		clearNode(context.preview);
		append(context.preview, $('.role')).textContent = turn.role === 'user' ? localize('latent.sessions.you', "You") : localize('latent.sessions.assistant', "Assistant");
		append(context.preview, $('.time')).textContent = new Date(turn.timestamp).toLocaleString();
		append(context.preview, $('pre.text')).textContent = turn.text;
		if (turn.attachments.length) {
			const attachments = append(context.preview, $('ul.attachments'));
			turn.attachments.forEach((attachment, index) => append(attachments, $('li')).textContent = `#${index + 1} ${attachment.name}`);
		}
	}

	private createRow(container: HTMLElement, titleText: string, detailText: string): { row: HTMLButtonElement; title: HTMLElement; detail: HTMLElement } {
		const row = append(container, $('button.latent-sessions-quick-access-row')) as HTMLButtonElement;
		row.type = 'button';
		row.setAttribute('role', 'listitem');
		const title = append(row, $('.title'));
		title.textContent = titleText;
		const detail = append(row, $('.detail'));
		detail.textContent = detailText;
		return { row, title, detail };
	}

	private updateSelectedRows(container: HTMLElement, dataKey: 'threadId' | 'branchId' | 'turnIndex', value: string): void {
		for (const row of container.querySelectorAll<HTMLButtonElement>('.latent-sessions-quick-access-row')) {
			const selected = row.dataset[dataKey] === value;
			row.classList.toggle('selected', selected);
			row.setAttribute('aria-pressed', String(selected));
		}
	}

	private registerOpenGesture(button: HTMLButtonElement, disposables: DisposableStore, open: () => Promise<void>): void {
		disposables.add(addDisposableListener(button, EventType.DBLCLICK, event => {
			event.preventDefault();
			void open();
		}));
		disposables.add(addDisposableListener(button, EventType.KEY_DOWN, event => {
			if (new StandardKeyboardEvent(event).keyCode === KeyCode.Enter) {
				event.preventDefault();
				void open();
			}
		}));
	}

	private async openThread(picker: IQuickPick<IAnythingQuickPickItem, { useSeparators: true }>, threadId: string, branchId?: string): Promise<void> {
		picker.hide();
		if (branchId) {
			await this.threadService.setActiveBranch(threadId, branchId);
		}
		await this.sideChatOpener.open(threadId, 'commandPalette');
	}

	private handleKeyDown(event: KeyboardEvent, root: HTMLElement, picker: IQuickPick<IAnythingQuickPickItem, { useSeparators: true }>): void {
		if (event.altKey || event.ctrlKey || event.metaKey) {
			return;
		}
		const keyboardEvent = new StandardKeyboardEvent(event);
		const rows = [...root.querySelectorAll<HTMLButtonElement>('.latent-sessions-quick-access-row')];
		if (!rows.length) {
			return;
		}
		const focusedIndex = rows.indexOf(root.ownerDocument.activeElement as HTMLButtonElement);
		if (keyboardEvent.keyCode === KeyCode.DownArrow && focusedIndex >= 0) {
			event.preventDefault();
			event.stopPropagation();
			if (focusedIndex < rows.length - 1) {
				rows[focusedIndex + 1].focus();
			} else {
				picker.focus(QuickPickFocus.First);
				picker.focusOnInput();
			}
		} else if (keyboardEvent.keyCode === KeyCode.UpArrow && focusedIndex >= 0) {
			event.preventDefault();
			event.stopPropagation();
			if (focusedIndex > 0) {
				rows[focusedIndex - 1].focus();
			} else {
				picker.focusOnInput();
			}
		}
	}
}

/** `thread ` quick access lists all Threads and opens the chosen one as Side Chat. */
class ThreadsQuickAccessProvider extends PickerQuickAccessProvider<IPickerQuickAccessItem> {
	static readonly PREFIX = 'thread ';

	constructor(
		@IThreadService private readonly threadService: IThreadService,
		@ISideChatOpener private readonly sideChatOpener: ISideChatOpener,
	) {
		super(ThreadsQuickAccessProvider.PREFIX);
	}

	protected _getPicks(filter: string): IPickerQuickAccessItem[] {
		return this.threadService.listThreads({ query: filter }).map(thread => ({
			label: thread.title,
			description: thread.tabKey ? thread.tabKey.resource.path.split('/').pop() : thread.origin,
			detail: localize('latent.thread.branchCount', "{0} branches · {1}", thread.branches.length, new Date(thread.updatedAt).toLocaleString()),
			accept: () => void this.sideChatOpener.open(thread.id, 'commandPalette'),
		}));
	}
}

registerAnythingQuickAccessContentProvider(SessionsQuickAccessContentProvider);

Registry.as<IQuickAccessRegistry>(QuickAccessExtensions.Quickaccess).registerQuickAccessProvider({
	ctor: ThreadsQuickAccessProvider,
	prefix: ThreadsQuickAccessProvider.PREFIX,
	placeholder: localize('latent.thread.quickAccessPlaceholder', "Search threads by title, message, or file"),
	helpEntries: [{ description: localize('latent.thread.quickAccessHelp', "Search Threads"), commandId: 'latent.thread.search' }],
});
