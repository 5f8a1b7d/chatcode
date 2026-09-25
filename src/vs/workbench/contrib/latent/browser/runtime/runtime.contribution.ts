/* eslint-disable header/header */
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { IChatAgentService } from '../../../chat/common/participants/chatAgents.js';
import { ChatAgentLocation, ChatModeKind } from '../../../chat/common/constants.js';
import { Event } from '../../../../../base/common/event.js';
import { constObservable } from '../../../../../base/common/observable.js';
import { IChatService } from '../../../chat/common/chatService/chatService.js';
import { IChatModel } from '../../../chat/common/model/chatModel.js';
import { IChatSessionsService } from '../../../chat/common/chatSessionsService.js';
import { runtimeSessionHistory } from './runtimeSessionHistory.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../../services/statusbar/browser/statusbar.js';
import { IBotConfig, IGatewayConfig, IModelBinding, IRuntimeApprovalRequest, IRuntimeState, IScheduledJob } from '../../../../../platform/latentRuntime/common/runtimeProtocol.js';
import { IThreadService } from '../../common/threads.js';
import { sessionsSearchSources } from '../../common/sessionsSearch.js';
import { LatentSettings } from '../latentConfiguration.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IManagedRuntimeService } from './managedRuntimeService.js';
import { reviewBotMemory, reviewMemoryAdapter } from './memoryReview.js';

import './runtimeViews.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';

export const LatentBotsViewId = 'latent.bots';

