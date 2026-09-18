/* eslint-disable header/header */
import { addDisposableListener, EventHelper, EventType, getWindow, isHTMLElement } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { GlobalPointerMoveMonitor } from '../../../../../base/browser/globalPointerMoveMonitor.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { onUnexpectedError } from '../../../../../base/common/errors.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { getMediaMime } from '../../../../../base/common/mime.js';
import { autorun, IReader } from '../../../../../base/common/observable.js';
import { basename } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { createDecorator, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IWorkbenchLayoutService, Parts } from '../../../../services/layout/browser/layoutService.js';
import { IChatWidget, IChatWidgetService } from '../../../chat/browser/chat.js';
import { IChatRequestVariableEntry } from '../../../chat/common/attachments/chatVariableEntries.js';
import { ComposerSubmitKind, type IComposerAttachment, type IComposerDraft } from '../../../chat/common/composer/composerContracts.js';
import { ComposerModel } from '../../../chat/common/composer/composerModel.js';
import { ChatRequestQueueKind } from '../../../chat/common/chatService/chatService.js';
import { ChatConfiguration } from '../../../chat/common/constants.js';
import { renderCompactComposer, type ICompactComposerPluginActivationContext } from '../../../chat/browser/widget/input/compactComposer.js';
import './media/floatingComposer.css';

const EDGE_GAP = 12;

export const IFloatingComposerService = createDecorator<IFloatingComposerService>('floatingComposerService');

export interface IFloatingComposerService {
	readonly _serviceBrand: undefined;
	toggle(): void;
	show(): void;
	hide(): void;
}

/** Owns one draggable React composer surface within an editor-part container. */
export class FloatingComposerHost extends Disposable {

	private readonly _element: HTMLElement;
	private readonly _dragMonitor = this._register(new GlobalPointerMoveMonitor());
	private _hasCustomPosition = false;

	constructor(
		private readonly _container: HTMLElement,
		model: ComposerModel<ICompactComposerPluginActivationContext>,
	) {
		super();
		this._element = getWindow(this._container).document.createElement('div');
		this._element.classList.add('floating-composer-host');
		this._element.setAttribute('role', 'region');
		this._element.setAttribute('aria-label', localize('floatingComposer.region', "Floating Chat Composer"));
		this._container.classList.add('floating-composer-container');
		this._container.appendChild(this._element);

		this._register(toDisposable(() => {
			this._element.remove();
			this._container.classList.remove('floating-composer-container');
		}));
		const renderer = this._register(new MutableDisposable<IDisposable>());
		let disposed = false;
		this._register(toDisposable(() => disposed = true));
		void renderCompactComposer(this._element, model).then(disposable => {
			if (disposed) {
				disposable.dispose();
			} else {
				renderer.value = disposable;
			}
		}, onUnexpectedError);
		this._register(addDisposableListener(this._element, EventType.POINTER_DOWN, event => this._startDrag(event)));

		const resizeObserver = new (getWindow(this._container).ResizeObserver)(() => this._clampCurrentPosition());
		resizeObserver.observe(this._container);
		resizeObserver.observe(this._element);
		this._register(toDisposable(() => resizeObserver.disconnect()));
	}

	private _startDrag(event: PointerEvent): void {
		if (event.button !== 0 || event.buttons !== 1) {
			return;
		}
		const target = event.target;
		if (!isHTMLElement(target) || target.closest('button, textarea, input, select, a, [role="button"], [role="menuitem"]')) {
			return;
		}

		EventHelper.stop(event, true);
		const containerRect = this._container.getBoundingClientRect();
		const composerRect = this._element.getBoundingClientRect();
		const startX = event.clientX;
		const startY = event.clientY;
		const startLeft = composerRect.left - containerRect.left;
		const startTop = composerRect.top - containerRect.top;

		this._element.classList.add('dragging');
		this._dragMonitor.startMonitoring(this._element, event.pointerId, event.buttons, moveEvent => {
			this._hasCustomPosition = true;
			this._setPosition(startLeft + moveEvent.clientX - startX, startTop + moveEvent.clientY - startY);
		}, () => this._element.classList.remove('dragging'));
	}

	private _setPosition(left: number, top: number): void {
		const maxLeft = Math.max(EDGE_GAP, this._container.clientWidth - this._element.offsetWidth - EDGE_GAP);
		const maxTop = Math.max(EDGE_GAP, this._container.clientHeight - this._element.offsetHeight - EDGE_GAP);
		this._element.style.insetInlineStart = `${Math.min(maxLeft, Math.max(EDGE_GAP, left))}px`;
		this._element.style.top = `${Math.min(maxTop, Math.max(EDGE_GAP, top))}px`;
		this._element.style.bottom = 'auto';
		this._element.style.transform = 'none';
	}

