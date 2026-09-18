/* eslint-disable header/header */
import './media/sessionsSearch.css';
import { $, append, clearNode } from '../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { InputBox } from '../../../../../base/browser/ui/inputbox/inputBox.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { KeyCode } from '../../../../../base/common/keyCodes.js';
import { DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService, IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { WorkbenchList } from '../../../../../platform/list/browser/listService.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IQuickAccessRegistry, Extensions as QuickAccessExtensions } from '../../../../../platform/quickinput/common/quickAccess.js';
import { IPickerQuickAccessItem, PickerQuickAccessProvider } from '../../../../../platform/quickinput/browser/pickerQuickAccess.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { defaultInputBoxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { ViewPane } from '../../../../browser/parts/views/viewPane.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewDescriptor, IViewDescriptorService, IViewsRegistry } from '../../../../common/views.js';
import { VIEWLET_ID as SearchViewletId } from '../../../../services/search/common/search.js';
import { ISideChatOpener } from '../sideChat/sideChatOpener.js';
import { sessionsSearchSources } from '../../common/sessionsSearch.js';
import { IThread, IThreadBranch, IThreadService, IThreadTurn } from '../../common/threads.js';
import { LatentSessionsSearchViewId } from '../threads/threadActions.js';

const COLUMN_ROW_HEIGHT = 44;

interface IThreadRow { readonly kind: 'thread'; readonly thread: IThread; readonly day: string }
interface IBranchRow { readonly kind: 'branch'; readonly branch: IThreadBranch; readonly turnCount: number }
interface ITurnRow { readonly kind: 'turn'; readonly turn: IThreadTurn }
type Row = IThreadRow | IBranchRow | ITurnRow;

interface IRowTemplate { readonly root: HTMLElement; readonly title: HTMLElement; readonly detail: HTMLElement }

class RowDelegate implements IListVirtualDelegate<Row> {
	getHeight(): number { return COLUMN_ROW_HEIGHT; }
	getTemplateId(): string { return 'latent.sessions.row'; }
}

class RowRenderer implements IListRenderer<Row, IRowTemplate> {
	readonly templateId = 'latent.sessions.row';

	renderTemplate(container: HTMLElement): IRowTemplate {
		const root = append(container, $('.latent-sessions-row'));
		const title = append(root, $('.title'));
		const detail = append(root, $('.detail'));
		return { root, title, detail };
	}

	renderElement(row: Row, _index: number, template: IRowTemplate): void {
		template.root.className = `latent-sessions-row ${row.kind}`;
		if (row.kind === 'thread') {
			template.title.textContent = row.thread.title;
			template.detail.textContent = row.thread.tabKey ? `${row.thread.origin} · ${row.thread.tabKey.resource.path.split('/').pop()}` : row.thread.origin;
		} else if (row.kind === 'branch') {
			template.title.textContent = row.branch.label;
			template.detail.textContent = localize('latent.sessions.branchDetail', "{0} turns · {1}", row.turnCount, new Date(row.branch.createdAt).toLocaleString());
		} else {
			template.title.textContent = `${row.turn.role === 'user' ? localize('latent.sessions.you', "You") : localize('latent.sessions.assistant', "Assistant")} · ${row.turn.index + 1}`;
			template.detail.textContent = row.turn.text.replace(/\s+/g, ' ').slice(0, 120);
		}
	}

	disposeTemplate(): void { }
}

/** Sessions as a top-level search entry with a Finder-style column view (P1-FR-070..073). */
export class SessionsSearchView extends ViewPane {

	private input!: InputBox;
	private threadsList!: WorkbenchList<Row>;
	private branchesList!: WorkbenchList<Row>;
	private turnsList!: WorkbenchList<Row>;
	private preview!: HTMLElement;
	private columns!: HTMLElement;
	private readonly searchCancellation = this._register(new MutableDisposable<CancellationTokenSource>());
	private readonly listeners = this._register(new DisposableStore());
	private selectedThread: IThread | undefined;
	private selectedBranch: IThreadBranch | undefined;