/** Status bar item, approvals, recall indexing, and the runtime sessions search source (spec 01 P1-FR-084). */
export class RuntimeContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.latentRuntime';

	private readonly statusEntry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private state: IRuntimeState | undefined;
	private readonly indexedModels = this._register(new DisposableMap<string, DisposableStore>());

	constructor(
		@IManagedRuntimeService private readonly runtime: IManagedRuntimeService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INotificationService private readonly notificationService: INotificationService,
		@IThreadService private readonly threadService: IThreadService,
		@ILogService private readonly logService: ILogService,
		@IChatSessionsService private readonly chatSessionsService: IChatSessionsService,
		@IChatService private readonly chatService: IChatService,
		@IChatAgentService chatAgentService: IChatAgentService,
	) {
		super();
		this._register(this.runtime.onDidChangeState(state => { this.state = state; this.updateStatus(); }));
		this._register(this.runtime.onDidRequestApproval(request => this.showApproval(request)));
		this._register(this.runtime.onDidNotify(notification => {
			if (notification.kind === 'gatewayMessage') {
				this.logService.info(`[LatentRuntime] ${notification.gatewayId}/${notification.chatId} ${notification.sender}: ${notification.text.slice(0, 80)}`);
			}
		}));
		this._register(this.chatSessionsService.registerChatSessionContribution({
			type: 'latent-runtime', name: 'latent-runtime', displayName: localize('latent.runtime.bots', "Bots"),
			description: localize('latent.runtime.botSessions', "Conversations with your bots"), icon: Codicon.robot.id,
			requiresCopilotSignIn: false, requiresCustomModels: true, supportsAutoModel: true, supportsDelegation: false,
		}));
		this._register(chatAgentService.registerDynamicAgent({
			id: 'latent-runtime', name: 'latent-runtime', fullName: localize('latent.runtime.botAgent', "Bot"),
			extensionId: new ExtensionIdentifier('chatcode.runtime'), extensionVersion: undefined,
			extensionPublisherId: 'chatcode', extensionDisplayName: 'Chatcode', isDefault: false, isDynamic: true, isCore: true,
			metadata: { themeIcon: Codicon.robot }, slashCommands: [], locations: [ChatAgentLocation.Chat],
			modes: [ChatModeKind.Agent, ChatModeKind.Ask], disambiguation: [],
		}, {
			invoke: async (request, progress) => {
				const sessionId = request.sessionResource.path.slice(1);
				const session = (await this.runtime.listSessions()).find(candidate => candidate.sessionId === sessionId);
				if (!session) { throw new Error(localize('latent.runtime.missingSession', "The runtime session is no longer available.")); }
				const result = await this.runtime.runBot(session.botId, { text: request.message, sessionId });
				progress([{ kind: 'markdownContent', content: new MarkdownString(result.text) }]);
				return {};
			},
		}));
		this._register(this.chatSessionsService.registerChatSessionContentProvider('latent-runtime', {
			provideChatSessionContent: async sessionResource => {
				const sessionId = sessionResource.path.slice(1);
				const session = (await this.runtime.listSessions()).find(candidate => candidate.sessionId === sessionId);
				if (!session) { throw new Error(localize('latent.runtime.missingSession', "The runtime session is no longer available.")); }
				return {
					sessionResource, title: session.title,
					history: runtimeSessionHistory(await this.runtime.getSessionTurns(sessionId)),
					isReadOnly: constObservable(!(await this.runtime.listBots()).some(bot => bot.id === session.botId)),
					requestHandler: async (request, progress) => {
						const result = await this.runtime.runBot(session.botId, { text: request.message, sessionId });
						progress([{ kind: 'markdownContent', content: new MarkdownString(result.text) }]);
					},
					onWillDispose: Event.None, dispose() { },
				};
			},
		}));
		this._register(sessionsSearchSources.register({
			id: 'latent.runtime',
			onDidChange: Event.any(Event.map(this.runtime.onDidChangeState, () => undefined), Event.map(this.runtime.onDidNotify, () => undefined)),
			search: async query => {
				if (!this.state?.connected) {
					return [];
				}
				const sessions = await this.runtime.listSessions();
				return sessions.filter(session => !query || `${session.title} ${session.botId}`.toLowerCase().includes(query.toLowerCase())).map(session =>
					this.threadService.adoptSession(URI.from({ scheme: 'latent-runtime', path: `/${session.sessionId}` }), {
						title: `${session.title} (${session.botId})`, origin: 'runtime', createdAt: session.createdAt, updatedAt: session.updatedAt,
					}));
			},
		}));
		this._register(this.configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(LatentSettings.RuntimeEnabled)) {
				void this.syncEnabled();
			}
		}));
		this._register(this.chatService.onDidCreateModel(model => this.trackModel(model)));
		this._register(this.threadService.onDidChangeThreads(() => void this.indexThreads()));
		this.updateStatus();
		void this.syncEnabled();
	}

	private trackModel(model: IChatModel): void {
		const id = model.sessionResource.toString();
		if (this.indexedModels.has(id)) { return; }
		const listeners = new DisposableStore();
		this.indexedModels.set(id, listeners);
		listeners.add(model.onDidChange(event => { if (event.kind === 'completedRequest') { void this.indexThreads(); } }));
		listeners.add(model.onDidDispose(() => this.indexedModels.deleteAndDispose(id)));
	}

	private async syncEnabled(): Promise<void> {
		if (!this.configurationService.getValue<boolean>(LatentSettings.RuntimeEnabled)) {
			return;
		}
		try {
			this.state = await this.runtime.start();
			this.updateStatus();
			await this.indexThreads();
		} catch (error) {
			this.logService.error('[LatentRuntime] Unable to start the runtime.', error);
			this.updateStatus(error instanceof Error ? error.message : String(error));
		}
	}

	/** Pushes workbench Thread turns into the local Recall Index (P1-FR-090). */
	private async indexThreads(): Promise<void> {
		if (!this.state?.connected) {
			return;
		}
		try {
			const turns = [];
			for (const thread of this.threadService.listThreads()) {
				if (thread.origin === 'runtime') { continue; }
				for (const branch of thread.branches) {
					const model = this.chatService.getSession(branch.sessionResource);
					if (model) {
						this.trackModel(model);
						if (model.getRequests().some(request => request.response && !request.response.isComplete)) { continue; }
					}
					for (const turn of await this.threadService.getTurns(thread.id, branch.id)) {
						turns.push({ sessionId: branch.sessionResource.toString(), threadId: thread.id, branchId: branch.id, seq: turn.index * 2 + (turn.role === 'assistant' ? 1 : 0), role: turn.role, blockType: 'text' as const, text: turn.text, timestamp: turn.timestamp, harness: 'workbench', workdir: thread.tabKey?.resource.path ?? '' });
					}
				}
			}
			if (turns.length) {
				await this.runtime.indexTurns(turns);
			}
		} catch (error) {
			this.logService.warn('[LatentRuntime] Thread indexing failed.', error);
		}
	}

	private updateStatus(error?: string): void {
		const enabled = this.configurationService.getValue<boolean>(LatentSettings.RuntimeEnabled);
		if (!enabled) {
			this.statusEntry.clear();
			return;
		}
		const connected = this.state?.connected === true;
		const text = error
			? `$(warning) ${localize('latent.runtime.status.error', "Runtime error")}`
			: connected
				? `$(server-process) ${localize('latent.runtime.status.connected', "Runtime{0}{1}", this.state?.backgroundEnabled ? ' · bg' : '', this.state?.pendingApprovals ? ` · ${this.state.pendingApprovals} approval(s)` : '')}`
				: `$(server-process) ${localize('latent.runtime.status.stopped', "Runtime stopped")}`;
		const entry = {
			name: localize('latent.runtime.status.name', "Latent Runtime"),
			text,
			ariaLabel: text,
			tooltip: error ?? (connected ? localize('latent.runtime.status.tooltip', "Gateways: {0} · next job: {1}", this.state?.gateways.length ?? 0, this.state?.nextJobRuns[0] ? new Date(this.state.nextJobRuns[0].at).toLocaleString() : '—') : localize('latent.runtime.status.stoppedTooltip', "Click to start the managed runtime")),
			command: 'latent.runtime.showBots',
		};
		if (this.statusEntry.value) {
			this.statusEntry.value.update(entry);
		} else {
			this.statusEntry.value = this.statusbarService.addEntry(entry, 'latent.runtime.status', StatusbarAlignment.RIGHT, 90);
		}
	}

	private showApproval(request: IRuntimeApprovalRequest): void {
		const allow = localize('latent.runtime.approve', "Allow");
		const allowScope = localize('latent.runtime.approveScope', "Allow and Add to Scope");
		const deny = localize('latent.runtime.deny', "Deny");
		this.notificationService.prompt(Severity.Warning, localize('latent.runtime.approvalPrompt', "Bot {0} wants to run {1}: {2}", request.botId, request.tool, request.summary), [
			{ label: allow, run: () => void this.runtime.respondToApproval(request.id, 'allow') },
			{ label: allowScope, run: () => void this.runtime.respondToApproval(request.id, 'allowScope') },
			{ label: deny, run: () => void this.runtime.respondToApproval(request.id, 'deny') },
		], { sticky: true });
	}
}

