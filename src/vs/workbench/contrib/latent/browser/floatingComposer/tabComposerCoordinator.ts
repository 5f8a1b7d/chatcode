/* eslint-disable header/header */
import { Codicon } from '../../../../../base/common/codicons.js';
import { onUnexpectedError } from '../../../../../base/common/errors.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { getMediaMime } from '../../../../../base/common/mime.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { createDecorator, IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { EditorInputCapabilities } from '../../../../common/editor.js';
import { DiffEditorInput } from '../../../../common/editor/diffEditorInput.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { SideBySideEditorInput } from '../../../../common/editor/sideBySideEditorInput.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { ChatEditorInput } from '../../../chat/browser/widgetHosts/editor/chatEditorInput.js';
import { IChatRequestVariableEntry } from '../../../chat/common/attachments/chatVariableEntries.js';
import { ComposerSubmitKind, IComposerAttachment, IComposerDiagnostic, IComposerDraft, IComposerPlugin } from '../../../chat/common/composer/composerContracts.js';
import { ComposerModel } from '../../../chat/common/composer/composerModel.js';
import { ChatRequestQueueKind, IChatService } from '../../../chat/common/chatService/chatService.js';
import { ChatConfiguration, ChatModeKind } from '../../../chat/common/constants.js';
import { IChatAgentService } from '../../../chat/common/participants/chatAgents.js';
import { ICompactComposerPluginActivationContext } from '../../../chat/browser/widget/input/compactComposer.js';
import { IDraft, IDraftAttachment, ITabDraftService } from '../../common/drafts.js';
import { ISideChatOpener } from '../sideChat/sideChatOpener.js';
import { ITabKey, tabKeyEquals } from '../../common/tabKey.js';
import { IThread, IThreadService } from '../../common/threads.js';
import { FloatingComposerHost } from './floatingComposerHost.js';

const VISIBLE_KEY = 'latent.floatingComposer.visible';
const STUDY_BUDDY_AGENT_ID = 'latentnote.studyBuddy.chat';

export const IFloatingComposerService = createDecorator<IFloatingComposerService>('floatingComposerService');

export interface IFloatingComposerService {
	readonly _serviceBrand: undefined;
	toggle(): void;
	show(): void;
	hide(): void;
	/** The composer bound to the active editor group, if its Tab is editable. */
	getActiveTabKey(): ITabKey | undefined;
}

/** Whether an editor input is an editable Tab that owns a Floating Composer (P1-FR-010/011). */
export function tabKeyForEditor(groupId: number, editor: EditorInput | null | undefined): ITabKey | undefined {
	if (!editor || !editor.resource || editor instanceof DiffEditorInput || editor instanceof SideBySideEditorInput || editor instanceof ChatEditorInput) {
		return undefined;
	}
	if (editor.hasCapability(EditorInputCapabilities.Readonly)) {
		return undefined;
	}
	return { groupId, typeId: editor.typeId, resource: editor.resource };
}

function toComposerAttachment(attachment: IDraftAttachment): IComposerAttachment {
	const entry = attachment.entry;
	const resource = IChatRequestVariableEntry.toUri(entry);
	if (resource && (entry.kind === 'file' || entry.kind === 'image')) {
		return {
			id: entry.id,
			kind: entry.kind,
			resource,
			number: attachment.number,
			mimeType: entry.kind === 'image' ? entry.mimeType ?? getMediaMime(resource.path) ?? 'image/*' : getMediaMime(resource.path) ?? 'application/octet-stream',
		};
	}
	const value = typeof entry.value === 'string' ? entry.value : undefined;
	return { id: entry.id, kind: 'context', label: entry.name || entry.id, number: attachment.number, detail: value?.slice(0, 500) };
}

function toComposerDraft(draft: IDraft): IComposerDraft {
	return {
		text: draft.text,
		attachments: draft.attachments.filter(attachment => attachment.removedAt === undefined).sort((a, b) => a.number - b.number).map(toComposerAttachment),
	};
}

/** One Floating Composer surface per editor group, bound to the group's active editable Tab. */
class GroupComposer extends Disposable {

	private readonly model: ComposerModel<ICompactComposerPluginActivationContext>;
	private readonly host: FloatingComposerHost;
	private readonly bindings = this._register(new DisposableStore());
	private tabKey: ITabKey | undefined;
	private thread: IThread | undefined;
	private syncing = false;
	private visible = true;

	constructor(
		private readonly group: IEditorGroup,
		container: HTMLElement,
		@IInstantiationService instantiationService: IInstantiationService,
		@ITabDraftService private readonly draftService: ITabDraftService,
		@IThreadService private readonly threadService: IThreadService,
		@IChatService private readonly chatService: IChatService,
		@IChatAgentService private readonly chatAgentService: IChatAgentService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ISideChatOpener private readonly sideChatOpener: ISideChatOpener,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
	) {
		super();
		this.model = this._register(new ComposerModel<ICompactComposerPluginActivationContext>(
			{ submit: (draft, kind) => this.submit(draft, kind) },
			{ initialDraft: { text: '', attachments: [] }, initialCapabilities: {}, supportsSteering: true, preferredPendingKind: ComposerSubmitKind.Queued },
		));
		this.host = this._register(instantiationService.createInstance(FloatingComposerHost, container, this.model, { openInSideChat: () => this.openInSideChat() }));
		this._register(this.model.registerPlugin(this.newThreadPlugin()));
		this._register(this.model.registerPlugin(this.threadSwitcherPlugin()));
		this._register(this.model.registerPlugin(this.fixReferencesPlugin()));
		for (const plugin of this.host.chatWidget.inputPart.getComposerPlugins()) {
			this._register(this.model.registerPlugin(plugin));
		}
		this._register(this.model.onDidChange(() => this.pushModelToDraft()));
		this._register(this.draftService.onDidChangeDraft(key => {
			if (this.tabKey && tabKeyEquals(key, this.tabKey)) {
				this.pullDraftIntoModel();
			}
		}));
		this._register(this.threadService.onDidChangeActiveBranch(event => {
			if (this.thread && event.threadId === this.thread.id) {
				void this.bindThread(this.threadService.getThread(event.threadId));
			}
		}));
		this._register(this.group.onDidActiveEditorChange(() => this.bindActiveEditor()));
		this._register(this.group.onWillMoveEditor(event => {
			const from = tabKeyForEditor(this.group.id, event.editor);
			if (from && this.tabKey && tabKeyEquals(from, this.tabKey) && event.target !== this.group.id) {
				const to: ITabKey = { ...from, groupId: event.target };
				this.draftService.rekey(from, to);
				this.threadService.rekey(from, to);
			}
		}));
		this._register(this.configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(ChatConfiguration.RequestQueueingDefaultAction)) {
				this.syncSubmissionState();
			}
		}));
		this.bindActiveEditor();
	}

	get activeTabKey(): ITabKey | undefined {
		return this.tabKey;
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
		this.host.setVisible(visible && !!this.tabKey);
	}

	private bindActiveEditor(): void {
		const tabKey = tabKeyForEditor(this.group.id, this.group.activeEditor);
		if (tabKeyEquals(tabKey, this.tabKey)) {
			return;
		}
		this.bindings.clear();
		this.tabKey = tabKey;
		this.host.setVisible(this.visible && !!tabKey);
		this.model.setDisabled(!tabKey);
		if (!tabKey) {
			this.thread = undefined;
			this.host.bindModel(undefined);
			this.model.setDraft({ text: '', attachments: [] });
			this.model.setDiagnostics([]);
			return;
		}
		this.pullDraftIntoModel();
		void this.bindThread(this.threadService.getActiveThread(tabKey));
		this.bindWidget();
	}

	/** Mirrors the embedded chat widget's own input and attachments into the Draft. */
	private bindWidget(): void {
		const widget = this.host.chatWidget;
		this.bindings.add(widget.inputPart.inputEditor.onDidChangeModelContent(() => {
			if (this.syncing || !this.tabKey) {
				return;
			}
			this.draftService.setText(this.tabKey, widget.inputPart.inputEditor.getValue());
		}));
		this.bindings.add(widget.attachmentModel.onDidChange(() => {
			if (this.syncing || !this.tabKey) {
				return;
			}
			const draft = this.draftService.getDraft(this.tabKey);
			const live = draft.attachments.filter(attachment => attachment.removedAt === undefined);
			const widgetIds = new Set(widget.attachmentModel.attachments.map(entry => entry.id));
			for (const entry of widget.attachmentModel.attachments) {
				if (!live.some(attachment => attachment.entry.id === entry.id)) {
					this.draftService.addAttachment(this.tabKey, entry);
				}
			}
			for (const attachment of live) {
				if (!widgetIds.has(attachment.entry.id)) {
					this.draftService.removeAttachment(this.tabKey, attachment.number);
				}
			}
		}));
		this.bindings.add(widget.onDidChangeViewModel(() => this.syncSubmissionState()));
	}

	private async bindThread(thread: IThread | undefined): Promise<void> {
		this.thread = thread;
		const branch = thread && this.threadService.getActiveBranch(thread.id);
		if (!branch) {
			this.host.bindModel(undefined);
			return;
		}
		let model = this.chatService.getSession(branch.sessionResource);
		if (!model) {
			const turns = await this.threadService.getTurns(thread.id, branch.id); // loads the session
			model = this.chatService.getSession(branch.sessionResource);
			if (!model && turns.length === 0) {
				return;
			}
		}
		if (this.thread !== thread) {
			return;
		}
		this.host.bindModel(model);
		this.applyDefaultAgent();
		this.syncSubmissionState();
	}

	private applyDefaultAgent(): void {
		const widget = this.host.chatWidget;
		const studyBuddyAgent = this.chatAgentService.getAgent(STUDY_BUDDY_AGENT_ID);
		if (studyBuddyAgent && widget.lastSelectedAgent?.id !== studyBuddyAgent.id) {
			widget.input.setChatMode(ChatModeKind.Ask);
			widget.lastSelectedAgent = studyBuddyAgent;
		}
	}

	private pullDraftIntoModel(): void {
		if (!this.tabKey) {
			return;
		}
		this.syncing = true;
		try {
			const draft = this.draftService.getDraft(this.tabKey);
			const composerDraft = toComposerDraft(draft);
			const current = this.model.getSnapshot().draft;
			if (current.text !== composerDraft.text || !sameAttachments(current.attachments, composerDraft.attachments)) {
				this.model.setDraft(composerDraft);
			}
			this.model.setDiagnostics(this.draftService.validateReferences(this.tabKey).map((diagnostic): IComposerDiagnostic => ({
				kind: diagnostic.kind,
				number: diagnostic.number,
				message: diagnostic.kind === 'invalid'
					? localize('latent.composer.invalidReference', "#{0} does not refer to an attachment of this draft.", diagnostic.number)
					: localize('latent.composer.staleReference', "#{0} refers to an attachment that was removed.", diagnostic.number),
			})));
			const widget = this.host.chatWidget;
			if (widget.inputPart.inputEditor.getValue() !== draft.text) {
				widget.inputPart.setValue(draft.text, false);
			}
			this.syncAttachmentsToWidget(draft);
		} finally {
			this.syncing = false;
		}
	}

	private pushModelToDraft(): void {
		if (this.syncing || !this.tabKey) {
			return;
		}
		const snapshot = this.model.getSnapshot().draft;
		const draft = this.draftService.getDraft(this.tabKey);
		if (snapshot.text !== draft.text) {
			this.draftService.setText(this.tabKey, snapshot.text);
		}
		const kept = new Set(snapshot.attachments.map(attachment => attachment.id));
		for (const attachment of draft.attachments) {
			if (attachment.removedAt === undefined && !kept.has(attachment.entry.id)) {
				this.draftService.removeAttachment(this.tabKey, attachment.number);
			}
		}
	}

	private syncAttachmentsToWidget(draft: IDraft): void {
		const attachmentModel = this.host.chatWidget.attachmentModel;
		const live = draft.attachments.filter(attachment => attachment.removedAt === undefined);
		const current = new Set(attachmentModel.attachments.map(entry => entry.id));
		const wanted = new Set(live.map(attachment => attachment.entry.id));
		const deleted = [...current].filter(id => !wanted.has(id));
		const added = live.filter(attachment => !current.has(attachment.entry.id)).map(attachment => attachment.entry);
		if (deleted.length || added.length) {
			attachmentModel.updateContext(deleted, added);
		}
	}

	private syncSubmissionState(): void {
		const chatModel = this.host.chatWidget.viewModel?.model;
		this.model.setSubmissionState({
			requestInProgress: chatModel?.requestInProgress.get() ?? false,
			supportsSteering: !chatModel?.lastRequest?.isHiddenFromTranscript,
			preferredPendingKind: this.configurationService.getValue<string>(ChatConfiguration.RequestQueueingDefaultAction) === 'steer' ? ComposerSubmitKind.Steering : ComposerSubmitKind.Queued,
		});
	}

	private async ensureThread(): Promise<IThread> {
		if (!this.tabKey) {
			throw new Error(localize('latent.composer.noTab', "Open an editable file before sending a prompt."));
		}
		if (!this.thread) {
			const thread = await this.threadService.createThread({ tabKey: this.tabKey });
			await this.bindThread(thread);
		}
		return this.thread!;
	}

	private async submit(_draft: IComposerDraft, kind: ComposerSubmitKind): Promise<void> {
		if (!this.tabKey) {
			throw new Error(localize('latent.composer.noTab', "Open an editable file before sending a prompt."));
		}
		const tabKey = this.tabKey;
		const prepared = this.draftService.prepareForSend(tabKey);
		await this.ensureThread();
		const widget = this.host.chatWidget;
		this.syncing = true;
		try {
			widget.attachmentModel.clear();
			widget.attachmentModel.addContext(...prepared.attachments.map(attachment => attachment.entry));
		} finally {
			this.syncing = false;
		}
		const queue = kind === ComposerSubmitKind.Send ? undefined : kind === ComposerSubmitKind.Steering ? ChatRequestQueueKind.Steering : ChatRequestQueueKind.Queued;
		await new Promise<void>((resolve, reject) => {
			let accepted = false;
			void widget.acceptInput(prepared.text, {
				queue,
				onRequestAccepted: () => {
					accepted = true;
					this.draftService.clearAfterSend(tabKey);
					resolve();
				},
			}).then(() => {
				if (!accepted) {
					reject(new Error(localize('latent.composer.requestNotAccepted', "The chat request was not accepted.")));
				}
			}, error => accepted ? onUnexpectedError(error) : reject(error));
		});
	}

	private async openInSideChat(): Promise<void> {
		const thread = await this.ensureThread();
		this.host.collapse();
		await this.sideChatOpener.open(thread.id, 'editorArea');
	}

	private newThreadPlugin(): IComposerPlugin<ICompactComposerPluginActivationContext> {
		return {
			id: 'latent.newThread',
			placement: 'header',
			order: -20,
			getState: () => ({ label: localize('latent.composer.new', "New"), icon: 'newThread', presentation: 'iconLabel', disabled: !this.tabKey }),
			activate: async () => {
				if (!this.tabKey) {
					return;
				}
				const thread = await this.threadService.createThread({ tabKey: this.tabKey });
				await this.bindThread(thread);
			},
		};
	}

	private threadSwitcherPlugin(): IComposerPlugin<ICompactComposerPluginActivationContext> {
		const onDidChange = new Emitter<void>();
		this._register(onDidChange);
		this._register(this.threadService.onDidChangeThreads(() => onDidChange.fire()));
		return {
			id: 'latent.threadSwitcher',
			placement: 'header',
			order: -10,
			onDidChange: onDidChange.event,
			getState: () => ({
				label: this.thread?.title ?? localize('latent.composer.threads', "Threads"),
				icon: 'threads',
				presentation: 'iconLabel',
				dropdown: true,
				disabled: !this.tabKey || this.threadService.listThreads({ tabKey: this.tabKey }).length === 0,
			}),
			activate: async () => {
				if (!this.tabKey) {
					return;
				}
				const threads = this.threadService.listThreads({ tabKey: this.tabKey });
				const picks: (IQuickPickItem & { threadId: string })[] = threads.map(thread => ({
					threadId: thread.id,
					label: thread.title,
					description: thread.id === this.thread?.id ? localize('latent.composer.activeThread', "active") : undefined,
					detail: new Date(thread.updatedAt).toLocaleString(),
				}));
				const picked = await this.quickInputService.pick(picks, { placeHolder: localize('latent.composer.pickThread', "Switch to a thread of this tab"), canPickMany: false });
				if (picked && this.tabKey) {
					this.threadService.setActiveThread(this.tabKey, picked.threadId);
					await this.bindThread(this.threadService.getThread(picked.threadId));
				}
			},
		};
	}

	private fixReferencesPlugin(): IComposerPlugin<ICompactComposerPluginActivationContext> {
		return {
			id: 'latent.fixReferences',
			placement: 'header',
			order: 100,
			onDidChange: this.model.onDidChange,
			getState: () => ({
				label: localize('latent.composer.fixReferences', "Fix References"),
				icon: 'fix',
				presentation: 'iconLabel',
				disabled: this.model.getSnapshot().diagnostics.length === 0,
			}),
			activate: async () => {
				if (!this.tabKey) {
					return;
				}
				const tabKey = this.tabKey;
				const picks: (IQuickPickItem & { apply: () => void })[] = [];
				for (const diagnostic of this.draftService.validateReferences(tabKey)) {
					if (diagnostic.quickFixes.includes('reAddAttachment')) {
						picks.push({ label: localize('latent.composer.reAdd', "Re-add attachment for #{0}", diagnostic.number), apply: () => this.draftService.reAddAttachment(tabKey, diagnostic.number) });
					}
					picks.push({ label: localize('latent.composer.removeReference', "Remove reference #{0}", diagnostic.number), apply: () => this.draftService.removeReference(tabKey, diagnostic.number) });
				}
				const picked = await this.quickInputService.pick(picks, { placeHolder: localize('latent.composer.pickFix', "Choose how to fix the reference"), canPickMany: false });
				picked?.apply();
			},
		};
	}
}

