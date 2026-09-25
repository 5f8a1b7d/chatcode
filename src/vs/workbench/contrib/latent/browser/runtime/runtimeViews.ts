/* eslint-disable header/header */
import './media/runtimeViews.css';
import { $, addDisposableListener, append, EventType, getWindow, reset } from '../../../../../base/browser/dom.js';
import { StandardMouseEvent } from '../../../../../base/browser/mouseEvent.js';
import { DomScrollableElement } from '../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { IAction, Separator, toAction } from '../../../../../base/common/actions.js';
import { Throttler } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ScrollbarVisibility } from '../../../../../base/common/scrollable.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize, localize2 } from '../../../../../nls.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IBotConfig, IJobExecution, IScheduledJob } from '../../../../../platform/latentRuntime/common/runtimeProtocol.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { ViewPane } from '../../../../browser/parts/views/viewPane.js';
import { ViewPaneContainer } from '../../../../browser/parts/views/viewPaneContainer.js';
import { Extensions, IViewContainersRegistry, IViewDescriptorService, IViewsRegistry, ViewContainerLocation } from '../../../../common/views.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IThreadService } from '../../common/threads.js';
import { LatentDerivativeBuildContext } from '../latentProduct.js';
import { ISideChatOpener } from '../sideChat/sideChatOpener.js';
import { IManagedRuntimeService } from './managedRuntimeService.js';

type Surface = 'bots' | 'capabilities' | 'messaging' | 'artifacts' | 'jobs';
type ArtifactFilter = 'all' | 'images' | 'files' | 'links';
interface RowAction { readonly label: string; readonly run: () => Promise<unknown>; readonly enabled?: boolean; readonly separatorBefore?: boolean }

/** Hermes' roster/detail actions adapted to native workbench views and runtime services. */
class RuntimeView extends ViewPane {
	private contentBody!: HTMLElement;
	private scrollable!: DomScrollableElement;
	private readonly refreshThrottler = this._register(new Throttler());
	private readonly rows = this._register(new DisposableStore());
	private showHidden = false;
	private artifactFilter: ArtifactFilter = 'all';

	constructor(
		private readonly surface: Surface,
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
		@IManagedRuntimeService private readonly runtime: IManagedRuntimeService,
		@ICommandService private readonly commands: ICommandService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@INotificationService private readonly notifications: INotificationService,
		@IDialogService private readonly dialogs: IDialogService,
		@IEditorService private readonly editors: IEditorService,
		@IClipboardService private readonly clipboard: IClipboardService,
		@IThreadService private readonly threads: IThreadService,
		@ISideChatOpener private readonly sideChat: ISideChatOpener,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('latent-runtime-view');
		this.contentBody = $('.latent-runtime-body');
		this.scrollable = this._register(new DomScrollableElement(this.contentBody, { vertical: ScrollbarVisibility.Auto, horizontal: ScrollbarVisibility.Hidden }));
		append(container, this.scrollable.getDomNode());
		this._register(this.runtime.onDidChangeState(() => void this.refresh()));
		this._register(this.runtime.onDidNotify(() => void this.refresh()));
		this._register(this.onDidChangeBodyVisibility(visible => { if (visible) { void this.refresh(); } }));
		void this.refresh();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.contentBody.style.height = `${height}px`;
		this.contentBody.style.width = `${width}px`;
		this.scrollable.scanDomNode();
	}

	private async refresh(): Promise<void> {
		try { await this.refreshThrottler.queue(() => this.renderContent()); }
		catch (error) { this.notifications.error(error instanceof Error ? error.message : String(error)); }
	}

	private async invoke(action: RowAction): Promise<void> {
		try { await action.run(); }
		catch (error) { this.notifications.error(error instanceof Error ? error.message : String(error)); }
		finally { await this.refresh(); }
	}

	private button(parent: HTMLElement, action: RowAction, secondary = false): void {
		const button = append(parent, $<HTMLButtonElement>('button', { type: 'button', class: secondary ? 'latent-runtime-secondary' : 'latent-runtime-primary' }));
		button.textContent = action.label;
		button.disabled = action.enabled === false;
		this.rows.add(addDisposableListener(button, EventType.CLICK, () => void this.invoke(action)));
	}