const category = localize2('latent.category', "Latent");

interface IRuntimeCommandServices {
	readonly runtime: IManagedRuntimeService;
	readonly notificationService: INotificationService;
	readonly quickInput: IQuickInputService;
	readonly commandService: ICommandService;
	readonly configurationService: IConfigurationService;
}

/** Extracts every service before the first await (services are only valid synchronously). */
async function withRuntime(accessor: ServicesAccessor, task: (services: IRuntimeCommandServices) => Promise<void>): Promise<void> {
	const services: IRuntimeCommandServices = {
		runtime: accessor.get(IManagedRuntimeService),
		notificationService: accessor.get(INotificationService),
		quickInput: accessor.get(IQuickInputService),
		commandService: accessor.get(ICommandService),
		configurationService: accessor.get(IConfigurationService),
	};
	try {
		await services.runtime.start();
		await task(services);
	} catch (error) {
		services.notificationService.error(error instanceof Error ? error.message : String(error));
	}
}

registerAction2(class extends Action2 {
	constructor() { super({ id: 'latent.runtime.start', title: localize2('latent.runtime.start', "Start Managed Runtime"), category, f1: true }); }
	async run(accessor: ServicesAccessor): Promise<void> {
		await withRuntime(accessor, async ({ configurationService }) => { await configurationService.updateValue(LatentSettings.RuntimeEnabled, true); });
	}
});