function sameAttachments(first: readonly IComposerAttachment[], second: readonly IComposerAttachment[]): boolean {
	return first.length === second.length && first.every((attachment, index) => {
		const other = second[index];
		return attachment.id === other.id && attachment.kind === other.kind && attachment.number === other.number
			&& (attachment.kind === 'context' ? other.kind === 'context' && attachment.label === other.label : other.kind !== 'context' && attachment.resource.toString() === other.resource.toString());
	});
}

/** Creates one GroupComposer per editor group and keeps them in sync with the visibility switch. */
export class FloatingComposerService extends Disposable implements IFloatingComposerService, IWorkbenchContribution {
	declare readonly _serviceBrand: undefined;
	static readonly ID = 'workbench.contrib.latentTabComposers';

	private readonly composers = this._register(new DisposableMap<number, GroupComposer>());
	private visible: boolean;

	constructor(
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		this.visible = this.storageService.getBoolean(VISIBLE_KEY, StorageScope.PROFILE, true);
		this._register(this.editorGroupsService.onDidAddGroup(group => this.attach(group)));
		this._register(this.editorGroupsService.onDidRemoveGroup(group => this.composers.deleteAndDispose(group.id)));
		for (const group of this.editorGroupsService.groups) {
			this.attach(group);
		}
	}

