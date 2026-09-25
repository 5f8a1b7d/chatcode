/* eslint-disable header/header */
import { addDisposableListener, EventType, getActiveWindow, getWindow, IDimension } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { platformLocale } from '../../../../base/common/platform.js';
import { basename } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { hasKey } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ContentWidgetPositionPreference, ICodeEditor, IContentWidget, IContentWidgetPosition } from '../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { EditorOption } from '../../../../editor/common/config/editorOptions.js';
import { Range } from '../../../../editor/common/core/range.js';
import { IEditorDecorationsCollection } from '../../../../editor/common/editorCommon.js';
import { IModelDecorationOptions, TrackedRangeStickiness } from '../../../../editor/common/model.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILatentSelectionService, ISelectionActionEvent, ISelectionBarAction, ISelectionSnapshot, isOverlayUpdate, LATENT_SELECTION_CHANNEL, MAX_SELECTION_LENGTH } from '../../../../platform/latentSelection/common/latentSelection.js';
import { LatentSelectionChannelClient } from '../../../../platform/latentSelection/common/latentSelectionIpc.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IChatWidgetService, isIChatViewViewContext } from '../../chat/browser/chat.js';
import { ChatSpeechToTextState, IChatSpeechToTextService } from '../../chat/browser/speechToText/chatSpeechToTextService.js';
import { IChatRequestVariableEntry } from '../../chat/common/attachments/chatVariableEntries.js';
import { ITabDraftService } from '../../latent/common/drafts.js';
import { ITabKey, tabKeyEquals } from '../../latent/common/tabKey.js';
import { IThreadService } from '../../latent/common/threads.js';
import { IFloatingComposerService } from '../../latent/browser/floatingComposer/tabComposerCoordinator.js';
import { ISideChatOpener } from '../../latent/browser/sideChat/sideChatOpener.js';
import { LatentSettings } from '../../latent/browser/latentConfiguration.js';
import './media/selectionComment.css';

/** Action descriptor as registered by the Selection extension or by the workbench. */
export interface ISelectionActionDescriptor {
	readonly id: string;
	readonly label: string;
	readonly icon?: string;
	readonly order: number;
	/** Context-key expression over `latent.selection.source`, `latent.selection.editable`, `latent.selection.languageId`. */
	readonly when?: string;
	readonly showsResult?: boolean;
	/** Command executed with the `ISelectionActionEvent`; omitted for workbench built-ins. */
	readonly command?: string;
}

export const LatentSelectionCommands = {
	SetEnabled: '_latent.selection.setEnabled',
	Update: '_latent.selection.update',
	RegisterActions: '_latent.selection.registerActions',
	SetPinned: '_latent.selection.setPinned',
	Hide: '_latent.selection.hide',
	OsLocale: '_latent.platform.osLocale',
	/** Legacy ids kept for the Study Buddy extension. */
	LegacySetEnabled: '_latentnote.studyBuddy.systemSelection.setEnabled',
	LegacyUpdate: '_latentnote.studyBuddy.systemSelection.update',
	LegacyHandleAction: 'latentnote.studyBuddy.handleSystemSelectionAction',
} as const;

const BuiltinActionIds = {
	AddToChat: 'latent.selection.addToChat',
	AskInSideChat: 'latent.selection.askInSideChat',
	Edit: 'latent.selection.edit',
	Comment: 'latent.selection.comment',
} as const;

registerMainProcessRemoteService(ILatentSelectionService, LATENT_SELECTION_CHANNEL, { channelClientCtor: LatentSelectionChannelClient });

/** Descriptors registered by extensions, keyed by registration handle. */
const registrations = new Map<string, readonly ISelectionActionDescriptor[]>();
const onDidChangeRegistrations = new Emitter<void>();

function isDescriptorList(value: unknown): value is ISelectionActionDescriptor[] {
	return Array.isArray(value) && value.every(item => typeof item === 'object' && item !== null && typeof item.id === 'string' && typeof item.label === 'string' && typeof item.order === 'number');
}

for (const id of [LatentSelectionCommands.SetEnabled, LatentSelectionCommands.LegacySetEnabled]) {
	CommandsRegistry.registerCommand(id, async (accessor, enabled: boolean) => {
		const nativeHostService = accessor.get(INativeHostService);
		return accessor.get(ILatentSelectionService).setEnabled(nativeHostService.windowId, enabled === true);
	});
}

for (const id of [LatentSelectionCommands.Update, LatentSelectionCommands.LegacyUpdate]) {
	CommandsRegistry.registerCommand(id, async (accessor, update: unknown) => {
		if (!isOverlayUpdate(update)) {
			throw new Error('Invalid Latent selection overlay update');
		}
		const nativeHostService = accessor.get(INativeHostService);
		await accessor.get(ILatentSelectionService).updateOverlay(nativeHostService.windowId, update);
	});
}