registerAction2(class extends Action2 {
	constructor() { super({ id: 'latent.runtime.stop', title: localize2('latent.runtime.stop', "Stop Managed Runtime"), category, f1: true }); }
	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IManagedRuntimeService).stop();
	}
});

registerAction2(class extends Action2 {
	constructor() { super({ id: 'latent.runtime.showBots', title: localize2('latent.runtime.showBots', "Show Bots"), category, f1: true }); }
	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ICommandService).executeCommand(`${LatentBotsViewId}.focus`);
	}
});

registerAction2(class extends Action2 {
	constructor() { super({ id: 'latent.runtime.toggleBackground', title: localize2('latent.runtime.toggleBackground', "Toggle Runtime Background Mode"), category, f1: true }); }
	async run(accessor: ServicesAccessor): Promise<void> {
		await withRuntime(accessor, async ({ runtime, configurationService, notificationService }) => {
			const state = await runtime.getState();
			const next = await runtime.setBackgroundEnabled(!state.backgroundEnabled);
			await configurationService.updateValue(LatentSettings.RuntimeBackgroundEnabled, next.backgroundEnabled);
			notificationService.info(next.backgroundEnabled
				? localize('latent.runtime.backgroundOn', "The runtime now keeps running after the last window closes and after the application quits.")
				: localize('latent.runtime.backgroundOff', "The runtime stops together with the application."));
		});
	}
});

registerAction2(class extends Action2 {
	constructor() { super({ id: 'latent.runtime.addGateway', title: localize2('latent.runtime.addGateway', "Add Gateway"), category, f1: true }); }
	async run(accessor: ServicesAccessor): Promise<void> {
		await withRuntime(accessor, async ({ runtime, quickInput, notificationService }) => {
			const platform = await quickInput.pick([{ label: 'Telegram', id: 'telegram' }, { label: 'Webhook', id: 'webhook' }], { placeHolder: localize('latent.runtime.pickPlatform', "Gateway platform") });
			if (!platform?.id) {
				return;
			}
			const name = await quickInput.input({ prompt: localize('latent.runtime.gatewayName', "Gateway name") });
			if (!name) {
				return;
			}
			const bots = await runtime.listBots();
			const bot = bots.length ? await quickInput.pick(bots.map(candidate => ({ label: candidate.name, id: candidate.id })), { placeHolder: localize('latent.runtime.pickBot', "Bot that answers on this gateway") }) : undefined;
			const config: IGatewayConfig = { id: generateUuid(), platform: platform.id as IGatewayConfig['platform'], name, enabled: true, botId: bot?.id, allowedSenders: [], options: {} };
			let secret: string | undefined;
			if (platform.id === 'telegram') {
				secret = await quickInput.input({ prompt: localize('latent.runtime.telegramToken', "Telegram bot token"), password: true });
				if (!secret) {
					return;
				}
			} else {
				const port = await quickInput.input({ prompt: localize('latent.runtime.webhookPort', "Local port for POST /inbound (0 = random)"), value: '0' });
				const callbackUrl = await quickInput.input({ prompt: localize('latent.runtime.callbackUrl', "Callback URL that receives replies (optional)") });
				secret = await quickInput.input({ prompt: localize('latent.runtime.webhookSecret', "Shared secret sent as x-latent-secret (optional)"), password: true });
				(config.options as Record<string, string | number>).port = Number(port) || 0;
				if (callbackUrl) {
					(config.options as Record<string, string | number>).callbackUrl = callbackUrl;
				}
			}
			await runtime.upsertGateway(config, secret || undefined);
			const pairing = await runtime.pair(config.id);
			notificationService.info(localize('latent.runtime.pairingCode', "Gateway {0} added. Pairing code (10 minutes): {1}", name, pairing.code));
		});
	}
});

