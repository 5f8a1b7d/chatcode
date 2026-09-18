/* eslint-disable header/header */
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IStudyBuddySelectionActionEvent, IStudyBuddySelectionService, STUDY_BUDDY_SELECTION_CHANNEL, StudyBuddySelectionOverlayUpdate } from '../../../../platform/studyBuddySelection/common/studyBuddySelection.js';
import { StudyBuddySelectionChannelClient } from '../../../../platform/studyBuddySelection/common/studyBuddySelectionIpc.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';

const setEnabledCommand = '_latentnote.studyBuddy.systemSelection.setEnabled';
const updateOverlayCommand = '_latentnote.studyBuddy.systemSelection.update';
const handleActionCommand = 'latentnote.studyBuddy.handleSystemSelectionAction';

registerMainProcessRemoteService(IStudyBuddySelectionService, STUDY_BUDDY_SELECTION_CHANNEL, {
	channelClientCtor: StudyBuddySelectionChannelClient,
});

CommandsRegistry.registerCommand(setEnabledCommand, async (accessor, enabled: boolean) => {
	const nativeHostService = accessor.get(INativeHostService);
	return accessor.get(IStudyBuddySelectionService).setEnabled(nativeHostService.windowId, enabled === true);
});

CommandsRegistry.registerCommand(updateOverlayCommand, async (accessor, update: StudyBuddySelectionOverlayUpdate) => {
	if (!isOverlayUpdate(update)) {
		throw new Error('Invalid StudyBuddy selection overlay update');
	}
	const nativeHostService = accessor.get(INativeHostService);
	await accessor.get(IStudyBuddySelectionService).updateOverlay(nativeHostService.windowId, update);
});

class StudyBuddySelectionContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.studyBuddySelection';
	private readonly editorListeners = this._register(new DisposableMap<ICodeEditor, DisposableStore>());

	constructor(
		@IStudyBuddySelectionService private readonly selectionService: IStudyBuddySelectionService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@ICommandService private readonly commandService: ICommandService,
		@ILogService private readonly logService: ILogService,
		@ICodeEditorService codeEditorService: ICodeEditorService,
	) {
		super();
		this._register(this.selectionService.onDidRequestAction(event => this.handleAction(event)));
		this._register(codeEditorService.onCodeEditorAdd(editor => this.watchEditor(editor)));
		for (const editor of codeEditorService.listCodeEditors()) {
			this.watchEditor(editor);
		}
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
			const text = model.getValueInRange(selection).slice(0, 50_000);
			void this.selectionService.showEditorSelection(this.nativeHostService.windowId, text).catch(error => {
				this.logService.error('[StudyBuddySelection] Unable to show the editor selection.', error);
			});
		}));
	}

	private handleAction(event: IStudyBuddySelectionActionEvent): void {
		if (event.targetWindowId !== this.nativeHostService.windowId) {
			return;
		}
		void this.commandService.executeCommand(handleActionCommand, event).catch(async error => {
			this.logService.error('[StudyBuddySelection] Unable to execute the extension action.', error);
			await this.selectionService.updateOverlay(this.nativeHostService.windowId, {
				selectionId: event.selection.selectionId,
				actionId: event.actionId,
				action: event.action,
				phase: 'failed',
				text: 'StudyBuddy selection action is unavailable.',
			});
		});
	}
}

function isOverlayUpdate(value: StudyBuddySelectionOverlayUpdate): boolean {
	return !!value && typeof value.selectionId === 'string'
		&& typeof value.actionId === 'string'
		&& (value.action === 'explain' || value.action === 'translate' || value.action === 'summarize' || value.action === 'context')
		&& (value.phase === 'running' || value.phase === 'succeeded' || value.phase === 'failed')
		&& (value.text === undefined || typeof value.text === 'string');
}

registerWorkbenchContribution2(StudyBuddySelectionContribution.ID, StudyBuddySelectionContribution, WorkbenchPhase.AfterRestored);