CommandsRegistry.registerCommand(LatentSelectionCommands.RegisterActions, (_accessor, handle: string, descriptors: unknown) => {
	if (typeof handle !== 'string' || !isDescriptorList(descriptors)) {
		throw new Error('Invalid Latent selection action registration');
	}
	if (descriptors.length) {
		registrations.set(handle, descriptors);
	} else {
		registrations.delete(handle);
	}
	onDidChangeRegistrations.fire();
});

CommandsRegistry.registerCommand(LatentSelectionCommands.SetPinned, async (accessor, pinned: boolean) => {
	const nativeHostService = accessor.get(INativeHostService);
	await accessor.get(ILatentSelectionService).setPinned(nativeHostService.windowId, pinned === true);
});

CommandsRegistry.registerCommand(LatentSelectionCommands.Hide, async accessor => {
	const nativeHostService = accessor.get(INativeHostService);
	await accessor.get(ILatentSelectionService).hide(nativeHostService.windowId);
});

CommandsRegistry.registerCommand(LatentSelectionCommands.OsLocale, () => platformLocale);

/** Creates the chat attachment for a selection (P1-FR-030). */
export function selectionToAttachment(selection: ISelectionSnapshot, comment?: string): IChatRequestVariableEntry {
	const location = selection.uri
		? `${basename(URI.parse(selection.uri))}${selection.range ? `:${selection.range.start.line + 1}` : ''}`
		: selection.application ?? (selection.source === 'thread' ? localize('latentSelection.threadSource', "thread") : localize('latentSelection.selectionSource', "selection"));
	const baseDescription = `Text the user selected in ${selection.source}${selection.threadId ? `, thread ${selection.threadId}, turn ${selection.turnId ?? 'unknown'}` : ''} at ${new Date(selection.capturedAt).toISOString()}.`;
	const trimmedComment = comment?.trim();
	return {
		kind: 'generic',
		id: `latent.selection.${selection.selectionId}`,
		name: localize('latentSelection.attachmentName', "Selection ({0})", location),
		value: selection.text,
		icon: Codicon.listSelection,
		modelDescription: trimmedComment ? `${baseDescription} The user's comment specifically for this selection is: ${trimmedComment}` : baseDescription,
		...(trimmedComment ? { _meta: { 'latent.selection.comment': trimmedComment } } : {}),
	};
}

export class SelectionAttachmentCommentWidget extends Disposable implements IContentWidget {
	readonly allowEditorOverflow = true;
	readonly suppressMouseDown = false;

	private readonly id = `latent-selection-comment-${generateUuid()}`;
	private readonly domNode: HTMLFormElement;
	private readonly input: HTMLTextAreaElement;
	private readonly scrollbar: HTMLDivElement;
	private readonly scrollbarThumb: HTMLDivElement;
	private readonly marker: HTMLButtonElement;
	private readonly dictateButton: HTMLButtonElement;
	private readonly dictateIcon: HTMLSpanElement;
	private readonly saveButton: HTMLButtonElement;
	private readonly markerWidget: IContentWidget;
	private readonly decorations: IEditorDecorationsCollection;
	private inputVisible = false;
	private expanded = false;
	private dictating = false;
	private dictationOperation = false;
	private dictationBaseValue = '';
	private committedComment = '';
	private scrollbarDrag: { readonly clientY: number; readonly scrollTop: number } | undefined;

