/* eslint-disable header/header */
/**
 * Wire contracts of the Managed Runtime (spec 01 §2.8, §4). Shared by the
 * runtime process, the main-process supervisor, and the workbench.
 */

export const RUNTIME_PROTOCOL_VERSION = 'latent.runtime/1';

export interface IGatewayHealth {
	readonly id: string;
	readonly platform: string;
	readonly connected: boolean;
	readonly degraded: boolean;
	readonly lastError?: string;
	readonly pendingDeliveries: number;
}

export interface IFunesState {
	readonly available: boolean;
	readonly version?: string;
	readonly indexedAt?: number;
	readonly lastError?: string;
}

export interface IRuntimeState {
	readonly connected: boolean;
	readonly funes?: IFunesState;
	readonly backgroundEnabled: boolean;
	readonly version: string;
	readonly pid?: number;
	readonly startedAt?: number;
	readonly gateways: readonly IGatewayHealth[];
	readonly nextJobRuns: readonly { readonly jobId: string; readonly name: string; readonly at: number }[];
	readonly pendingApprovals: number;
}

/** Built-in platforms are `webhook` and `telegram`; runtime plugins add more (`latent.gatewayPlatforms`). */
export type GatewayPlatform = string;

export interface IGatewayConfig {
	readonly id: string;
	readonly platform: GatewayPlatform;
	readonly name: string;
	readonly enabled: boolean;
	/** Bot that answers messages arriving through this gateway. */
	readonly botId?: string;
	/** Sender identifiers allowed to talk to the bot; empty means pairing is required (Hermes pairing model). */
	readonly allowedSenders: readonly string[];
	readonly options: Readonly<Record<string, string | number | boolean>>;
}

export interface IPairingCode {
	readonly gatewayId: string;
	readonly code: string;
	readonly expiresAt: number;
}

export interface IToolAuthorizationScope {
	readonly allowTools: readonly string[];
	readonly allowPaths: readonly string[];
	readonly allowNetwork: readonly string[];
	readonly autoApprove: boolean;
}

export interface IModelBinding {
	readonly providerId: string;
	readonly modelId: string;
	readonly protocol: string;
	readonly baseUrl: string;
	/** Present only when the binding is stored; the runtime keeps it in its encrypted secret file. */
	readonly apiKey?: string;
}

export interface IBotConfig {
	readonly id: string;
	readonly name: string;
	readonly systemPrompt: string;
	readonly pinned?: boolean;
	readonly hidden?: boolean;
	readonly section?: string;
	readonly execution: { readonly kind: 'provider'; readonly modelBindingId: string } | { readonly kind: 'harness'; readonly harness: 'copilot' | 'codex' | 'claude' };
	readonly toolAuthorizationScope: IToolAuthorizationScope;
	readonly capabilities: readonly string[];
	readonly workingDirectory?: string;
	/** Bots this Bot may delegate work to with the built-in `handoff` tool. */
	readonly handoffTargets?: readonly string[];
}

/** A default Bot contributed by an extension; the runtime creates it once and can restore it later. */
export interface IBotPreset {
	/** Contributor of the preset, for example an extension id. */
	readonly owner: string;
	readonly bot: IBotConfig;
}

export interface IBotInput {
	readonly text: string;
	readonly sessionId?: string;
	readonly gatewayId?: string;
	readonly chatId?: string;
	readonly sender?: string;
}

export interface IRuntimeSessionRef {
	readonly sessionId: string;
	readonly botId: string;
	readonly title: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly origin: 'workbench' | 'gateway' | 'job';
}

export interface IRuntimeSessionTurn {
	readonly seq: number;
	readonly role: 'user' | 'assistant' | 'tool';
	readonly text: string;
	readonly timestamp: number;
}

export interface IRuntimeApprovalRequest {
	readonly id: string;
	readonly botId: string;
	readonly sessionId: string;
	readonly tool: string;
	readonly summary: string;
	readonly gatewayId?: string;
	readonly chatId?: string;
	readonly expiresAt: number;
}

export type ApprovalDecision = 'allow' | 'deny' | 'allowScope';

export interface IRecallOptions {
	readonly excludeSessionId?: string;
	readonly k?: number;
	readonly candidates?: number;
	readonly halfLifeDays?: number;
	readonly neighbors?: number;
	readonly type?: 'text' | 'thinking' | 'tool_use' | 'tool_result';
	readonly harness?: string;
}

export interface IRecallHit {
	readonly sessionId: string;
	readonly threadId?: string;
	readonly branchId?: string;
	readonly seq: number;
	readonly timestamp: number;
	readonly harness: string;
	readonly workdir: string;
	readonly blockType: string;
	readonly role: string;
	readonly score: number;
	readonly text: string;
	readonly neighbors: readonly { readonly seq: number; readonly role: string; readonly preview: string }[];
	/** The stable Funes-style agent format line block. */
	readonly agentFormat: string;
}

export interface IIndexedTurn {
	readonly sessionId: string;
	readonly threadId?: string;
	readonly branchId?: string;
	readonly seq: number;
	readonly role: 'user' | 'assistant' | 'tool';
	readonly blockType: 'text' | 'thinking' | 'tool_use' | 'tool_result';
	readonly text: string;
	readonly timestamp: number;
	readonly harness: string;
	readonly workdir: string;
}

