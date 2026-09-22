/* eslint-disable header/header */
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILatentRuntimeService } from '../../../../../platform/latentRuntime/common/latentRuntime.js';
import { IMemoryComparisonEntry, IRuntimePluginRecord, IRuntimePluginState, MemoryComparisonDecision } from '../../../../../platform/latentRuntime/common/runtimePlugin.js';
import { ApprovalDecision, IArtifact, IBotConfig, IBotInput, IBotPreset, ICapabilitySource, IGatewayConfig, IIndexedTurn, IJobExecution, IMemoryAdapterState, IMemorySnapshot, IMemoryWriteOp, IMemoryWriteResult, IModelBinding, IPairingCode, IRecallHit, IRecallOptions, IRuntimeApprovalRequest, IRuntimeCapability, IRuntimeQuestionRequest, IRuntimeSessionRef, IRuntimeSessionTurn, IRuntimeState, IScheduledJob, RuntimeMethods, RuntimeNotification } from '../../../../../platform/latentRuntime/common/runtimeProtocol.js';

export const IManagedRuntimeService = createDecorator<IManagedRuntimeService>('latentManagedRuntimeService');

/** Typed workbench facade over the runtime RPC (spec 01 §4 `IManagedRuntimeService`). */
export interface IManagedRuntimeService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeState: Event<IRuntimeState>;
	readonly onDidRequestApproval: Event<IRuntimeApprovalRequest>;
	readonly onDidNotify: Event<RuntimeNotification>;
	getState(): Promise<IRuntimeState>;
	start(): Promise<IRuntimeState>;
	stop(): Promise<void>;
	setBackgroundEnabled(enabled: boolean): Promise<IRuntimeState>;
	listGateways(): Promise<readonly IGatewayConfig[]>;
	upsertGateway(config: IGatewayConfig, secret?: string): Promise<void>;
	removeGateway(id: string): Promise<void>;
	pair(gatewayId: string): Promise<IPairingCode>;
	listBots(): Promise<readonly IBotConfig[]>;
	upsertBot(config: IBotConfig): Promise<void>;
	removeBot(id: string): Promise<void>;
	runBot(botId: string, input: IBotInput): Promise<{ session: IRuntimeSessionRef; text: string }>;
	interruptBot(requestId: string): Promise<boolean>;
	/** Replaces the Bot presets of `owner`; Bots of new presets are created once. Returns the ids created. */
	registerBotPresets(owner: string, bots: readonly IBotConfig[]): Promise<readonly string[]>;
	listBotPresets(): Promise<readonly IBotPreset[]>;
	/** Resets the matching Bots to their presets. Returns the ids restored. */
	restoreBotPresets(filter?: { owner?: string; botIds?: readonly string[] }): Promise<readonly string[]>;
	createSession(botId: string): Promise<IRuntimeSessionRef>;
	listSessions(): Promise<readonly IRuntimeSessionRef[]>;
	getSessionTurns(sessionId: string): Promise<readonly IRuntimeSessionTurn[]>;
	listApprovals(): Promise<readonly IRuntimeApprovalRequest[]>;
	respondToApproval(requestId: string, decision: ApprovalDecision): Promise<void>;
	listQuestions(): Promise<readonly IRuntimeQuestionRequest[]>;
	respondToQuestion(id: string, answers: Readonly<Record<string, string>>): Promise<void>;
	setModelBinding(id: string, binding: IModelBinding): Promise<void>;
	listModelBindings(): Promise<readonly { id: string; providerId?: string; modelId?: string; protocol?: string }[]>;
	recall(query: string, options?: IRecallOptions): Promise<readonly IRecallHit[]>;
	indexTurns(turns: readonly IIndexedTurn[]): Promise<number>;
	memoryWrite(op: IMemoryWriteOp): Promise<IMemoryWriteResult>;
	memoryConfirm(id: string, accept: boolean): Promise<IMemoryWriteResult>;
	memoryPrompt(sessionId: string): Promise<string>;
	memoryReview(response?: string): Promise<unknown>;
	memoryCheckpoint(sessionId: string, messages: { role: 'user' | 'assistant' | 'tool'; text: string }[]): Promise<unknown>;
	sessionSearch(options: { query?: string; sessionId?: string; from?: number; to?: number; excludeSessionId?: string }): Promise<string>;
	memorySnapshot(): Promise<IMemorySnapshot>;
	listMemoryAdapters(): Promise<readonly IMemoryAdapterState[]>;
	setMemoryAdapterEnabled(id: string, enabled: boolean, secret?: string, baseUrl?: string): Promise<void>;
	removeCapability(id: string): Promise<void>;
	removeArtifact(id: string): Promise<void>;
	listCapabilities(): Promise<readonly IRuntimeCapability[]>;
	installCapability(source: ICapabilitySource): Promise<IRuntimeCapability>;
	listArtifacts(filter?: { sessionId?: string; botId?: string }): Promise<readonly IArtifact[]>;
	listJobs(): Promise<readonly IScheduledJob[]>;
	upsertJob(job: IScheduledJob): Promise<IScheduledJob>;
	removeJob(id: string): Promise<void>;
	runJobNow(id: string): Promise<{ sessionId: string } | undefined>;
	listJobExecutions(jobId?: string): Promise<readonly IJobExecution[]>;
	/** Queues a message in a gateway's delivery ledger. */
	deliver(gatewayId: string, chatId: string, text: string): Promise<void>;
	/** Stores a file produced outside a bot run (for example by an extension) with provenance. */
	addArtifact(artifact: { sessionId?: string; botId: string; name: string; content?: string; contentBase64?: string; mimeType?: string }): Promise<IArtifact>;
	compareMemoryAdapter(id: string): Promise<readonly IMemoryComparisonEntry[]>;
	/** Settles one compared entry: `keepLocal` writes the local version to the adapter, `takeRemote` writes the adapter's version locally. */
	resolveMemoryComparison(adapterId: string, entry: IMemoryComparisonEntry, decision: MemoryComparisonDecision): Promise<void>;
	registerPlugin(record: IRuntimePluginRecord): Promise<IRuntimePluginState>;
	listPlugins(): Promise<readonly IRuntimePluginState[]>;
	/** Stores (or with an empty value deletes) a secret readable only by that plugin. */
	setPluginSecret(pluginId: string, key: string, value: string | undefined): Promise<void>;
}