	constructor(
		private readonly editor: ICodeEditor,
		range: Range,
		number: number,
		placeholder: string,
		editLabel: string,
		private readonly speechToTextService: IChatSpeechToTextService,
		private readonly logService: ILogService,
		private readonly onDidAccept: (comment: string) => void,
	) {
		super();
		const targetWindow = getWindow(editor.getDomNode());
		const document = targetWindow.document;
		this.domNode = document.createElement('form');
		this.domNode.className = 'latent-selection-comment-input';
		this.input = document.createElement('textarea');
		this.input.rows = 1;
		this.input.placeholder = placeholder;
		this.input.setAttribute('aria-label', placeholder);
		this.domNode.append(this.input);
		this.scrollbar = document.createElement('div');
		this.scrollbar.className = 'latent-selection-comment-scrollbar';
		this.scrollbar.setAttribute('aria-hidden', 'true');
		this.scrollbarThumb = document.createElement('div');
		this.scrollbarThumb.className = 'latent-selection-comment-scrollbar-thumb';
		this.scrollbar.append(this.scrollbarThumb);
		this.domNode.append(this.scrollbar);

		const controls = document.createElement('div');
		controls.className = 'latent-selection-comment-controls';
		const deleteButton = document.createElement('button');
		deleteButton.type = 'button';
		deleteButton.className = 'latent-selection-comment-icon-button delete';
		deleteButton.title = localize('latentSelection.deleteAttachmentComment', "Delete comment for attachment #{0}", number);
		deleteButton.setAttribute('aria-label', deleteButton.title);
		const deleteIcon = document.createElement('span');
		deleteIcon.className = ThemeIcon.asClassName(Codicon.trash);
		deleteButton.append(deleteIcon);
		controls.append(deleteButton);

		const controlSpacer = document.createElement('span');
		controlSpacer.className = 'latent-selection-comment-control-spacer';
		controls.append(controlSpacer);

		this.dictateButton = document.createElement('button');
		this.dictateButton.type = 'button';
		this.dictateButton.className = 'latent-selection-comment-icon-button dictate';
		this.dictateIcon = document.createElement('span');
		this.dictateButton.append(this.dictateIcon);
		controls.append(this.dictateButton);

		const cancelButton = document.createElement('button');
		cancelButton.type = 'button';
		cancelButton.className = 'latent-selection-comment-button cancel';
		cancelButton.textContent = localize('latentSelection.cancelAttachmentComment', "Cancel");
		controls.append(cancelButton);

		this.saveButton = document.createElement('button');
		this.saveButton.type = 'submit';
		this.saveButton.className = 'latent-selection-comment-button save';
		this.saveButton.textContent = localize('latentSelection.saveAttachmentComment', "Save");
		controls.append(this.saveButton);
		this.domNode.append(controls);

		this.marker = document.createElement('button');
		this.marker.type = 'button';
		this.marker.className = 'latent-selection-comment-marker';
		this.marker.textContent = String(number);
		this.marker.title = editLabel;
		this.marker.setAttribute('aria-label', editLabel);
		this.markerWidget = {
			allowEditorOverflow: true,
			suppressMouseDown: false,
			getId: () => `${this.id}-marker`,
			getDomNode: () => this.marker,
			getPosition: () => this.getMarkerPosition(),
		};

		this.decorations = editor.createDecorationsCollection([{
			range,
			options: this.getDecorationOptions(false),
		}]);
		this._register(toDisposable(() => this.decorations.clear()));
		this._register(this.decorations.onDidChange(() => {
			this.editor.layoutContentWidget(this.markerWidget);
			if (this.inputVisible) {
				this.editor.layoutContentWidget(this);
			}
		}));
		this._register(addDisposableListener(this.domNode, EventType.SUBMIT, event => {
			event.preventDefault();
			void this.acceptComment();
		}));
		this._register(addDisposableListener(this.input, EventType.KEY_DOWN, event => {
			if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				this.cancelEdit();
			} else if (event.key === 'Enter' && (!this.expanded || ((event.metaKey || event.ctrlKey) && !event.shiftKey))) {
				event.preventDefault();
				event.stopPropagation();
				void this.acceptComment();
			}
		}));
		this._register(addDisposableListener(this.input, EventType.INPUT, () => this.updateScrollbar()));
		this._register(addDisposableListener(this.input, EventType.SCROLL, () => this.updateScrollbar()));
		this._register(addDisposableListener(this.scrollbar, EventType.POINTER_DOWN, event => {
			event.preventDefault();
			event.stopPropagation();
			if (event.target === this.scrollbarThumb) {
				this.scrollbarDrag = { clientY: event.clientY, scrollTop: this.input.scrollTop };
				return;
			}
			const bounds = this.scrollbar.getBoundingClientRect();
			const ratio = Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height));
			this.input.scrollTop = ratio * (this.input.scrollHeight - this.input.clientHeight);
		}));
		this._register(addDisposableListener(targetWindow.document, EventType.POINTER_MOVE, event => {
			if (!this.scrollbarDrag) {
				return;
			}
			const availableTrack = this.scrollbar.clientHeight - this.scrollbarThumb.offsetHeight;
			const availableScroll = this.input.scrollHeight - this.input.clientHeight;
			if (availableTrack > 0 && availableScroll > 0) {
				this.input.scrollTop = this.scrollbarDrag.scrollTop + (event.clientY - this.scrollbarDrag.clientY) / availableTrack * availableScroll;
			}
		}));
		this._register(addDisposableListener(targetWindow.document, EventType.POINTER_UP, () => {
			this.scrollbarDrag = undefined;
		}));
		this._register(addDisposableListener(deleteButton, EventType.CLICK, event => {
			event.preventDefault();
			this.deleteComment();
		}));
		this._register(addDisposableListener(this.dictateButton, EventType.CLICK, event => {
			event.preventDefault();
			void this.toggleDictation(targetWindow);
		}));
		this._register(addDisposableListener(cancelButton, EventType.CLICK, event => {
			event.preventDefault();
			this.cancelEdit();
		}));
		this._register(addDisposableListener(this.marker, EventType.CLICK, event => {
			event.preventDefault();
			event.stopPropagation();
			this.showEditor();
		}));
		this._register(addDisposableListener(targetWindow.document, EventType.POINTER_DOWN, event => {
			const target = event.target as Node | null;
			if (!this.inputVisible || (target && (this.domNode.contains(target) || this.marker.contains(target)))) {
				return;
			}
			this.cancelEdit(false);
		}, true));
		this._register(this.speechToTextService.onDidUpdateTranscript(update => {
			if (this.dictating && this.speechToTextService.showTranscriptWhileDictating) {
				this.input.value = this.joinDictation(this.dictationBaseValue, update.text);
				this.updateScrollbar();
			}
		}));
		this._register(this.speechToTextService.onDidChangeState(state => {
			if (state === ChatSpeechToTextState.Idle && this.dictating && !this.dictationOperation) {
				this.dictating = false;
				this.updateDictationControls();
			}
		}));
		this._register(this.speechToTextService.onDidChangePreparingModel(() => this.updateDictationControls()));

		this.editor.addContentWidget(this.markerWidget);
		this._register(toDisposable(() => this.editor.removeContentWidget(this.markerWidget)));
		this.updateDictationControls();
		this.showInput(false);
	}

	getId(): string {
		return this.id;
	}

	getDomNode(): HTMLElement {
		return this.domNode;
	}

	getPosition(): IContentWidgetPosition | null {
		const range = this.decorations.getRange(0);
		return range ? {
			position: range.getStartPosition(),
			preference: [ContentWidgetPositionPreference.ABOVE, ContentWidgetPositionPreference.BELOW],
		} : null;
	}

	beforeRender(): IDimension {
		const width = Math.min(560, Math.max(260, this.editor.getLayoutInfo().contentWidth * 0.72));
		const height = this.expanded ? 120 : 38;
		this.domNode.style.width = `${Math.round(width)}px`;
		this.domNode.style.height = `${height}px`;
		return { width: Math.round(width), height };
	}

	showEditor(): void {
		this.showInput(true);
	}

	private getMarkerPosition(): IContentWidgetPosition | null {
		const range = this.decorations.getRange(0);
		return range ? {
			position: range.getEndPosition(),
			preference: [ContentWidgetPositionPreference.BELOW, ContentWidgetPositionPreference.ABOVE],
		} : null;
	}

	private showInput(expanded: boolean): void {
		const wasVisible = this.inputVisible;
		this.expanded = expanded;
		this.domNode.classList.toggle('expanded', expanded);
		this.setRangeHighlight(expanded);
		if (!this.inputVisible) {
			this.inputVisible = true;
			this.editor.addContentWidget(this);
		}
		if (!wasVisible) {
			this.input.value = this.committedComment;
		}
		this.editor.layoutContentWidget(this);
		this.editor.layoutContentWidget(this.markerWidget);
		this.input.ownerDocument.defaultView?.setTimeout(() => {
			this.input.focus();
			this.input.setSelectionRange(this.input.value.length, this.input.value.length);
			this.updateScrollbar();
		}, 0);
	}

	private async acceptComment(): Promise<void> {
		if (this.dictationOperation) {
			return;
		}
		if (this.dictating) {
			await this.runDictationOperation(() => this.stopDictation());
		}
		const nextComment = this.input.value.trim();
		this.onDidAccept(nextComment);
		this.committedComment = nextComment;
		this.hideInput();
		this.editor.focus();
	}

	private cancelEdit(focusEditor = true): void {
		this.cancelDictation();
		this.input.value = this.committedComment;
		this.hideInput();
		if (focusEditor) {
			this.editor.focus();
		}
	}

	private deleteComment(): void {
		this.cancelDictation();
		this.input.value = '';
		this.committedComment = '';
		this.onDidAccept('');
		this.hideInput();
		this.editor.focus();
	}

	private async toggleDictation(targetWindow: Window & typeof globalThis): Promise<void> {
		await this.runDictationOperation(async () => {
			if (this.dictating) {
				await this.stopDictation();
				return;
			}
			if (!this.speechToTextService.isConfigured) {
				return;
			}
			if (this.speechToTextService.isBusy) {
				await this.speechToTextService.cancel();
			}
			this.dictationBaseValue = this.input.value.trimEnd();
			this.dictating = true;
			this.updateDictationControls();
			await this.speechToTextService.start(targetWindow, 'editor');
			if (this.speechToTextService.state !== ChatSpeechToTextState.Recording) {
				this.dictating = false;
			}
		});
	}

	private async stopDictation(): Promise<void> {
		const transcript = await this.speechToTextService.stopAndTranscribe({ preserveLiveTranscript: true });
		if (transcript !== undefined) {
			this.input.value = this.joinDictation(this.dictationBaseValue, transcript);
			this.updateScrollbar();
		}
		this.dictating = false;
		this.input.focus();
		this.input.setSelectionRange(this.input.value.length, this.input.value.length);
	}

	private cancelDictation(): void {
		if (!this.dictating) {
			return;
		}
		this.dictating = false;
		void this.speechToTextService.cancel();
		this.updateDictationControls();
	}

	private async runDictationOperation(operation: () => Promise<void>): Promise<void> {
		if (this.dictationOperation) {
			return;
		}
		this.dictationOperation = true;
		this.updateDictationControls();
		try {
			await operation();
		} catch (error) {
			this.logService.error('[LatentSelection] Selection comment dictation failed.', error);
			this.dictating = false;
		} finally {
			this.dictationOperation = false;
			this.updateDictationControls();
		}
	}

	private updateDictationControls(): void {
		this.dictateButton.disabled = !this.speechToTextService.isConfigured || this.dictationOperation;
		this.saveButton.disabled = this.dictationOperation;
		this.dictateButton.classList.toggle('recording', this.dictating);
		this.dictateIcon.className = ThemeIcon.asClassName(this.dictating ? Codicon.micFilled : Codicon.mic);
		this.dictateButton.title = this.dictating
			? localize('latentSelection.stopAttachmentCommentDictation', "Stop dictation")
			: localize('latentSelection.startAttachmentCommentDictation', "Start dictation");
		this.dictateButton.setAttribute('aria-label', this.dictateButton.title);
		this.dictateButton.setAttribute('aria-pressed', String(this.dictating));
	}

	private joinDictation(base: string, transcript: string): string {
		if (!base || !transcript) {
			return `${base}${transcript}`;
		}
		return `${base}${/\s$/.test(base) ? '' : ' '}${transcript}`;
	}

	private setRangeHighlight(visible: boolean): void {
		const range = this.decorations.getRange(0);
		if (range) {
			this.decorations.set([{ range, options: this.getDecorationOptions(visible) }]);
		}
	}

	private getDecorationOptions(highlight: boolean): IModelDecorationOptions {
		return {
			description: 'latent-selection-comment-anchor',
			stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
			...(highlight ? {
				className: 'latent-selection-comment-range',
				shouldFillLineOnLineBreak: true,
			} : {}),
		};
	}

	private updateScrollbar(): void {
		const visible = this.expanded && this.input.scrollHeight > this.input.clientHeight + 1;
		this.domNode.classList.toggle('scrollable', visible);
		if (!visible) {
			return;
		}
		const trackHeight = this.scrollbar.clientHeight;
		const thumbHeight = Math.max(18, Math.round(trackHeight * this.input.clientHeight / this.input.scrollHeight));
		const availableTrack = trackHeight - thumbHeight;
		const availableScroll = this.input.scrollHeight - this.input.clientHeight;
		const thumbTop = availableScroll > 0 ? Math.round(availableTrack * this.input.scrollTop / availableScroll) : 0;
		this.scrollbarThumb.style.height = `${thumbHeight}px`;
		this.scrollbarThumb.style.transform = `translateY(${thumbTop}px)`;
	}

	private hideInput(): void {
		if (!this.inputVisible) {
			return;
		}
		this.cancelDictation();
		this.inputVisible = false;
		this.expanded = false;
		this.domNode.classList.remove('expanded');
		this.setRangeHighlight(false);
		this.editor.removeContentWidget(this);
	}

	override dispose(): void {
		this.hideInput();
		super.dispose();
	}
}