registerAction2(class extends Action2 {
	constructor() { super({ id: 'latent.runtime.createBot', title: localize2('latent.runtime.createBot', "Create Bot"), category, f1: true }); }
	async run(accessor: ServicesAccessor): Promise<void> {
		await withRuntime(accessor, async ({ runtime, quickInput, commandService, notificationService }) => {
			const name = await quickInput.input({ prompt: localize('latent.runtime.botName', "Bot name") });
			if (!name) {
				return;
			}
			const systemPrompt = await quickInput.input({ prompt: localize('latent.runtime.botPrompt', "System prompt"), value: localize('latent.runtime.botPromptDefault', "You are a helpful assistant.") });
			const binding = await commandService.executeCommand<IModelBinding | undefined>('latent.provider.exportModelBinding', 'text');
			if (!binding) {
				await commandService.executeCommand('latent.provider.guide', 'text', name);
				return;
			}
			const bindingId = `${binding.providerId}:${binding.modelId}`;
			await runtime.setModelBinding(bindingId, binding);
			const scope = await quickInput.pick([
				{ label: localize('latent.runtime.scope.read', "Read-only in the bot workspace, ask for everything else"), id: 'read' },
				{ label: localize('latent.runtime.scope.workspace', "Read and write in the bot workspace, ask for network"), id: 'workspace' },
			], { placeHolder: localize('latent.runtime.pickScope', "Tool authorization scope") });
			const bot: IBotConfig = {
				id: generateUuid(),
				name,
				systemPrompt: systemPrompt ?? '',
				execution: { kind: 'provider', modelBindingId: bindingId },
				toolAuthorizationScope: scope?.id === 'workspace'
					? { allowTools: ['read_file', 'write_file', 'list_dir', 'session_search', 'memory', 'recall', 'memory_write', 'create_artifact'], allowPaths: ['**'], allowNetwork: [], autoApprove: true }
					: { allowTools: ['read_file', 'list_dir', 'session_search', 'recall'], allowPaths: ['**'], allowNetwork: [], autoApprove: true },
				capabilities: [],
			};
			await runtime.upsertBot(bot);
			notificationService.info(localize('latent.runtime.botCreated', "Bot {0} created.", name));
		});
	}
});

registerAction2(class extends Action2 {
	constructor() { super({ id: 'latent.runtime.restoreBotPresets', title: localize2('latent.runtime.restoreBotPresets', "Restore Default Bots"), category, f1: true }); }
	async run(accessor: ServicesAccessor): Promise<void> {
		await withRuntime(accessor, async ({ runtime, quickInput, notificationService }) => {
			const presets = await runtime.listBotPresets();
			if (!presets.length) {
				notificationService.info(localize('latent.runtime.noPresets', "No extension provides default Bots."));
				return;
			}
			const existing = new Set((await runtime.listBots()).map(bot => bot.id));
			const picked = await quickInput.pick(presets.map(preset => ({
				label: preset.bot.name,
				description: existing.has(preset.bot.id) ? preset.owner : localize('latent.runtime.presetDeleted', "{0} · deleted", preset.owner),
				id: preset.bot.id,
				picked: true,
			})), { canPickMany: true, placeHolder: localize('latent.runtime.pickPresets', "Bots to reset to their defaults; your changes to them are replaced") });
			if (!picked?.length) {
				return;
			}
			const restored = await runtime.restoreBotPresets({ botIds: picked.map(item => item.id) });
			notificationService.info(localize('latent.runtime.presetsRestored', "{0} Bots restored to their defaults.", restored.length));
		});
	}
});

registerAction2(class extends Action2 {
	constructor() { super({ id: 'latent.runtime.createJob', title: localize2('latent.runtime.createJob', "Create Scheduled Job"), category, f1: true }); }
	async run(accessor: ServicesAccessor): Promise<void> {
		await withRuntime(accessor, async ({ runtime, quickInput, notificationService }) => {
			const bots = await runtime.listBots();
			if (!bots.length) {
				notificationService.info(localize('latent.runtime.noBots', "Create a bot first."));
				return;
			}
			const bot = await quickInput.pick(bots.map(candidate => ({ label: candidate.name, id: candidate.id })), { placeHolder: localize('latent.runtime.pickBot', "Bot that answers on this gateway") });
			const name = bot && await quickInput.input({ prompt: localize('latent.runtime.jobName', "Job name") });
			const schedule = name && await quickInput.input({ prompt: localize('latent.runtime.jobSchedule', "Schedule: 'every 30m', 'cron: 0 9 * * 1-5', or 'at 2026-09-19T08:00:00Z'"), value: 'every 1h' });
			const prompt = schedule && await quickInput.input({ prompt: localize('latent.runtime.jobPrompt', "Prompt to run") });
			if (!bot?.id || !name || !schedule || !prompt) {
				return;
			}
			const job: IScheduledJob = { id: generateUuid(), name, botId: bot.id, prompt, schedule, enabled: true };
			await runtime.upsertJob(job);
		});
	}
});