	private filterButton(parent: HTMLElement, label: string, filter: ArtifactFilter, count: number): void {
		const button = append(parent, $<HTMLButtonElement>('button.latent-runtime-filter', { type: 'button', 'aria-pressed': String(this.artifactFilter === filter) }));
		button.textContent = `${label} ${count}`;
		this.rows.add(addDisposableListener(button, EventType.CLICK, () => {
			this.artifactFilter = filter;
			void this.refresh();
		}));
	}

	/** The overflow button, pointer context menu, and keyboard context menu share the same actions. */
	private row(parent: HTMLElement, title: string, detail: string, actions: RowAction[], icon: string): void {
		const row = append(parent, $('.latent-runtime-row'));
		const open = append(row, $('button.latent-runtime-item', { type: 'button' }));
		append(open, $(`span.codicon.codicon-${icon}`));
		const text = append(open, $('span.latent-runtime-label'));
		append(text, $('span.latent-runtime-name')).textContent = title;
		append(text, $('span.latent-runtime-detail')).textContent = detail;
		open.setAttribute('aria-label', `${title}, ${detail}`);
		this.rows.add(addDisposableListener(open, EventType.CLICK, () => void this.invoke(actions[0])));
		const more = append(row, $('button.latent-runtime-more.codicon.codicon-ellipsis', { type: 'button', 'aria-label': localize('runtime.more', "Actions for {0}", title), 'aria-haspopup': 'menu' }));
		const menuActions = (): IAction[] => Separator.clean(actions.flatMap((action, index) => [
			...(action.separatorBefore ? [new Separator()] : []),
			toAction({ id: `latent.${this.surface}.${index}`, label: action.label, enabled: action.enabled, run: () => this.invoke(action) }),
		]));
		const menu = (anchor: HTMLElement | StandardMouseEvent) => this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: menuActions,
		});
		this.rows.add(addDisposableListener(more, EventType.CLICK, () => menu(more)));
		this.rows.add(addDisposableListener(row, EventType.CONTEXT_MENU, event => { event.preventDefault(); event.stopPropagation(); menu(new StandardMouseEvent(getWindow(row), event)); }));
		this.rows.add(addDisposableListener(row, EventType.KEY_DOWN, event => {
			if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); menu(more); }
		}));
	}

	private section(parent: HTMLElement, label: string): HTMLElement {
		const section = append(parent, $('section'));
		append(section, $('h3')).textContent = label;
		return section;
	}

	private empty(parent: HTMLElement, text: string): void { append(parent, $('p.latent-runtime-empty')).textContent = text; }

	private async confirmDelete(name: string, run: () => Promise<unknown>): Promise<void> {
		if ((await this.dialogs.confirm({ message: localize('runtime.deleteConfirm', "Delete {0}?", name), primaryButton: localize('runtime.delete', "Delete") })).confirmed) { await run(); }
	}

	private async renderContent(): Promise<void> {
		if (!this.contentBody || !this.isBodyVisible()) { return; }
		const state = await this.runtime.getState();
		// Read before replacing the view so a failed refresh preserves useful content.
		const data = state.connected ? await Promise.all([this.runtime.listBots(), this.runtime.listJobs(), this.runtime.listSessions(), this.runtime.listGateways(), this.runtime.listCapabilities(), this.runtime.listArtifacts(), this.runtime.memorySnapshot(), this.runtime.listMemoryAdapters(), this.runtime.listBotPresets()]) : undefined;
		if (!this.isBodyVisible()) { return; }
		this.rows.clear();
		reset(this.contentBody);
		if (!data) {
			this.empty(this.contentBody, localize('runtime.stopped', "Start the runtime to use {0}.", this.title));
			this.button(this.contentBody, { label: localize('runtime.start', "Start Runtime"), run: () => this.commands.executeCommand('latent.runtime.start') });
			return;
		}
		const [bots, jobs, sessions, gateways, skills, artifacts, memory, adapters, presets] = data;
		const command = (label: string, id: string): RowAction => ({ label, run: () => this.commands.executeCommand(id) });
		const remove = (name: string, run: () => Promise<unknown>): RowAction => ({ label: localize('runtime.delete', "Delete"), run: () => this.confirmDelete(name, run) });
		const toolbar = append(this.contentBody, $('.latent-runtime-toolbar'));
		switch (this.surface) {
			case 'bots': {
				this.button(toolbar, command(localize('runtime.createBot', "Create Bot"), 'latent.runtime.createBot'));
				if (presets.length) { this.button(toolbar, command(localize('runtime.restoreBots', "Restore Default Bots"), 'latent.runtime.restoreBotPresets'), true); }
				this.button(toolbar, { label: this.showHidden ? localize('runtime.hideHidden', "Hide Hidden Bots") : localize('runtime.showHidden', "Show Hidden Bots"), run: async () => { this.showHidden = !this.showHidden; } }, true);
				const visible = bots.filter(bot => this.showHidden || !bot.hidden).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (a.section ?? '').localeCompare(b.section ?? '') || a.name.localeCompare(b.name));
				if (!visible.length) { this.empty(this.contentBody, localize('runtime.noBots', "Create a bot to start a conversation.")); }
				for (const bot of visible) {
					const recent = sessions.find(session => session.botId === bot.id);
					const chat = sessions.find(session => session.botId === bot.id && session.origin === 'workbench');
					const open = async (fresh = false) => this.openSession(!fresh && chat ? chat.sessionId : (await this.runtime.createSession(bot.id)).sessionId);
					this.row(this.contentBody, bot.name, [bot.section, bot.execution.kind === 'provider' ? bot.execution.modelBindingId : bot.execution.harness, bot.hidden ? localize('runtime.hidden', "Hidden") : ''].filter(Boolean).join(' · '), [
						{ label: localize('runtime.openBot', "Open Bot Chat"), run: () => open() },
						{ label: bot.pinned ? localize('runtime.unpin', "Unpin") : localize('runtime.pin', "Pin to Top"), separatorBefore: true, run: () => this.runtime.upsertBot({ ...bot, pinned: !bot.pinned }) },
						{ label: bot.hidden ? localize('runtime.unhide', "Unhide") : localize('runtime.hide', "Hide"), run: () => this.runtime.upsertBot({ ...bot, hidden: !bot.hidden }) },
						{ label: localize('runtime.edit', "Edit…"), separatorBefore: true, run: () => this.editBot(bot) },
						{ label: localize('runtime.duplicate', "Duplicate"), run: () => this.runtime.upsertBot({ ...bot, id: generateUuid(), name: localize('runtime.copyName', "{0} Copy", bot.name), pinned: false, hidden: false }) },
						{ label: localize('runtime.newChat', "New Chat with This Bot"), separatorBefore: true, run: () => open(true) },
						{ label: localize('runtime.recent', "Open Recent Session"), enabled: !!recent, run: async () => { if (recent) { await this.openSession(recent.sessionId); } } },
						{ label: localize('runtime.moveSection', "Move to Section…"), separatorBefore: true, run: async () => { const section = await this.quickInput.input({ prompt: localize('runtime.section', "Section name (leave empty to remove)"), value: bot.section }); if (section !== undefined) { await this.runtime.upsertBot({ ...bot, section: section.trim() || undefined }); } } },
						{ ...remove(bot.name, () => this.runtime.removeBot(bot.id)), separatorBefore: true },
					], bot.pinned ? 'pinned' : 'robot');
				}
				break;
			}
			case 'jobs': {
				this.button(toolbar, command(localize('runtime.createJob', "Create Job"), 'latent.runtime.createJob'));
				if (!jobs.length) { this.empty(this.contentBody, localize('runtime.noJobs', "Schedule a bot to work at a specific time or on a repeating schedule.")); }
				for (const job of jobs) {
					this.row(this.contentBody, job.name, `${job.schedule} · ${job.enabled ? (job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : '—') : localize('runtime.paused', "Paused")} · ${job.lastStatus ?? '—'}`, [
						{ label: localize('runtime.output', "View Runs and Output"), run: () => this.showJobOutput(job) },
						{ label: localize('runtime.run', "Run Now"), separatorBefore: true, run: async () => { const result = await this.runtime.runJobNow(job.id); if (result) { await this.openSession(result.sessionId); } else { await this.showJobOutput(job); } } },
						{ label: job.enabled ? localize('runtime.pause', "Pause") : localize('runtime.resume', "Resume"), run: () => this.runtime.upsertJob({ ...job, enabled: !job.enabled }) },
						{ label: localize('runtime.edit', "Edit…"), separatorBefore: true, run: () => this.editJob(job) },
						{ label: localize('runtime.duplicate', "Duplicate"), run: () => this.runtime.upsertJob({ ...job, id: generateUuid(), name: localize('runtime.copyName', "{0} Copy", job.name), enabled: false, lastRunAt: undefined, lastStatus: undefined, nextRunAt: undefined }) },
						{ ...remove(job.name, () => this.runtime.removeJob(job.id)), separatorBefore: true },
					], 'watch');
				}
				break;
			}
			case 'messaging': {
				this.button(toolbar, command(localize('runtime.addGateway', "Add Gateway"), 'latent.runtime.addGateway'));
				if (!gateways.length) { this.empty(this.contentBody, localize('runtime.noGateways', "Connect a messaging platform and choose the bot that replies.")); }
				for (const gateway of gateways) {
					const health = state.gateways.find(item => item.id === gateway.id);
					const pair = async () => { const code = await this.runtime.pair(gateway.id); this.notifications.info(localize('runtime.pairCode', "Pairing code: {0} (expires {1})", code.code, new Date(code.expiresAt).toLocaleTimeString())); };
					this.row(this.contentBody, gateway.name, `${gateway.platform} · ${health?.connected ? localize('runtime.connected', "Connected") : localize('runtime.disconnected', "Disconnected")}${health?.lastError ? ` · ${health.lastError}` : ''}`, [
						{ label: localize('runtime.configure', "Configure"), run: async () => { const bot = await this.quickInput.pick(bots.map(bot => ({ label: bot.name, id: bot.id })), { placeHolder: localize('runtime.replyBot', "Bot that replies") }); if (bot) { await this.runtime.upsertGateway({ ...gateway, botId: bot.id }); } } },
						{ label: localize('runtime.pair', "Generate Pairing Code"), separatorBefore: true, run: pair },
						{ label: gateway.enabled ? localize('runtime.disconnect', "Disconnect") : localize('runtime.connect', "Connect"), run: () => this.runtime.upsertGateway({ ...gateway, enabled: !gateway.enabled }) },
						{ label: localize('runtime.send', "Send Message…"), run: async () => { const chatId = await this.quickInput.input({ prompt: localize('runtime.chatId', "Recipient chat ID") }); if (!chatId) { return; } const text = await this.quickInput.input({ prompt: localize('runtime.message', "Message") }); if (text) { await this.runtime.deliver(gateway.id, chatId, text); } } },
						{ ...remove(gateway.name, () => this.runtime.removeGateway(gateway.id)), separatorBefore: true },
					], 'comment-discussion');
				}
				const conversations = this.section(this.contentBody, localize('runtime.conversations', "Conversations"));
				for (const session of sessions.filter(session => session.origin === 'gateway')) {
					this.row(conversations, session.title, bots.find(bot => bot.id === session.botId)?.name ?? session.botId, [{ label: localize('runtime.open', "Open"), run: () => this.openSession(session.sessionId) }], 'comment');
				}
				break;
			}
			case 'artifacts': {
				const imageArtifacts = artifacts.filter(artifact => artifact.mimeType.startsWith('image/'));
				const linkArtifacts = artifacts.filter(artifact => artifact.mimeType === 'text/uri-list');
				const fileArtifacts = artifacts.filter(artifact => !artifact.mimeType.startsWith('image/') && artifact.mimeType !== 'text/uri-list');
				this.filterButton(toolbar, localize('runtime.all', "All"), 'all', artifacts.length);
				this.filterButton(toolbar, localize('runtime.images', "Images"), 'images', imageArtifacts.length);
				this.filterButton(toolbar, localize('runtime.files', "Files"), 'files', fileArtifacts.length);
				this.filterButton(toolbar, localize('runtime.links', "Links"), 'links', linkArtifacts.length);
				const visibleArtifacts = this.artifactFilter === 'images' ? imageArtifacts : this.artifactFilter === 'files' ? fileArtifacts : this.artifactFilter === 'links' ? linkArtifacts : artifacts;
				if (!visibleArtifacts.length) { this.empty(this.contentBody, localize('runtime.noArtifacts', "Generated images and file outputs will appear here as sessions produce them.")); }
				for (const artifact of visibleArtifacts) {
					const session = sessions.find(candidate => candidate.sessionId === artifact.sessionId);
					const bot = bots.find(candidate => candidate.id === artifact.botId);
					const group = /^\[Group chat: "([^"]+)"\]/.exec(session?.title ?? '')?.[1];
					const source = group ? localize('runtime.groupArtifactSource', "{0} · {1} group", bot?.name ?? artifact.botId, group) : bot?.name ?? artifact.botId;
					this.row(this.contentBody, artifact.name, `${source} · ${artifact.mimeType} · ${Math.ceil(artifact.size / 1024)} KB`, [
						{ label: localize('runtime.open', "Open"), run: () => this.editors.openEditor({ resource: URI.file(artifact.path) }) },
						{ label: localize('runtime.source', "Open Source Session"), enabled: !!artifact.sessionId, run: () => this.openSession(artifact.sessionId) },
						{ label: localize('runtime.copyPath', "Copy Path"), separatorBefore: true, run: () => this.clipboard.writeText(artifact.path) },
						{ label: localize('runtime.reveal', "Reveal in File Explorer"), run: () => this.commands.executeCommand('revealFileInOS', URI.file(artifact.path)) },
						{ ...remove(artifact.name, () => this.runtime.removeArtifact(artifact.id)), separatorBefore: true },
					], artifact.mimeType.startsWith('image/') ? 'file-media' : 'file');
				}
				break;
			}
			case 'capabilities': {
				this.button(toolbar, { label: localize('runtime.install', "Install Skill"), run: async () => {
					const kind = await this.quickInput.pick([{ label: localize('runtime.localFolder', "Local Folder"), id: 'path' as const }, { label: localize('runtime.gitRepo', "Git Repository"), id: 'git' as const }], { canPickMany: false });
					if (!kind) { return; }
					const location = await this.quickInput.input({ prompt: localize('runtime.skillSource', "Folder path or Git URL containing SKILL.md") });
					if (location) { await this.runtime.installCapability({ kind: kind.id, location }); }
				} });
				const integrations = this.section(this.contentBody, localize('runtime.integrations', "Tools and Integrations"));
				this.row(integrations, localize('runtime.tools', "Tools"), localize('runtime.toolsHint', "Choose the tools available to conversations"), [command(localize('runtime.configureTools', "Configure Tools…"), 'workbench.action.chat.configureTools')], 'tools');
				this.row(integrations, 'MCP', localize('runtime.mcpHint', "Manage servers, tools, and connections"), [command(localize('runtime.manageServers', "Manage Servers…"), 'workbench.mcp.listServer'), command(localize('runtime.addServer', "Add Server…"), 'workbench.mcp.addConfiguration')], 'plug');
				this.row(integrations, localize('runtime.extensions', "Extensions"), localize('runtime.extensionsHint', "Install and manage capability extensions"), [command(localize('runtime.manageExtensions', "Manage Extensions"), 'workbench.view.extensions')], 'extensions');
				const skillSection = this.section(this.contentBody, localize('runtime.skills', "Skills"));
				if (!skills.length) { this.empty(skillSection, localize('runtime.noSkills', "Install reusable instructions and assign them to bots.")); }
				for (const skill of skills) {
					this.row(skillSection, skill.name, skill.description, [
						{ label: localize('runtime.openInstructions', "Open Instructions"), run: () => this.editors.openEditor({ resource: URI.joinPath(URI.file(skill.path), 'SKILL.md') }) },
						{ label: localize('runtime.assign', "Assign to Bots…"), run: async () => { const selected = await this.quickInput.pick(bots.map(bot => ({ label: bot.name, bot, picked: bot.capabilities.includes(skill.id) })), { canPickMany: true }); if (selected) { for (const bot of bots) { await this.runtime.upsertBot({ ...bot, capabilities: [...bot.capabilities.filter(id => id !== skill.id), ...(selected.some(item => item.bot.id === bot.id) ? [skill.id] : [])] }); } } } },
						{ label: localize('runtime.copyPath', "Copy Path"), separatorBefore: true, run: () => this.clipboard.writeText(skill.path) },
						{ ...remove(skill.name, () => this.runtime.removeCapability(skill.id)), separatorBefore: true },
					], 'book');
				}
				const memorySection = this.section(this.contentBody, localize('runtime.memory', "Memory"));
				this.empty(memorySection, localize('runtime.defaultMemory', "These files belong to the default profile. Each Bot has its own memory profile."));
				this.button(memorySection, command(localize('runtime.botMemory', "Open Bot Memory Profile…"), 'latent.memory.reviewBot'), true);
				this.empty(memorySection, state.funes?.available ? `${state.funes.version} · ${state.funes.lastError ?? (state.funes.indexedAt ? localize('runtime.indexed', "History Indexed") : localize('runtime.indexing', "Indexing History…"))}` : localize('runtime.funesMissing', "Funes is unavailable on this host; local keyword history search is active."));
				for (const target of ['memory', 'user'] as const) {
					const filename = target === 'memory' ? 'MEMORY.md' : 'USER.md';
					this.row(memorySection, filename, localize('runtime.memoryLength', "{0} characters · loaded at conversation start", memory[target].length), [
						{ label: localize('runtime.open', "Open"), run: () => this.editors.openEditor(memory.directory ? { resource: URI.joinPath(URI.file(memory.directory), filename) } : { resource: undefined, contents: memory[target], languageId: 'markdown' }) },
						{ label: localize('runtime.addMemory', "Add Entry…"), run: async () => { const content = await this.quickInput.input({ prompt: localize('runtime.memoryEntry', "Memory entry") }); if (content) { const result = await this.runtime.memoryWrite({ action: 'add', target, content }); if (!result.applied) { this.notifications.warn(result.message ?? ''); } } } },
					], 'notebook');
				}
				this.button(memorySection, command(localize('runtime.searchHistory', "Search Session History"), 'latent.memory.recall'), true);
				for (const pending of memory.staged) {
					this.row(memorySection, pending.summary, localize('runtime.pending', "Pending Review"), [
						{ label: localize('runtime.accept', "Accept Change"), run: async () => { const result = await this.runtime.memoryConfirm(pending.id, true); if (!result.applied) { this.notifications.warn(result.message ?? localize('runtime.memoryNotApplied', "The memory change could not be applied.")); } } },
						{ label: localize('runtime.discard', "Discard"), run: () => this.runtime.memoryConfirm(pending.id, false) },
					], 'diff');
				}
				const adapterSection = this.section(this.contentBody, localize('runtime.adapters', "Memory Adapters"));
				for (const adapter of adapters) {
					this.row(adapterSection, adapter.displayName, adapter.lastError ?? (adapter.enabled ? localize('runtime.enabled', "Enabled") : localize('runtime.disabled', "Disabled")), [
						{ label: adapter.enabled ? localize('runtime.disable', "Disable") : localize('runtime.enable', "Enable…"), run: () => this.commands.executeCommand('latent.runtime.toggleMemoryAdapter', adapter.id) },
						{ label: localize('runtime.review', "Review Adapter Copy"), enabled: adapter.enabled, run: () => this.commands.executeCommand('latent.memory.reviewAdapter', adapter.id) },
					], 'database');
				}
				break;
			}
		}
		this.scrollable.scanDomNode();
	}

	private async openSession(sessionId: string): Promise<void> {
		const session = (await this.runtime.listSessions()).find(item => item.sessionId === sessionId);
		if (!session) { throw new Error(localize('runtime.sessionMissing', "This session is no longer available.")); }
		const thread = await this.threads.adoptSession(URI.from({ scheme: 'latent-runtime', path: `/${sessionId}` }), { title: session.title, origin: 'runtime', createdAt: session.createdAt, updatedAt: session.updatedAt });
		await this.sideChat.open(thread.id, 'secondarySideBar', { host: 'editorArea' });
	}

	private async showJobOutput(job: IScheduledJob): Promise<void> {
		const executions = await this.runtime.listJobExecutions(job.id);
		if (!executions.length) { this.notifications.info(localize('runtime.noRuns', "This job has not run yet.")); return; }
		const selected = await this.quickInput.pick(executions.map(execution => ({ label: new Date(execution.startedAt).toLocaleString(), description: execution.status, detail: execution.error, execution })), { placeHolder: localize('runtime.chooseRun', "Choose a run to view its output") });
		if (selected) { await this.openExecution(job, selected.execution); }
	}

	private async openExecution(job: IScheduledJob, execution: IJobExecution): Promise<void> {
		if (execution.sessionId) { await this.openSession(execution.sessionId); return; }
		await this.editors.openEditor({ resource: undefined, contents: `${job.name}\n${new Date(execution.startedAt).toLocaleString()}\n${execution.status}\n\n${execution.error ?? localize('runtime.noOutput', "No output was recorded for this run.")}`, languageId: 'plaintext', options: { pinned: true } });
	}

	private async editBot(bot: IBotConfig): Promise<void> {
		const name = await this.quickInput.input({ prompt: localize('runtime.botName', "Bot name"), value: bot.name }); if (!name) { return; }
		const systemPrompt = await this.quickInput.input({ prompt: localize('runtime.botPrompt', "System prompt"), value: bot.systemPrompt }); if (systemPrompt === undefined) { return; }
		const workingDirectory = await this.quickInput.input({ prompt: localize('runtime.workdir', "Working directory (empty uses the bot workspace)"), value: bot.workingDirectory }); if (workingDirectory === undefined) { return; }
		const skills = await this.runtime.listCapabilities();
		const selected = await this.quickInput.pick(skills.map(skill => ({ label: skill.name, description: skill.description, id: skill.id, picked: bot.capabilities.includes(skill.id) })), { canPickMany: true, placeHolder: localize('runtime.botSkills', "Bot capabilities") });
		if (selected) { await this.runtime.upsertBot({ ...bot, name, systemPrompt, workingDirectory: workingDirectory || undefined, capabilities: selected.map(skill => skill.id) }); }
	}

	private async editJob(job: IScheduledJob): Promise<void> {
		const name = await this.quickInput.input({ prompt: localize('runtime.jobName', "Job name"), value: job.name }); if (!name) { return; }
		const schedule = await this.quickInput.input({ prompt: localize('runtime.schedule', "Schedule"), value: job.schedule }); if (!schedule) { return; }
		const prompt = await this.quickInput.input({ prompt: localize('runtime.prompt', "Prompt"), value: job.prompt }); if (!prompt) { return; }
		await this.runtime.upsertJob({ ...job, name, schedule, prompt });
	}
}