interface SelectionCommentRecord {
	readonly tabKey: ITabKey;
	readonly number: number;
	readonly store: DisposableStore;
}

class LatentSelectionContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.latentSelection';

	private readonly editorListeners = this._register(new DisposableMap<ICodeEditor, DisposableStore>());
	private readonly selectionComments = new Map<string, SelectionCommentRecord>();
	private readonly threadSelectionScheduler: RunOnceScheduler;
	private lastThreadSelectionText = '';

	constructor(
		@ILatentSelectionService private readonly selectionService: ILatentSelectionService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@ICommandService private readonly commandService: ICommandService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
		@IChatSpeechToTextService private readonly chatSpeechToTextService: IChatSpeechToTextService,
		@IThreadService private readonly threadService: IThreadService,
		@ITabDraftService private readonly draftService: ITabDraftService,
		@IFloatingComposerService private readonly floatingComposerService: IFloatingComposerService,
		@ISideChatOpener private readonly sideChatOpener: ISideChatOpener,
		@IEditorService private readonly editorService: IEditorService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
	) {
		super();
		this._register(this.selectionService.onDidRequestAction(event => this.handleAction(event)));
		this._register(codeEditorService.onCodeEditorAdd(editor => this.watchEditor(editor)));
		for (const editor of codeEditorService.listCodeEditors()) {
			this.watchEditor(editor);
		}
		this.threadSelectionScheduler = this._register(new RunOnceScheduler(() => this.captureThreadSelection(), 250));
		const listener = () => this.threadSelectionScheduler.schedule();
		mainWindow.document.addEventListener('selectionchange', listener);
		this._register(toDisposable(() => mainWindow.document.removeEventListener('selectionchange', listener)));
		this._register(onDidChangeRegistrations.event(() => this.publishSystemActions()));
		this._register(this.configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(LatentSettings.SelectionCommentEnabled)) {
				this.publishSystemActions();
			}
		}));
		this._register(addDisposableListener(mainWindow.document, EventType.POINTER_DOWN, () => {
			void this.selectionService.hide(this.nativeHostService.windowId, true);
		}, true));
		this._register(this.draftService.onDidChangeDraft(tabKey => this.pruneSelectionComments(tabKey)));
		this._register(toDisposable(() => {
			for (const record of this.selectionComments.values()) {
				record.store.dispose();
			}
			this.selectionComments.clear();
		}));
		this.publishSystemActions();
	}

	private builtinDescriptors(): ISelectionActionDescriptor[] {
		return [
			{ id: BuiltinActionIds.AddToChat, label: localize('latentSelection.addToChat', "Add to Chat"), icon: 'add', order: 50 },
			{ id: BuiltinActionIds.Edit, label: localize('latentSelection.edit', "Edit"), icon: 'edit', order: 60, when: 'latent.selection.source == editor && latent.selection.editable' },
			...(this.configurationService.getValue<boolean>(LatentSettings.SelectionCommentEnabled)
				? [{ id: BuiltinActionIds.Comment, label: localize('latentSelection.comment', "Comment"), icon: 'comment', order: 70, when: 'latent.selection.source == editor' }]
				: []),
		];
	}

	private allDescriptors(): ISelectionActionDescriptor[] {
		const byId = new Map<string, ISelectionActionDescriptor>();
		for (const descriptor of this.builtinDescriptors()) {
			byId.set(descriptor.id, descriptor);
		}
		for (const list of registrations.values()) {
			for (const descriptor of list) {
				byId.set(descriptor.id, descriptor);
			}
		}
		return [...byId.values()];
	}

	/** Evaluates `when` clauses against the selection (P2-FR-011). */
	private resolveActions(selection: ISelectionSnapshot): ISelectionBarAction[] {
		const overlay = this.contextKeyService.createOverlay([
			['latent.selection.source', selection.source],
			['latent.selection.editable', selection.editable],
			['latent.selection.languageId', selection.languageId ?? ''],
			['latent.selection.hasThread', !!selection.threadId],
		]);
		const actions: ISelectionBarAction[] = [];
		for (const descriptor of this.allDescriptors()) {
			const expression = descriptor.when ? ContextKeyExpr.deserialize(descriptor.when) : undefined;
			if (descriptor.when && !expression) {
				this.logService.warn(`[LatentSelection] Ignoring action ${descriptor.id}: invalid when clause.`);
				continue;
			}
			if (!expression || overlay.contextMatchesRules(expression)) {
				actions.push({ id: descriptor.id, label: descriptor.label, icon: descriptor.icon, order: descriptor.order, showsResult: descriptor.showsResult });
			}
		}
		return actions.sort((a, b) => a.order - b.order);
	}

	private publishSystemActions(): void {
		const probe: ISelectionSnapshot = { selectionId: 'probe', source: 'system', text: 'x', capturedAt: 0, editable: false };
		void this.selectionService.setSystemActions(this.nativeHostService.windowId, this.resolveActions(probe)).catch(error => {
			this.logService.error('[LatentSelection] Unable to publish system selection actions.', error);
		});
	}

	private watchEditor(editor: ICodeEditor): void {
		if (editor.isSimpleWidget) { return; }
		const listeners = new DisposableStore();
		this.editorListeners.set(editor, listeners);
		listeners.add(editor.onDidDispose(() => this.editorListeners.deleteAndDispose(editor)));
		const capture = listeners.add(new RunOnceScheduler(() => {
			if (!editor.hasTextFocus()) {
				return;
			}
			const selection = editor.getSelection();
			const model = editor.getModel();
			if (!selection || selection.isEmpty() || !model) {
				return;
			}
			const raw = model.getValueInRange(selection);
			const text = raw.slice(0, MAX_SELECTION_LENGTH);
			const snapshot: ISelectionSnapshot = {
				selectionId: generateUuid(),
				source: 'editor',
				text,
				capturedAt: Date.now(),
				editable: !editor.getOption(EditorOption.readOnly),
				uri: model.uri.toString(),
				range: { start: { line: selection.startLineNumber - 1, character: selection.startColumn - 1 }, end: { line: selection.endLineNumber - 1, character: selection.endColumn - 1 } },
				languageId: model.getLanguageId(),
				...(raw.length > text.length ? { truncated: true } : {}),
			};
			this.show(snapshot);
		}, 250));
		listeners.add(editor.onDidChangeCursorSelection(() => capture.schedule()));
		listeners.add(editor.onMouseUp(() => capture.schedule()));
	}

	/** Captures text selected inside a rendered Thread transcript (P2-FR-010, source `thread`). */
	private captureThreadSelection(): void {
		const window = getActiveWindow();
		const selection = window.getSelection();
		const text = selection?.toString() ?? '';
		if (!selection || selection.isCollapsed || !text) {
			this.lastThreadSelectionText = '';
			return;
		}
		if (text === this.lastThreadSelectionText) {
			return;
		}
		const anchor = selection.anchorNode;
		const widget = anchor ? this.chatWidgetService.getAllWidgets().find(candidate => candidate.domNode.contains(anchor)) : undefined;
		if (!widget || widget.inputPart.element.contains(anchor)) {
			return;
		}
		const sessionResource = widget.viewModel?.sessionResource;
		if (!sessionResource) {
			return;
		}
		this.lastThreadSelectionText = text;
		void this.clipboardService.writeText(text);
		const thread = this.threadService.getThreadBySession(sessionResource) ?? this.threadService.adoptSession(sessionResource);
		const element = anchor?.nodeType === 1 ? anchor as HTMLElement : anchor?.parentElement;
		const turn = element ? widget.getElementFromNode(element) : undefined;
		const snapshot: ISelectionSnapshot = {
			selectionId: generateUuid(),
			source: 'thread',
			host: isIChatViewViewContext(widget.viewContext) ? 'secondarySideBar' : 'editorArea',
			turnId: turn && hasKey(turn, { id: true }) ? turn.id : undefined,
			text: text.slice(0, MAX_SELECTION_LENGTH),
			capturedAt: Date.now(),
			editable: false,
			threadId: thread.id,
			...(text.length > MAX_SELECTION_LENGTH ? { truncated: true } : {}),
		};
		this.show(snapshot);
	}

	private show(snapshot: ISelectionSnapshot): void {
		void this.selectionService.showSelection(this.nativeHostService.windowId, snapshot, this.resolveActions(snapshot)).catch(error => {
			this.logService.error('[LatentSelection] Unable to show the selection bar.', error);
		});
	}

	private handleAction(event: ISelectionActionEvent): void {
		if (event.targetWindowId !== this.nativeHostService.windowId) {
			return;
		}
		void this.runAction(event).catch(async error => {
			this.logService.error(`[LatentSelection] Action ${event.action} failed.`, error);
			await this.selectionService.updateOverlay(this.nativeHostService.windowId, {
				selectionId: event.selection.selectionId,
				actionId: event.actionId,
				action: event.action,
				phase: 'failed',
				text: error instanceof Error ? error.message : localize('latentSelection.actionFailed', "The selection action is unavailable."),
			});
		});
	}

	private async runAction(event: ISelectionActionEvent): Promise<void> {
		switch (event.action) {
			case BuiltinActionIds.AddToChat:
				return this.addToChat(event.selection, event.comment);
			case BuiltinActionIds.AskInSideChat:
				return this.askInSideChat(event.selection);
			case BuiltinActionIds.Edit:
				return this.edit(event.selection);
			case BuiltinActionIds.Comment:
				return this.comment(event.selection);
		}
		const descriptor = this.allDescriptors().find(candidate => candidate.id === event.action);
		if (descriptor?.command) {
			await this.commandService.executeCommand(descriptor.command, event);
			return;
		}
		// Legacy Study Buddy extension route.
		await this.commandService.executeCommand(LatentSelectionCommands.LegacyHandleAction, event);
	}

	private async addToChat(selection: ISelectionSnapshot, comment?: string): Promise<void> {
		const tabKey = this.floatingComposerService.getActiveTabKey();
		if (tabKey) {
			const number = this.draftService.addAttachment(tabKey, selectionToAttachment(selection, comment));
			this.floatingComposerService.show();
			if (selection.source === 'editor' && selection.uri && selection.range) {
				const editor = this.findEditor(selection.uri);
				if (editor) {
					this.showSelectionComment(editor, tabKey, number, selection);
					return;
				}
			}
			this.notificationService.info(localize('latentSelection.addedToDraft', "Added to the chat draft as #{0}.", number));
			return;
		}
		await this.sideChatOpener.openNew('systemSelection', { attachments: [selectionToAttachment(selection, comment)] });
	}

	private findEditor(uri: string): ICodeEditor | undefined {
		const active = this.codeEditorService.getActiveCodeEditor();
		if (active?.getModel()?.uri.toString() === uri) {
			return active;
		}
		return this.codeEditorService.listCodeEditors().find(editor => editor.getModel()?.uri.toString() === uri);
	}

	private showSelectionComment(editor: ICodeEditor, tabKey: ITabKey, number: number, selection: ISelectionSnapshot): void {
		if (!selection.range) {
			return;
		}
		const key = `${selection.selectionId}:${number}`;
		this.removeSelectionComment(key);
		const store = new DisposableStore();
		const widget = store.add(new SelectionAttachmentCommentWidget(
			editor,
			new Range(selection.range.start.line + 1, selection.range.start.character + 1, selection.range.end.line + 1, selection.range.end.character + 1),
			number,
			localize('latentSelection.optionalAttachmentComment', "Add an optional comment…"),
			localize('latentSelection.editAttachmentComment', "Edit optional comment for attachment #{0}", number),
			this.chatSpeechToTextService,
			this.logService,
			comment => {
				this.draftService.updateAttachment(tabKey, number, selectionToAttachment(selection, comment));
			},
		));
		store.add(editor.onDidDispose(() => this.removeSelectionComment(key)));
		this.selectionComments.set(key, { tabKey, number, store });
		editor.layoutContentWidget(widget);
	}

	private pruneSelectionComments(tabKey: ITabKey): void {
		const liveNumbers = new Set(this.draftService.getDraft(tabKey).attachments
			.filter(attachment => attachment.removedAt === undefined)
			.map(attachment => attachment.number));
		for (const [key, record] of this.selectionComments) {
			if (tabKeyEquals(record.tabKey, tabKey) && !liveNumbers.has(record.number)) {
				this.removeSelectionComment(key);
			}
		}
	}

	private removeSelectionComment(key: string): void {
		const record = this.selectionComments.get(key);
		if (!record) {
			return;
		}
		this.selectionComments.delete(key);
		record.store.dispose();
	}

	private async askInSideChat(selection: ISelectionSnapshot): Promise<void> {
		const options = { attachments: [selectionToAttachment(selection)] };
		if (selection.source === 'thread') {
			await this.sideChatOpener.openNew(selection.host ?? 'editorArea', options);
			return;
		}
		const tabKey = this.floatingComposerService.getActiveTabKey();
		if (tabKey) {
			const thread = this.threadService.getActiveThread(tabKey) ?? await this.threadService.createThread({ tabKey });
			await this.sideChatOpener.open(thread.id, 'editorArea', options);
		} else {
			await this.sideChatOpener.openNew('editorArea', options);
		}
	}

	private async edit(selection: ISelectionSnapshot): Promise<void> {
		if (!selection.uri || !selection.range) {
			throw new Error(localize('latentSelection.editNeedsEditor', "Edit needs a selection in an editor."));
		}
		const initialSelection = {
			selectionStartLineNumber: selection.range.start.line + 1,
			selectionStartColumn: selection.range.start.character + 1,
			positionLineNumber: selection.range.end.line + 1,
			positionColumn: selection.range.end.character + 1,
		};
		await this.editorService.openEditor({ resource: URI.parse(selection.uri), options: { selection: { startLineNumber: initialSelection.selectionStartLineNumber, startColumn: initialSelection.selectionStartColumn, endLineNumber: initialSelection.positionLineNumber, endColumn: initialSelection.positionColumn } } });
		await this.commandService.executeCommand('inlineChat.start', { initialSelection });
	}

	private async comment(selection: ISelectionSnapshot): Promise<void> {
		const note = await this.quickInputService.input({ prompt: localize('latentSelection.commentPrompt', "Comment on the selection"), placeHolder: localize('latentSelection.commentPlaceholder', "Your note is sent together with the selection") });
		if (!note?.trim()) {
			return;
		}
		const attachment = selectionToAttachment(selection);
		const tabKey = this.floatingComposerService.getActiveTabKey();
		if (tabKey) {
			const number = this.draftService.addAttachment(tabKey, attachment);
			this.draftService.setText(tabKey, `${note.trim()} (#${number})`);
			return;
		}
		await this.sideChatOpener.openNew('editorArea', { attachments: [attachment], text: note.trim() });
	}
}


registerWorkbenchContribution2(LatentSelectionContribution.ID, LatentSelectionContribution, WorkbenchPhase.AfterRestored);