registerAction2(class extends Action2 {
	constructor() { super({ id: 'latent.runtime.toggleMemoryAdapter', title: localize2('latent.runtime.toggleMemoryAdapter', "Enable or Disable Memory Adapter"), category, f1: true }); }
	async run(accessor: ServicesAccessor, adapterId?: string): Promise<void> {
		await withRuntime(accessor, async ({ runtime, quickInput }) => {
			const adapters = await runtime.listMemoryAdapters();
			const picked = typeof adapterId === 'string' && adapters.some(adapter => adapter.id === adapterId) ? { id: adapterId } : await quickInput.pick(adapters.map(adapter => ({ label: adapter.displayName, description: adapter.enabled ? localize('latent.bots.enabled', "enabled") : localize('latent.bots.disabled', "disabled"), id: adapter.id })), { placeHolder: localize('latent.runtime.pickAdapter', "Memory adapter") });
			if (!picked?.id) {
				return;
			}
			const current = adapters.find(adapter => adapter.id === picked.id)!;
			if (current.enabled) {
				await runtime.setMemoryAdapterEnabled(picked.id, false);
				return;
			}
			const secret = await quickInput.input({ prompt: localize('latent.runtime.adapterKey', "API key for {0}", current.displayName), password: true });
			if (!secret) {
				return;
			}
			await runtime.setMemoryAdapterEnabled(picked.id, true, secret);
		});
	}
});

registerAction2(class extends Action2 {
	constructor() { super({ id: 'latent.memory.reviewAdapter', title: localize2('latent.memory.reviewAdapter', "Review Memory Adapter Copy"), category, f1: true }); }
	async run(accessor: ServicesAccessor, adapterId?: string): Promise<void> {
		const editorService = accessor.get(IEditorService);
		await withRuntime(accessor, services => reviewMemoryAdapter({ ...services, editorService }, typeof adapterId === 'string' ? adapterId : undefined));
	}
});

registerAction2(class extends Action2 {
	constructor() { super({ id: 'latent.memory.reviewBot', title: localize2('latent.memory.reviewBot', "Open Bot Memory Profile"), category, f1: true }); }
	async run(accessor: ServicesAccessor, botId?: string): Promise<void> {
		const editorService = accessor.get(IEditorService);
		await withRuntime(accessor, services => reviewBotMemory({ ...services, editorService }, typeof botId === 'string' ? botId : undefined));
	}
});

registerAction2(class extends Action2 {
	constructor() { super({ id: 'latent.memory.recall', title: localize2('latent.memory.recall', "Recall from Memory"), category, f1: true, icon: Codicon.search }); }
	async run(accessor: ServicesAccessor): Promise<void> {
		await withRuntime(accessor, async ({ runtime, quickInput, notificationService }) => {
			const query = await quickInput.input({ prompt: localize('latent.memory.query', "What do you want to recall?") });
			if (!query) {
				return;
			}
			const hits = await runtime.recall(query, { k: 8 });
			if (!hits.length) {
				notificationService.info(localize('latent.memory.noResults', "no results"));
				return;
			}
			await quickInput.pick(hits.map(hit => ({ label: hit.text.replace(/\s+/g, ' ').slice(0, 100), description: `${hit.role} · ${new Date(hit.timestamp).toLocaleString()} · ${hit.score.toFixed(3)}`, detail: hit.agentFormat.split('\n')[1] })), { placeHolder: localize('latent.memory.results', "Recalled passages (provenance in the detail line)") });
		});
	}
});
