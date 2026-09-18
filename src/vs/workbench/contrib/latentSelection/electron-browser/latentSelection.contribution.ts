/* eslint-disable header/header */
import { getActiveWindow } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { platformLocale } from '../../../../base/common/platform.js';
import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { EditorOption } from '../../../../editor/common/config/editorOptions.js';
import { localize } from '../../../../nls.js';
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
import { IChatRequestVariableEntry } from '../../chat/common/attachments/chatVariableEntries.js';
import { ITabDraftService } from '../../latent/common/drafts.js';
import { IThreadService } from '../../latent/common/threads.js';
import { IFloatingComposerService } from '../../latent/browser/floatingComposer/tabComposerCoordinator.js';
import { ISideChatOpener } from '../../latent/browser/sideChat/sideChatOpener.js';
import { LatentSettings } from '../../latent/browser/latentConfiguration.js';

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
export function selectionToAttachment(selection: ISelectionSnapshot): IChatRequestVariableEntry {
	const location = selection.uri
		? `${basename(URI.parse(selection.uri))}${selection.range ? `:${selection.range.start.line + 1}` : ''}`
		: selection.application ?? (selection.source === 'thread' ? localize('latentSelection.threadSource', "thread") : localize('latentSelection.selectionSource', "selection"));
	return {
		kind: 'generic',
		id: `latent.selection.${selection.selectionId}`,
		name: localize('latentSelection.attachmentName', "Selection ({0})", location),
		value: selection.text,
		icon: Codicon.listSelection,
		modelDescription: `Text the user selected in ${selection.source} at ${new Date(selection.capturedAt).toISOString()}.`,
	};
}

class LatentSelectionContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.latentSelection';

	private readonly editorListeners = this._register(new DisposableMap<ICodeEditor, DisposableStore>());
	private readonly threadSelectionScheduler: RunOnceScheduler;
	private lastThreadSelectionText = '';

	constructor(
		@ILatentSelectionService private readonly selectionService: ILatentSelectionService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@ICommandService private readonly commandService: ICommandService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
		@IThreadService private readonly threadService: IThreadService,
		@ITabDraftService private readonly draftService: ITabDraftService,
		@IFloatingComposerService private readonly floatingComposerService: IFloatingComposerService,
		@ISideChatOpener private readonly sideChatOpener: ISideChatOpener,
		@IEditorService private readonly editorService: IEditorService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
		@ICodeEditorService codeEditorService: ICodeEditorService,
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
		const listeners = new DisposableStore();
		this.editorListeners.set(editor, listeners);
		listeners.add(editor.onDidDispose(() => this.editorListeners.deleteAndDispose(editor)));
		listeners.add(editor.onMouseUp(event => {
			if (!event.event.leftButton || !editor.hasTextFocus()) {
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
		}));
	}

	/** Captures text selected inside a rendered Thread transcript (P2-FR-010, source `thread`). */
	private captureThreadSelection(): void {
		const window = getActiveWindow();
		const selection = window.getSelection();
		const text = selection?.toString().trim() ?? '';
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
		const thread = this.threadService.getThreadBySession(sessionResource) ?? this.threadService.adoptSession(sessionResource);
		const snapshot: ISelectionSnapshot = {
			selectionId: generateUuid(),
			source: 'thread',
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
				return this.addToChat(event.selection);
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

	private async addToChat(selection: ISelectionSnapshot): Promise<void> {
		const tabKey = this.floatingComposerService.getActiveTabKey();
		if (tabKey) {
			const number = this.draftService.addAttachment(tabKey, selectionToAttachment(selection));
			this.notificationService.info(localize('latentSelection.addedToDraft', "Added to the chat draft as #{0}.", number));
			return;
		}
		await this.sideChatOpener.openNew('systemSelection', { attachments: [selectionToAttachment(selection)] });
	}

	private async askInSideChat(selection: ISelectionSnapshot): Promise<void> {
		if (!selection.threadId) {
			throw new Error(localize('latentSelection.noThread', "Ask in Side Chat needs a selection inside a thread."));
		}
		const branch = this.threadService.getActiveBranch(selection.threadId);
		const widget = branch && this.chatWidgetService.getWidgetBySessionResource(branch.sessionResource);
		const origin = widget && isIChatViewViewContext(widget.viewContext) ? 'secondarySideBar' : 'editorArea';
		await this.sideChatOpener.open(selection.threadId, origin, { attachments: [selectionToAttachment(selection)] });
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