	private _clampCurrentPosition(): void {
		if (!this._hasCustomPosition) {
			return;
		}
		const containerRect = this._container.getBoundingClientRect();
		const composerRect = this._element.getBoundingClientRect();
		this._setPosition(composerRect.left - containerRect.left, composerRect.top - containerRect.top);
	}
}

/** Connects the floating renderer to the most recently focused chat widget. */
export class FloatingComposerService extends Disposable implements IFloatingComposerService {

	declare readonly _serviceBrand: undefined;
	private readonly _host = this._register(new MutableDisposable<FloatingComposerHost>());
	private readonly _model = this._register(new ComposerModel<ICompactComposerPluginActivationContext>(
		{ submit: (draft, kind) => this._submit(draft, kind) },
		{
			initialDraft: { text: '', attachments: [] },
			initialCapabilities: {},
			supportsSteering: true,
			preferredPendingKind: ComposerSubmitKind.Queued,
		},
	));
	private readonly _widgetRegistrations = this._register(new DisposableStore());
	private _boundWidget: IChatWidget | undefined;

	constructor(
		@IChatWidgetService private readonly _chatWidgetService: IChatWidgetService,
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();
		this._register(this._model.onDidChange(() => this._syncModelToWidget()));
		this._register(this._chatWidgetService.onDidChangeFocusedWidget(widget => this._bindWidget(widget)));
		this._register(this._configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(ChatConfiguration.RequestQueueingDefaultAction)) {
				this._syncSubmissionState(this._boundWidget);
			}
		}));
		this._bindWidget(this._chatWidgetService.lastFocusedWidget);
	}

	toggle(): void {
		if (this._host.value) {
			this.hide();
		} else {
			this.show();
		}
	}

	show(): void {
		if (this._host.value) {
			return;
		}
		const container = this._layoutService.getContainer(mainWindow, Parts.EDITOR_PART);
		if (!container) {
			return;
		}
		this._host.value = new FloatingComposerHost(container, this._model);
	}

	hide(): void {
		this._host.clear();
	}

	private _bindWidget(widget: IChatWidget | undefined): void {
		this._boundWidget = undefined;
		this._widgetRegistrations.clear();
		this._model.setDraft({
			text: widget?.inputPart.inputEditor.getValue() ?? '',
			attachments: widget ? this._getComposerAttachments(widget) : [],
		});
		this._syncCapabilities(widget);
		this._syncSubmissionState(widget);
		this._model.setDisabled(!widget);
		this._boundWidget = widget;
		if (!widget) {
			return;
		}
		this._widgetRegistrations.add(widget.inputPart.inputEditor.onDidChangeModelContent(() => {
			if (this._boundWidget === widget) {
				this._syncWidgetDraft(widget);
			}
		}));
		this._widgetRegistrations.add(widget.inputPart.attachmentModel.onDidChange(() => {
			if (this._boundWidget === widget) {
				this._syncWidgetDraft(widget);
			}
		}));
		this._widgetRegistrations.add(widget.onDidChangeAgent(() => {
			if (this._boundWidget === widget) {
				this._syncCapabilities(widget);
				this._syncSubmissionState(widget);
			}
		}));
		this._widgetRegistrations.add(widget.onDidChangeViewModel(() => {
			if (this._boundWidget === widget) {
				this._bindWidget(widget);
			}
		}));
		if (widget.viewModel) {
			this._widgetRegistrations.add(autorun(reader => {
				if (this._boundWidget === widget) {
					this._syncSubmissionState(widget, reader);
				}
			}));
		}
		for (const plugin of widget.inputPart.getComposerPlugins()) {
			this._widgetRegistrations.add(this._model.registerPlugin(plugin));
		}
	}

	private _syncModelToWidget(): void {
		const widget = this._boundWidget;
		if (!widget) {
			return;
		}
		const draft = this._model.getSnapshot().draft;
		if (widget.inputPart.inputEditor.getValue() !== draft.text) {
			widget.inputPart.setValue(draft.text, false);
		}
		this._syncAttachmentsToWidget(widget, draft.attachments);
	}

	private _syncWidgetDraft(widget: IChatWidget): void {
		const current = this._model.getSnapshot().draft;
		const text = widget.inputPart.inputEditor.getValue();
		const attachments = this._getComposerAttachments(widget);
		if (current.text === text && this._sameAttachments(current.attachments, attachments)) {
			return;
		}
		this._model.setDraft({ text, attachments });
	}

	private _syncCapabilities(widget: IChatWidget | undefined): void {
		this._model.setCapabilities({
			supportsFileAttachments: widget?.attachmentCapabilities.supportsFileAttachments,
			supportsImageAttachments: widget?.attachmentCapabilities.supportsImageAttachments,
		});
	}

	private _syncSubmissionState(widget: IChatWidget | undefined, reader?: IReader): void {
		const chatModel = widget?.viewModel?.model;
		const requestInProgress = reader && chatModel ? chatModel.requestInProgress.read(reader) : chatModel?.requestInProgress.get() ?? false;
		const lastRequest = reader && chatModel ? chatModel.lastRequestObs.read(reader) : chatModel?.lastRequest;
		this._model.setSubmissionState({
			requestInProgress,
			supportsSteering: !lastRequest?.isHiddenFromTranscript,
			preferredPendingKind: this._configurationService.getValue<string>(ChatConfiguration.RequestQueueingDefaultAction) === 'steer'
				? ComposerSubmitKind.Steering
				: ComposerSubmitKind.Queued,
		});
	}

	private _getComposerAttachments(widget: IChatWidget): IComposerAttachment[] {
		const result: IComposerAttachment[] = [];
		for (const entry of widget.inputPart.attachmentModel.attachments) {
			let resource = IChatRequestVariableEntry.toUri(entry);
			for (const reference of entry.references ?? []) {
				if (!resource && URI.isUri(reference.reference)) {
					resource = reference.reference;
				}
			}
			if (!resource || (entry.kind !== 'file' && entry.kind !== 'image')) {
				continue;
			}
			result.push({
				id: entry.id,
				kind: entry.kind,
				resource,
				mimeType: entry.kind === 'image'
					? entry.mimeType ?? getMediaMime(resource.path) ?? 'image/*'
					: getMediaMime(resource.path) ?? 'application/octet-stream',
			});
		}
		return result;
	}

	private _syncAttachmentsToWidget(widget: IChatWidget, attachments: readonly IComposerAttachment[]): void {
		const attachmentModel = widget.inputPart.attachmentModel;
		const current = new Map(this._getComposerAttachments(widget).map(attachment => [attachment.id, attachment]));
		const nextIds = new Set(attachments.map(attachment => attachment.id));
		const deleted = Array.from(current.keys()).filter(id => !nextIds.has(id));
		const added = attachments
			.filter(attachment => !current.has(attachment.id))
			.map(attachment => ({
				id: attachment.id,
				kind: attachment.kind,
				name: basename(attachment.resource) || attachment.resource.toString(),
				value: attachment.resource,
				...(attachment.kind === 'image' ? { mimeType: attachment.mimeType } : {}),
			} satisfies IChatRequestVariableEntry));
		attachmentModel.updateContext(deleted, added);
	}

	private _sameAttachments(first: readonly IComposerAttachment[], second: readonly IComposerAttachment[]): boolean {
		return first.length === second.length && first.every((attachment, index) => {
			const other = second[index];
			return attachment.id === other.id && attachment.kind === other.kind && attachment.resource.toString() === other.resource.toString() && attachment.mimeType === other.mimeType;
		});
	}

	private async _submit(draft: IComposerDraft, kind: ComposerSubmitKind): Promise<void> {
		const widget = this._boundWidget;
		if (!widget) {
			throw new Error(localize('floatingComposer.noChat', "Open a chat before sending a prompt."));
		}

		this._syncAttachmentsToWidget(widget, draft.attachments);
		const queue = kind === ComposerSubmitKind.Send
			? undefined
			: kind === ComposerSubmitKind.Steering ? ChatRequestQueueKind.Steering : ChatRequestQueueKind.Queued;
		await new Promise<void>((resolve, reject) => {
			let accepted = false;
			void widget.acceptInput(draft.text, {
				queue,
				onRequestAccepted: () => {
					accepted = true;
					resolve();
				},
			}).then(() => {
				if (!accepted) {
					reject(new Error(localize('floatingComposer.requestNotAccepted', "The chat request was not accepted.")));
				}
			}, error => {
				if (accepted) {
					onUnexpectedError(error);
				} else {
					reject(error);
				}
			});
		});
	}

	override dispose(): void {
		this._boundWidget = undefined;
		this._widgetRegistrations.clear();
		super.dispose();
	}
}

class ToggleFloatingComposerAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.chat.toggleFloatingComposer',
			title: localize2('toggleFloatingComposer', "Toggle Floating Chat Composer"),
			icon: Codicon.commentDiscussion,
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(IFloatingComposerService).toggle();
	}
}

registerSingleton(IFloatingComposerService, FloatingComposerService, InstantiationType.Delayed);
registerAction2(ToggleFloatingComposerAction);