	constructor(
		options: { id: string; title: string },
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IThreadService private readonly threadService: IThreadService,
		@ISideChatOpener private readonly sideChatOpener: ISideChatOpener,
		@ILogService private readonly logService: ILogService,
	) {
		super({ ...options, titleMenuId: undefined }, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('latent-sessions-search');
		const header = append(container, $('.latent-sessions-header'));
		this.input = this._register(new InputBox(header, this.contextViewService, { placeholder: localize('latent.sessions.placeholder', "Search threads, messages, files, and bots"), inputBoxStyles: defaultInputBoxStyles }));
		this._register(this.input.onDidChange(() => this.refresh()));
		this.columns = append(container, $('.latent-sessions-columns'));
		const threadsContainer = append(this.columns, $('.column.threads'));
		const branchesContainer = append(this.columns, $('.column.branches'));
		const turnsContainer = append(this.columns, $('.column.turns'));
		this.preview = append(this.columns, $('.preview'));
		this.threadsList = this._register(this.instantiationService.createInstance(WorkbenchList<Row>, 'LatentSessionsThreads', threadsContainer, new RowDelegate(), [new RowRenderer()], { multipleSelectionSupport: false, accessibilityProvider: rowAccessibility(localize('latent.sessions.threads', "Threads")) }));
		this.branchesList = this._register(this.instantiationService.createInstance(WorkbenchList<Row>, 'LatentSessionsBranches', branchesContainer, new RowDelegate(), [new RowRenderer()], { multipleSelectionSupport: false, accessibilityProvider: rowAccessibility(localize('latent.sessions.branches', "Branches")) }));
		this.turnsList = this._register(this.instantiationService.createInstance(WorkbenchList<Row>, 'LatentSessionsTurns', turnsContainer, new RowDelegate(), [new RowRenderer()], { multipleSelectionSupport: false, accessibilityProvider: rowAccessibility(localize('latent.sessions.turns', "Turns")) }));

		this._register(this.threadsList.onDidChangeFocus(event => void this.selectThread(event.elements[0])));
		this._register(this.branchesList.onDidChangeFocus(event => void this.selectBranch(event.elements[0])));
		this._register(this.turnsList.onDidChangeFocus(event => this.showTurn(event.elements[0])));
		this._register(this.threadsList.onDidOpen(() => void this.openSelected()));
		this._register(this.branchesList.onDidOpen(() => void this.openSelected()));
		this._register(this.turnsList.onDidOpen(() => void this.openSelected()));
		this._register(this.threadsList.onKeyDown(event => this.onColumnKey(new StandardKeyboardEvent(event), undefined, this.branchesList)));
		this._register(this.branchesList.onKeyDown(event => this.onColumnKey(new StandardKeyboardEvent(event), this.threadsList, this.turnsList)));
		this._register(this.turnsList.onKeyDown(event => this.onColumnKey(new StandardKeyboardEvent(event), this.branchesList, undefined)));
		this._register(this.threadService.onDidChangeThreads(() => this.refresh()));
		this._register(sessionsSearchSources.onDidChange(() => this.refresh()));
		this.refresh();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		const listHeight = Math.max(0, height - 40);
		const column = Math.max(120, Math.floor(width / 4));
		this.threadsList.layout(listHeight, column);
		this.branchesList.layout(listHeight, column);
		this.turnsList.layout(listHeight, column);
		this.columns.style.height = `${listHeight}px`;
	}

	override focus(): void {
		super.focus();
		this.input.focus();
	}

	private onColumnKey(event: StandardKeyboardEvent, previous: WorkbenchList<Row> | undefined, next: WorkbenchList<Row> | undefined): void {
		if (event.keyCode === KeyCode.RightArrow && next && next.length > 0) {
			event.preventDefault();
			next.domFocus();
			next.setFocus([0]);
		} else if (event.keyCode === KeyCode.LeftArrow && previous) {
			event.preventDefault();
			previous.domFocus();
		}
	}

	private refresh(): void {
		this.searchCancellation.value = new CancellationTokenSource();
		const token = this.searchCancellation.value.token;
		const query = this.input.value.trim();
		void (async () => {
			const threads = [...this.threadService.listThreads({ query })];
			for (const source of sessionsSearchSources.all()) {
				try {
					threads.push(...await source.search(query, token));
				} catch (error) {
					this.logService.warn(`[LatentSessions] Search source ${source.id} failed.`, error);
				}
			}
			if (token.isCancellationRequested) {
				return;
			}
			threads.sort((a, b) => b.updatedAt - a.updatedAt);
			const rows: IThreadRow[] = threads.map(thread => ({ kind: 'thread', thread, day: new Date(thread.updatedAt).toDateString() }));
			this.threadsList.splice(0, this.threadsList.length, rows);
			if (this.selectedThread && !threads.some(thread => thread.id === this.selectedThread!.id)) {
				await this.selectThread(undefined);
			}
		})();
	}

	private async selectThread(row: Row | undefined): Promise<void> {
		const thread = row?.kind === 'thread' ? this.threadService.getThread(row.thread.id) ?? row.thread : undefined;
		this.selectedThread = thread;
		this.selectedBranch = undefined;
		this.listeners.clear();
		if (!thread) {
			this.branchesList.splice(0, this.branchesList.length, []);
			this.turnsList.splice(0, this.turnsList.length, []);
			clearNode(this.preview);
			return;
		}
		const rows: IBranchRow[] = [];
		for (const branch of thread.branches) {
			const turnCount = (await this.threadService.getTurns(thread.id, branch.id)).filter(turn => turn.role === 'user').length;
			rows.push({ kind: 'branch', branch, turnCount });
		}
		if (this.selectedThread !== thread) {
			return;
		}
		this.branchesList.splice(0, this.branchesList.length, rows);
		const activeIndex = thread.branches.findIndex(branch => branch.id === thread.activeBranchId);
		if (activeIndex >= 0) {
			this.branchesList.setFocus([activeIndex]);
		}
	}

	private async selectBranch(row: Row | undefined): Promise<void> {
		const branch = row?.kind === 'branch' ? row.branch : undefined;
		this.selectedBranch = branch;
		if (!branch || !this.selectedThread) {
			this.turnsList.splice(0, this.turnsList.length, []);
			return;
		}
		const turns = await this.threadService.getTurns(this.selectedThread.id, branch.id);
		if (this.selectedBranch !== branch) {
			return;
		}
		this.turnsList.splice(0, this.turnsList.length, turns.map((turn): ITurnRow => ({ kind: 'turn', turn })));
	}

	private showTurn(row: Row | undefined): void {
		clearNode(this.preview);
		if (row?.kind !== 'turn') {
			return;
		}
		append(this.preview, $('.role')).textContent = row.turn.role === 'user' ? localize('latent.sessions.you', "You") : localize('latent.sessions.assistant', "Assistant");
		append(this.preview, $('.time')).textContent = new Date(row.turn.timestamp).toLocaleString();
		append(this.preview, $('pre.text')).textContent = row.turn.text;
		if (row.turn.attachments.length) {
			const list = append(this.preview, $('ul.attachments'));
			row.turn.attachments.forEach((attachment, index) => append(list, $('li')).textContent = `#${index + 1} ${attachment.name}`);
		}
	}

	private async openSelected(): Promise<void> {
		if (!this.selectedThread) {
			return;
		}
		if (this.selectedBranch) {
			await this.threadService.setActiveBranch(this.selectedThread.id, this.selectedBranch.id);
		}
		await this.sideChatOpener.open(this.selectedThread.id, 'commandPalette');
	}
}

function rowAccessibility(widgetLabel: string) {
	return {
		getAriaLabel: (row: Row) => row.kind === 'thread' ? row.thread.title : row.kind === 'branch' ? row.branch.label : row.turn.text.slice(0, 80),
		getWidgetAriaLabel: () => widgetLabel,
	};
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

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
	id: LatentSessionsSearchViewId,
	name: localize2('latent.sessions.viewName', "Sessions"),
	ctorDescriptor: new SyncDescriptor(SessionsSearchView),
	canToggleVisibility: true,
	canMoveView: true,
	order: 0,
	weight: 40,
} satisfies IViewDescriptor], Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).get(SearchViewletId)!);

Registry.as<IQuickAccessRegistry>(QuickAccessExtensions.Quickaccess).registerQuickAccessProvider({
	ctor: ThreadsQuickAccessProvider,
	prefix: ThreadsQuickAccessProvider.PREFIX,
	placeholder: localize('latent.thread.quickAccessPlaceholder', "Search threads by title, message, or file"),
	helpEntries: [{ description: localize('latent.thread.quickAccessHelp', "Search Threads"), commandId: 'latent.thread.search' }],
});
