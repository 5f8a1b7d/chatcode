/* eslint-disable header/header */
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { isEqual } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../../common/views.js';
import { ACTIVE_GROUP } from '../../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService, Parts } from '../../../../services/layout/browser/layoutService.js';
import { ChatViewContainerId, ChatViewPaneTarget, IChatWidget, IChatWidgetService } from '../../../chat/browser/chat.js';
import { ChatEditorInput } from '../../../chat/browser/widgetHosts/editor/chatEditorInput.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ISideChatOpenOptions, resolveSideChatHost, SideChatHost, SideChatOrigin } from '../../common/sideChat.js';
import { IThreadService } from '../../common/threads.js';

export const ISideChatOpener = createDecorator<ISideChatOpener>('latentSideChatOpener');

export interface ISideChatOpener {
	readonly _serviceBrand: undefined;
	resolveHost(origin: SideChatOrigin): SideChatHost;
	/** Opens the Thread's active branch as Side Chat. Falls back to the other host when the requested one is unavailable. */
	open(threadId: string, origin: SideChatOrigin, options?: ISideChatOpenOptions): Promise<IChatWidget | undefined>;
	/** Creates a new Thread and opens it (used by the `+` button and the Floating Window). */
	openNew(origin: SideChatOrigin, options?: ISideChatOpenOptions): Promise<IChatWidget | undefined>;
}

export class SideChatOpener extends Disposable implements ISideChatOpener {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IThreadService private readonly threadService: IThreadService,
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
		@IViewDescriptorService private readonly viewDescriptorService: IViewDescriptorService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	resolveHost(origin: SideChatOrigin): SideChatHost {
		return resolveSideChatHost(origin);
	}

	async openNew(origin: SideChatOrigin, options?: ISideChatOpenOptions): Promise<IChatWidget | undefined> {
		const thread = await this.threadService.createThread({ origin: 'workbench' });
		return this.open(thread.id, origin, options);
	}

	async open(threadId: string, origin: SideChatOrigin, options?: ISideChatOpenOptions): Promise<IChatWidget | undefined> {
		const branch = this.threadService.getActiveBranch(threadId);
		if (!branch) {
			return undefined;
		}
		const preferred = this.resolveHost(origin);
		let widget: IChatWidget | undefined;
		try {
			widget = await this.openIn(preferred, branch.sessionResource, options);
		} catch (error) {
			this.logService.warn(`[LatentSideChat] Could not open in ${preferred}, falling back.`, error);
		}
		if (!widget) {
			const fallback: SideChatHost = preferred === 'editorArea' ? 'secondarySideBar' : 'editorArea';
			widget = await this.openIn(fallback, branch.sessionResource, options);
			if (widget) {
				this.notificationService.notify({
					severity: Severity.Info,
					message: preferred === 'editorArea'
						? localize('latent.sideChat.fallbackToSideBar', "The editor area was unavailable, so the chat opened in the Secondary Side Bar.")
						: localize('latent.sideChat.fallbackToEditor', "The Secondary Side Bar was unavailable, so the chat opened in the editor area."),
				});
			}
		}
		if (widget) {
			if (options?.attachments?.length) {
				widget.attachmentModel.addContext(...options.attachments);
			}
			if (options?.text) {
				widget.inputPart.setValue(options.text, false);
			}
			if (options?.focusInput !== false) {
				widget.focusInput();
			}
		}
		return widget;
	}

	private async openIn(host: SideChatHost, sessionResource: URI, options?: ISideChatOpenOptions): Promise<IChatWidget | undefined> {
		if (host === 'editorArea') {
			const widget = await this.chatWidgetService.openSession(sessionResource, ACTIVE_GROUP, { override: ChatEditorInput.EditorID, pinned: true, revealIfOpened: true, preserveFocus: options?.focusInput === false });
			return widget && isEqual(widget.viewModel?.sessionResource, sessionResource) ? widget : undefined;
		}
		const container = this.viewDescriptorService.getViewContainerById(ChatViewContainerId);
		if (container && this.viewDescriptorService.getViewContainerLocation(container) !== ViewContainerLocation.AuxiliaryBar) {
			this.viewDescriptorService.moveViewContainerToLocation(container, ViewContainerLocation.AuxiliaryBar);
		}
		this.layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
		const widget = await this.chatWidgetService.openSession(sessionResource, ChatViewPaneTarget, { revealIfOpened: false, preserveFocus: options?.focusInput === false });
		return widget && isEqual(widget.viewModel?.sessionResource, sessionResource) ? widget : undefined;
	}
}