	private attach(group: IEditorGroup): void {
		const element = (group as unknown as { element?: HTMLElement }).element;
		if (!element || this.composers.has(group.id)) {
			return;
		}
		const composer = this.instantiationService.createInstance(GroupComposer, group, element);
		composer.setVisible(this.visible);
		this.composers.set(group.id, composer);
	}

	toggle(): void {
		this.visible ? this.hide() : this.show();
	}

	show(): void {
		this.setVisible(true);
	}

	hide(): void {
		this.setVisible(false);
	}

	private setVisible(visible: boolean): void {
		this.visible = visible;
		this.storageService.store(VISIBLE_KEY, visible, StorageScope.PROFILE, StorageTarget.USER);
		for (const composer of this.composers.values()) {
			composer.setVisible(visible);
		}
	}

	getActiveTabKey(): ITabKey | undefined {
		return this.composers.get(this.editorGroupsService.activeGroup.id)?.activeTabKey;
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

/** Forces the composer service to start with the workbench so every group gets its surface. */
export class FloatingComposerStartup implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.latentFloatingComposerStartup';
	constructor(@IFloatingComposerService _service: IFloatingComposerService) { }
}

registerSingleton(IFloatingComposerService, FloatingComposerService, InstantiationType.Delayed);
registerAction2(ToggleFloatingComposerAction);