export class ManagedRuntimeService extends Disposable implements IManagedRuntimeService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidRequestApproval = this._register(new Emitter<IRuntimeApprovalRequest>());
	readonly onDidRequestApproval = this._onDidRequestApproval.event;
	readonly onDidChangeState: Event<IRuntimeState>;
	readonly onDidNotify: Event<RuntimeNotification>;

	constructor(@ILatentRuntimeService private readonly runtime: ILatentRuntimeService) {
		super();
		this.onDidChangeState = runtime.onDidChangeState;
		this.onDidNotify = runtime.onDidNotify;
		this._register(runtime.onDidNotify(notification => {
			if (notification.kind === 'approvalRequested') {
				this._onDidRequestApproval.fire(notification.request);
			}
		}));
	}

	getState(): Promise<IRuntimeState> { return this.runtime.getState(); }
	start(): Promise<IRuntimeState> { return this.runtime.start(); }
	stop(): Promise<void> { return this.runtime.stop(); }
	setBackgroundEnabled(enabled: boolean): Promise<IRuntimeState> { return this.runtime.setBackgroundEnabled(enabled); }
	listGateways(): Promise<readonly IGatewayConfig[]> { return this.runtime.call(RuntimeMethods.ListGateways); }
	async upsertGateway(config: IGatewayConfig, secret?: string): Promise<void> { await this.runtime.call(RuntimeMethods.UpsertGateway, { config, secret }); }
	async removeGateway(id: string): Promise<void> { await this.runtime.call(RuntimeMethods.RemoveGateway, { id }); }
	pair(gatewayId: string): Promise<IPairingCode> { return this.runtime.call(RuntimeMethods.Pair, { gatewayId }); }
	listBots(): Promise<readonly IBotConfig[]> { return this.runtime.call(RuntimeMethods.ListBots); }
	async upsertBot(config: IBotConfig): Promise<void> { await this.runtime.call(RuntimeMethods.UpsertBot, config); }
	async removeBot(id: string): Promise<void> { await this.runtime.call(RuntimeMethods.RemoveBot, { id }); }
	interruptBot(requestId: string): Promise<boolean> { return this.runtime.call(RuntimeMethods.InterruptBot, { requestId }); }
	runBot(botId: string, input: IBotInput): Promise<{ session: IRuntimeSessionRef; text: string }> { return this.runtime.call(RuntimeMethods.RunBot, { botId, input }); }
	async registerBotPresets(owner: string, bots: readonly IBotConfig[]): Promise<readonly string[]> { return (await this.runtime.call<{ created: string[] }>(RuntimeMethods.RegisterBotPresets, { owner, bots })).created; }
	listBotPresets(): Promise<readonly IBotPreset[]> { return this.runtime.call(RuntimeMethods.ListBotPresets); }
	async restoreBotPresets(filter?: { owner?: string; botIds?: readonly string[] }): Promise<readonly string[]> { return (await this.runtime.call<{ restored: string[] }>(RuntimeMethods.RestoreBotPresets, filter ?? {})).restored; }
	createSession(botId: string): Promise<IRuntimeSessionRef> { return this.runtime.call(RuntimeMethods.CreateSession, { botId }); }
	async removeCapability(id: string): Promise<void> { await this.runtime.call(RuntimeMethods.RemoveCapability, { id }); }
	async removeArtifact(id: string): Promise<void> { await this.runtime.call(RuntimeMethods.RemoveArtifact, { id }); }
	listSessions(): Promise<readonly IRuntimeSessionRef[]> { return this.runtime.call(RuntimeMethods.ListSessions); }
	getSessionTurns(sessionId: string): Promise<readonly IRuntimeSessionTurn[]> { return this.runtime.call(RuntimeMethods.GetSessionTurns, { sessionId }); }
	listApprovals(): Promise<readonly IRuntimeApprovalRequest[]> { return this.runtime.call(RuntimeMethods.ListApprovals); }
	async respondToApproval(requestId: string, decision: ApprovalDecision): Promise<void> { await this.runtime.call(RuntimeMethods.RespondToApproval, { id: requestId, decision }); }
	listQuestions(): Promise<readonly IRuntimeQuestionRequest[]> { return this.runtime.call(RuntimeMethods.ListQuestions); }
	async respondToQuestion(id: string, answers: Readonly<Record<string, string>>): Promise<void> { await this.runtime.call(RuntimeMethods.RespondToQuestion, { id, answers }); }
	async setModelBinding(id: string, binding: IModelBinding): Promise<void> { await this.runtime.call(RuntimeMethods.SetModelBinding, { id, binding }); }
	listModelBindings(): Promise<readonly { id: string; providerId?: string; modelId?: string; protocol?: string }[]> { return this.runtime.call(RuntimeMethods.ListModelBindings); }
	recall(query: string, options?: IRecallOptions): Promise<readonly IRecallHit[]> { return this.runtime.call(RuntimeMethods.Recall, { query, options }); }
	async indexTurns(turns: readonly IIndexedTurn[]): Promise<number> { return (await this.runtime.call<{ indexed: number }>(RuntimeMethods.IndexTurns, { turns })).indexed; }
	memoryWrite(op: IMemoryWriteOp): Promise<IMemoryWriteResult> { return this.runtime.call(RuntimeMethods.MemoryWrite, op); }
	memoryConfirm(id: string, accept: boolean): Promise<IMemoryWriteResult> { return this.runtime.call(RuntimeMethods.MemoryConfirm, { id, accept }); }
	memoryPrompt(sessionId: string): Promise<string> { return this.runtime.call(RuntimeMethods.MemoryPrompt, { sessionId }); }
	memoryReview(response?: string): Promise<unknown> { return this.runtime.call(RuntimeMethods.MemoryReview, { response }); }
	memoryCheckpoint(sessionId: string, messages: { role: 'user' | 'assistant' | 'tool'; text: string }[]): Promise<unknown> { return this.runtime.call(RuntimeMethods.MemoryCheckpoint, { sessionId, messages }); }
	sessionSearch(options: { query?: string; sessionId?: string; from?: number; to?: number; excludeSessionId?: string }): Promise<string> { return this.runtime.call(RuntimeMethods.SessionSearch, options); }
	memorySnapshot(): Promise<IMemorySnapshot> { return this.runtime.call(RuntimeMethods.MemorySnapshot); }
	listMemoryAdapters(): Promise<readonly IMemoryAdapterState[]> { return this.runtime.call(RuntimeMethods.ListMemoryAdapters); }
	async setMemoryAdapterEnabled(id: string, enabled: boolean, secret?: string, baseUrl?: string): Promise<void> { await this.runtime.call(RuntimeMethods.SetMemoryAdapterEnabled, { id, enabled, secret, baseUrl }); }
	listCapabilities(): Promise<readonly IRuntimeCapability[]> { return this.runtime.call(RuntimeMethods.ListCapabilities); }
	installCapability(source: ICapabilitySource): Promise<IRuntimeCapability> { return this.runtime.call(RuntimeMethods.InstallCapability, source); }
	listArtifacts(filter?: { sessionId?: string; botId?: string }): Promise<readonly IArtifact[]> { return this.runtime.call(RuntimeMethods.ListArtifacts, filter ?? {}); }
	listJobs(): Promise<readonly IScheduledJob[]> { return this.runtime.call(RuntimeMethods.ListJobs); }
	upsertJob(job: IScheduledJob): Promise<IScheduledJob> { return this.runtime.call(RuntimeMethods.UpsertJob, job); }
	async removeJob(id: string): Promise<void> { await this.runtime.call(RuntimeMethods.RemoveJob, { id }); }
	runJobNow(id: string): Promise<{ sessionId: string } | undefined> { return this.runtime.call(RuntimeMethods.RunJobNow, { id }); }
	listJobExecutions(jobId?: string): Promise<readonly IJobExecution[]> { return this.runtime.call(RuntimeMethods.ListJobExecutions, { jobId }); }
	async deliver(gatewayId: string, chatId: string, text: string): Promise<void> { await this.runtime.call(RuntimeMethods.Deliver, { gatewayId, chatId, text }); }
	addArtifact(artifact: { sessionId?: string; botId: string; name: string; content?: string; contentBase64?: string; mimeType?: string }): Promise<IArtifact> { return this.runtime.call(RuntimeMethods.AddArtifact, artifact); }
	compareMemoryAdapter(id: string): Promise<readonly IMemoryComparisonEntry[]> { return this.runtime.call(RuntimeMethods.CompareMemoryAdapter, { id }); }
	async resolveMemoryComparison(adapterId: string, entry: IMemoryComparisonEntry, decision: MemoryComparisonDecision): Promise<void> { await this.runtime.call(RuntimeMethods.ResolveMemoryComparison, { id: adapterId, entry, decision }); }
	registerPlugin(record: IRuntimePluginRecord): Promise<IRuntimePluginState> { return this.runtime.call(RuntimeMethods.RegisterPlugin, record); }
	listPlugins(): Promise<readonly IRuntimePluginState[]> { return this.runtime.call(RuntimeMethods.ListPlugins); }
	async setPluginSecret(pluginId: string, key: string, value: string | undefined): Promise<void> { await this.runtime.call(RuntimeMethods.SetPluginSecret, { pluginId, key, value }); }
}