export interface IMemoryWriteOp {
	readonly action: 'add' | 'replace' | 'remove';
	readonly operations?: readonly { readonly action: 'add' | 'replace' | 'remove'; readonly content?: string; readonly oldText?: string }[];
	readonly target: 'memory' | 'user';
	readonly content?: string;
	readonly oldText?: string;
}

export interface IMemoryWriteResult {
	readonly applied: boolean;
	/** Destructive changes are staged until confirmed (Hermes write gate). */
	readonly staged?: { readonly id: string; readonly summary: string };
	readonly message?: string;
}

export interface IMemorySnapshot {
	readonly directory?: string;
	readonly memory: string;
	readonly user: string;
	readonly entries: readonly { readonly file: string; readonly title: string; readonly updatedAt: number }[];
	readonly staged: readonly { readonly id: string; readonly summary: string }[];
}

export interface IMemoryAdapterState {
	readonly id: string;
	readonly displayName: string;
	readonly enabled: boolean;
	readonly degraded: boolean;
	readonly lastError?: string;
}

export interface IRuntimeCapability {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly path: string;
	readonly source: string;
}

export interface ICapabilitySource {
	readonly kind: 'path' | 'git';
	readonly location: string;
}

export interface IArtifact {
	readonly id: string;
	readonly sessionId: string;
	readonly botId: string;
	readonly name: string;
	readonly path: string;
	readonly mimeType: string;
	readonly size: number;
	readonly createdAt: number;
}

export interface IScheduledJob {
	readonly id: string;
	readonly name: string;
	readonly botId: string;
	readonly prompt: string;
	/** `cron: * * * * *`, `every 30m`, or `at 2026-09-19T08:00:00Z`. */
	readonly schedule: string;
	readonly enabled: boolean;
	readonly allowOverlap?: boolean;
	readonly deliverTo?: { readonly gatewayId: string; readonly chatId: string };
	readonly lastRunAt?: number;
	readonly nextRunAt?: number;
	readonly lastStatus?: 'succeeded' | 'failed' | 'skipped';
}

export interface IJobExecution {
	readonly id: string;
	readonly jobId: string;
	readonly startedAt: number;
	readonly finishedAt?: number;
	readonly status: 'running' | 'succeeded' | 'failed' | 'skipped';
	readonly lateness: 'onTime' | 'late' | 'catchUp';
	readonly sessionId?: string;
	readonly error?: string;
}

/** Notifications the runtime pushes to connected clients. */
export type RuntimeNotification =
	| { readonly kind: 'state'; readonly state: IRuntimeState }
	| { readonly kind: 'approvalRequested'; readonly request: IRuntimeApprovalRequest }
	| { readonly kind: 'approvalResolved'; readonly id: string; readonly decision: ApprovalDecision | 'timeout' }
	| { readonly kind: 'sessionUpdated'; readonly session: IRuntimeSessionRef }
	| { readonly kind: 'gatewayMessage'; readonly gatewayId: string; readonly chatId: string; readonly sender: string; readonly text: string };

/** RPC method names; parameters and results are the interfaces above. */
export const RuntimeMethods = {
	Auth: 'auth',
	GetState: 'runtime.getState',
	Shutdown: 'runtime.shutdown',
	ListGateways: 'gateways.list',
	UpsertGateway: 'gateways.upsert',
	RemoveGateway: 'gateways.remove',
	Pair: 'gateways.pair',
	ListBots: 'bots.list',
	UpsertBot: 'bots.upsert',
	RemoveBot: 'bots.remove',
	RunBot: 'bots.run',
	RegisterBotPresets: 'bots.presets.register',
	ListBotPresets: 'bots.presets.list',
	RestoreBotPresets: 'bots.presets.restore',
	ListSessions: 'sessions.list',
	CreateSession: 'sessions.create',
	GetSessionTurns: 'sessions.turns',
	ListApprovals: 'approvals.list',
	RespondToApproval: 'approvals.respond',
	SetModelBinding: 'models.setBinding',
	ListModelBindings: 'models.listBindings',
	Recall: 'memory.recall',
	IndexTurns: 'memory.indexTurns',
	MemoryWrite: 'memory.write',
	MemoryConfirm: 'memory.confirmStaged',
	MemorySnapshot: 'memory.snapshot',
	MemoryPrompt: 'memory.prompt',
	MemoryReview: 'memory.review',
	MemoryCheckpoint: 'memory.checkpoint',
	SessionSearch: 'memory.sessionSearch',
	ListMemoryAdapters: 'memory.adapters.list',
	SetMemoryAdapterEnabled: 'memory.adapters.setEnabled',
	RebuildRecallIndex: 'memory.rebuildIndex',
	ListCapabilities: 'capabilities.list',
	RemoveCapability: 'capabilities.remove',
	InstallCapability: 'capabilities.install',
	ListArtifacts: 'artifacts.list',
	RemoveArtifact: 'artifacts.remove',
	ListJobs: 'jobs.list',
	UpsertJob: 'jobs.upsert',
	RemoveJob: 'jobs.remove',
	RunJobNow: 'jobs.runNow',
	ListJobExecutions: 'jobs.executions',
	Deliver: 'gateways.deliver',
	AddArtifact: 'artifacts.add',
	CompareMemoryAdapter: 'memory.adapters.compare',
	ResolveMemoryComparison: 'memory.adapters.resolve',
	RegisterPlugin: 'plugins.register',
	ListPlugins: 'plugins.list',
	SetPluginSecret: 'plugins.setSecret',
} as const;