for (const [surface, title, icon, order] of [
	['bots', localize2('runtime.bots', "Bots"), Codicon.robot, 8],
	['capabilities', localize2('runtime.capabilities', "Capabilities"), Codicon.tools, 9],
	['messaging', localize2('runtime.messaging', "Messaging"), Codicon.commentDiscussion, 10],
	['artifacts', localize2('runtime.artifacts', "Artifacts"), Codicon.files, 11],
	['jobs', localize2('runtime.jobs', "Scheduled Jobs"), Codicon.watch, 12],
] as const) {
	const containerId = `workbench.view.latent.${surface}`;
	const container = Registry.as<IViewContainersRegistry>(Extensions.ViewContainersRegistry).registerViewContainer({
		id: containerId, title, icon, order,
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [containerId, { mergeViewWithContainerWhenSingleView: true }]),
		hideIfEmpty: surface === 'bots',
		alwaysUseContainerInfo: true,
	}, ViewContainerLocation.Sidebar);
	Registry.as<IViewsRegistry>(Extensions.ViewsRegistry).registerViews([{
		id: `latent.${surface}`, name: title, ctorDescriptor: new SyncDescriptor(RuntimeView, [surface]),
		when: surface === 'bots' ? ContextKeyExpr.not(LatentDerivativeBuildContext.key) : undefined,
		canToggleVisibility: true, canMoveView: true,
	}], container);
}
