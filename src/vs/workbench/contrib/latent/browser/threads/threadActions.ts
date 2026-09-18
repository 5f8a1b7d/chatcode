/* eslint-disable header/header */
import { $, append, reset } from '../../../../../base/browser/dom.js';
import { BaseActionViewItem } from '../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { IAction } from '../../../../../base/common/actions.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { isEqual } from '../../../../../base/common/resources.js';
import { localize, localize2 } from '../../../../../nls.js';
import { IActionViewItemService } from '../../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { IChatWidgetService } from '../../../chat/browser/chat.js';
import { ChatContextKeys } from '../../../chat/common/actions/chatContextKeys.js';
import { IChatService } from '../../../chat/common/chatService/chatService.js';
import { IChatRequestViewModel, isRequestVM } from '../../../chat/common/model/chatViewModel.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ISideChatOpener } from '../sideChat/sideChatOpener.js';
import { IThreadService } from '../../common/threads.js';
import { LatentSettings } from '../latentConfiguration.js';
import { switchWidgetSession } from './threadWidgetSwitcher.js';

export const LatentThreadActionIds = {
	New: 'latent.thread.new',
	OpenSideChat: 'latent.thread.openSideChat',
	Search: 'latent.thread.search',
	EditAsBranch: 'latent.thread.editAsBranch',
	PreviousVersion: 'latent.thread.previousVersion',
	NextVersion: 'latent.thread.nextVersion',
	VersionCounter: 'latent.thread.versionCounter',
} as const;

export const LatentSessionsSearchViewId = 'latent.sessionsSearch';

const branchMode = ContextKeyExpr.equals(`config.${LatentSettings.ThreadEditMode}`, 'branch');

/** Resolves the Thread, branch, and turn index of a rendered request (adopting foreign sessions as Threads). */
function resolveTurn(accessor: ServicesAccessor, item: IChatRequestViewModel): { threadId: string; branchId: string; turnIndex: number } | undefined {
	const threadService = accessor.get(IThreadService);
	const chatService = accessor.get(IChatService);
	const model = chatService.getSession(item.sessionResource);
	if (!model) {
		return undefined;
	}
	const turnIndex = model.getRequests().findIndex(request => request.id === item.id);
	if (turnIndex < 0) {
		return undefined;
	}
	const thread = threadService.getThreadBySession(item.sessionResource) ?? threadService.adoptSession(item.sessionResource);
	const branch = thread.branches.find(candidate => isEqual(candidate.sessionResource, item.sessionResource));
	return branch ? { threadId: thread.id, branchId: branch.id, turnIndex } : undefined;
}

class NewThreadAction extends Action2 {
	constructor() {
		super({
			id: LatentThreadActionIds.New,
			title: localize2('latent.thread.new', "New Thread"),
			icon: Codicon.add,
			f1: true,
			category: localize2('latent.category', "Latent"),
			menu: [{ id: MenuId.EditorTitle, group: 'navigation', order: -1000 }],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ISideChatOpener).openNew('editorArea');
	}
}

class OpenSideChatAction extends Action2 {
	constructor() {
		super({
			id: LatentThreadActionIds.OpenSideChat,
			title: localize2('latent.thread.openSideChat', "Open Side Chat"),
			f1: true,
			category: localize2('latent.category', "Latent"),
		});
	}

	async run(accessor: ServicesAccessor, threadId?: string): Promise<void> {
		const opener = accessor.get(ISideChatOpener);
		if (threadId) {
			await opener.open(threadId, 'commandPalette');
		} else {
			await opener.openNew('commandPalette');
		}
	}
}

class SearchThreadsAction extends Action2 {
	constructor() {
		super({
			id: LatentThreadActionIds.Search,
			title: localize2('latent.thread.search', "Search Threads"),
			f1: true,
			category: localize2('latent.category', "Latent"),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IViewsService).openView(LatentSessionsSearchViewId, true);
	}
}

class EditAsBranchAction extends Action2 {
	constructor() {
		super({
			id: LatentThreadActionIds.EditAsBranch,
			title: localize2('latent.thread.editAsBranch', "Edit Message"),
			icon: Codicon.edit,
			f1: false,
			menu: [{ id: MenuId.ChatMessageTitle, group: 'navigation', order: -10, when: ContextKeyExpr.and(ChatContextKeys.isRequest, branchMode) }],
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const item = args[0];
		if (!isRequestVM(item)) {
			return;
		}
		const threadService = accessor.get(IThreadService);
		const chatWidgetService = accessor.get(IChatWidgetService);
		const instantiationService = accessor.get(IInstantiationService);
		const notificationService = accessor.get(INotificationService);
		const chatService = accessor.get(IChatService);
		const location = resolveTurn(accessor, item);
		const widget = chatWidgetService.getWidgetBySessionResource(item.sessionResource);
		if (!location || !widget) {
			return;
		}
		const model = chatService.getSession(item.sessionResource);
		if (model?.requestInProgress.get()) {
			await chatService.cancelCurrentRequestForSession(item.sessionResource, 'latent.editAsBranch');
		}
		try {
			const result = await threadService.editTurn(location.threadId, location.branchId, location.turnIndex);
			const target = await instantiationService.invokeFunction(switchWidgetSession, widget, result.branch.sessionResource);
			if (target) {
				target.inputPart.setValue(result.text, false);
				if (result.attachments.length) {
					target.attachmentModel.addContext(...result.attachments);
				}
				target.focusInput();
			}
		} catch (error) {
			notificationService.error(error instanceof Error ? error.message : String(error));
		}
	}
}

abstract class SwitchVersionAction extends Action2 {
	constructor(id: string, title: ReturnType<typeof localize2>, icon: ThemeIcon, order: number, private readonly direction: 'previous' | 'next') {
		super({
			id,
			title,
			icon,
			f1: false,
			menu: [{ id: MenuId.ChatMessageTitle, group: 'navigation', order, when: ContextKeyExpr.and(ChatContextKeys.isRequest, branchMode) }],
		});
	}

	async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const item = args[0];
		if (!isRequestVM(item)) {
			return;
		}
		const threadService = accessor.get(IThreadService);
		const chatWidgetService = accessor.get(IChatWidgetService);
		const instantiationService = accessor.get(IInstantiationService);
		const location = resolveTurn(accessor, item);
		const widget = chatWidgetService.getWidgetBySessionResource(item.sessionResource);
		if (!location || !widget) {
			return;
		}
		const branch = await threadService.switchVersion(location.threadId, location.branchId, location.turnIndex, this.direction);
		if (branch) {
			await instantiationService.invokeFunction(switchWidgetSession, widget, branch.sessionResource);
		}
	}
}

class PreviousVersionAction extends SwitchVersionAction {
	constructor() {
		super(LatentThreadActionIds.PreviousVersion, localize2('latent.thread.previousVersion', "Previous Version"), Codicon.chevronLeft, -9, 'previous');
	}
}

class NextVersionAction extends SwitchVersionAction {
	constructor() {
		super(LatentThreadActionIds.NextVersion, localize2('latent.thread.nextVersion', "Next Version"), Codicon.chevronRight, -7, 'next');
	}
}

class VersionCounterAction extends Action2 {
	constructor() {
		super({
			id: LatentThreadActionIds.VersionCounter,
			title: localize2('latent.thread.versionCounter', "Message Versions"),
			f1: false,
			menu: [{ id: MenuId.ChatMessageTitle, group: 'navigation', order: -8, when: ContextKeyExpr.and(ChatContextKeys.isRequest, branchMode) }],
		});
	}

	run(): void {
		// The counter is informational; the arrows perform the switch.
	}
}

/** Renders `i / n` for the request under the toolbar and hides the arrows when there is a single version (P1-FR-062). */
class VersionActionViewItem extends BaseActionViewItem {
	private label: HTMLElement | undefined;

	constructor(
		action: IAction,
		private readonly kind: 'previous' | 'counter' | 'next',
		private readonly resolve: (item: IChatRequestViewModel) => { current: number; total: number } | undefined,
	) {
		super(undefined, action);
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('latent-version-item');
		if (this.kind === 'counter') {
			this.label = append(container, $('span.latent-version-counter'));
		} else {
			const icon = append(container, $('a.action-label.codicon'));
			icon.classList.add(this.kind === 'previous' ? 'codicon-chevron-left' : 'codicon-chevron-right');
			icon.setAttribute('role', 'button');
			icon.title = this.action.label;
			this._register({ dispose: () => { } });
			icon.addEventListener('click', event => {
				event.preventDefault();
				this.actionRunner.run(this.action, this._context);
			});
		}
		this.update();
	}

	override setActionContext(newContext: unknown): void {
		super.setActionContext(newContext);
		this.update();
	}

	private update(): void {
		if (!this.element) {
			return;
		}
		const info = isRequestVM(this._context) ? this.resolve(this._context) : undefined;
		const visible = !!info && info.total > 1;
		this.element.style.display = visible ? '' : 'none';
		if (this.label && info) {
			reset(this.label, localize('latent.thread.versionCount', "{0} / {1}", info.current, info.total));
		}
	}
}

/** Registers the custom view items for the version controls. */
export class ThreadActionsContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.latentThreadActions';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThreadService threadService: IThreadService,
	) {
		super();
		const resolve = (item: IChatRequestViewModel) => {
			const location = instantiationService.invokeFunction(resolveTurn, item);
			if (!location) {
				return undefined;
			}
			const info = threadService.getVersions(location.threadId, location.branchId, location.turnIndex);
			return { current: info.currentIndex + 1, total: info.versions.length };
		};
		for (const [id, kind] of [[LatentThreadActionIds.PreviousVersion, 'previous'], [LatentThreadActionIds.VersionCounter, 'counter'], [LatentThreadActionIds.NextVersion, 'next']] as const) {
			this._register(actionViewItemService.register(MenuId.ChatMessageTitle, id, action => new VersionActionViewItem(action, kind, resolve), threadService.onDidChangeThreads));
		}
	}
}

registerAction2(NewThreadAction);
registerAction2(OpenSideChatAction);
registerAction2(SearchThreadsAction);
registerAction2(EditAsBranchAction);
registerAction2(PreviousVersionAction);
registerAction2(NextVersionAction);
registerAction2(VersionCounterAction);
