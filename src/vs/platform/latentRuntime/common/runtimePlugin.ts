/* eslint-disable header/header */
/**
 * Contract of Managed Runtime plugins (spec 01 §4: the `latent.gatewayPlatforms`,
 * `latent.botTools`, and `latent.memoryAdapters` runtime registries).
 *
 * A plugin is an ES module on disk that exports `activate(host: IRuntimePluginHost)`.
 * Extensions register the module path through `latent.runtime.api.registerPlugin`;
 * the runtime process imports it on start and whenever it is registered again.
 * Plugins run inside the runtime process and must not import `vs/*` modules; the
 * types below are structural so plugin authors can copy them.
 */

import { IBotInput, IGatewayConfig, IGatewayHealth, IMemorySnapshot, IMemoryWriteOp, IModelBinding } from './runtimeProtocol.js';

export const RUNTIME_PLUGIN_API_VERSION = 1;

export interface IInboundMessage {
	readonly gatewayId: string;
	readonly chatId: string;
	readonly sender: string;
	readonly senderName?: string;
	readonly text: string;
	readonly messageId?: string;
	/** Routes the message to a specific Bot instead of the gateway's default Bot (for example an @-mention). */
	readonly botId?: string;
}

/**
 * Contract every Gateway adapter implements; mirrors the operational subset of
 * Hermes' `BasePlatformAdapter` (connect, disconnect, send, typing, health).
 */
export interface IGatewayAdapter {
	readonly config: IGatewayConfig;
	connect(): Promise<void>;
	disconnect(): Promise<void>;
	send(chatId: string, text: string): Promise<void>;
	sendTyping?(chatId: string): Promise<void>;
	health(): IGatewayHealth;
	onMessage(handler: (message: IInboundMessage) => Promise<void>): void;
}

export interface IGatewayAdapterContext {
	readonly secret: (key: string) => string | undefined;
	readonly log: (message: string) => void;
}

export type GatewayAdapterFactory = (config: IGatewayConfig, context: IGatewayAdapterContext) => IGatewayAdapter;

export interface IRuntimeToolDefinition {
	/** Scope key matched against `allowTools`; may contain dots (for example `zotero.search`). */
	readonly name: string;
	readonly description: string;
	readonly parameters: object;
}

export interface IRuntimeToolContext {
	readonly workingDirectory: string;
	readonly botId: string;
	readonly sessionId: string;
	readonly recall: (query: string) => Promise<string>;
	readonly memoryWrite: (target: 'memory' | 'user', content: string) => Promise<string>;
	readonly memoryManage?: (op: IMemoryWriteOp) => Promise<string>;
	readonly sessionSearch?: (options: { query?: string; sessionId?: string; from?: number; to?: number }) => Promise<string>;
	/**
	 * Persists output produced by this tool and adds it to the shared Artifacts index.
	 * `replace` keeps one current entry for repeatedly written files such as meeting notes.
	 */
	readonly artifact: (name: string, content: string | Uint8Array, mimeType: string, options?: { readonly replace?: boolean }) => Promise<string>;
	readonly runBot: (botId: string, input: IBotInput) => Promise<{ readonly sessionId: string; readonly text: string }>;
	readonly log: (message: string) => void;
	readonly signal?: AbortSignal;
	readonly askUser?: (input: { readonly question?: string; readonly choices?: readonly string[]; readonly multiSelect?: boolean; readonly questions?: readonly { readonly id?: string; readonly question?: string; readonly choices?: readonly string[]; readonly multiSelect?: boolean }[] }) => Promise<string>;
}

export interface IRuntimeTool {
	readonly definition: IRuntimeToolDefinition;
	/**
	 * Approval floor: a returned reason requests approval even when the call is
	 * inside the Bot's scope and the scope auto-approves (for example package installs).
	 */
	approvalFloor?(args: Record<string, unknown>): string | undefined;
	run(args: Record<string, unknown>, context: IRuntimeToolContext): Promise<string>;
}

/** One entry of a local/remote memory comparison; local memory stays the source of record. */
export interface IMemoryComparisonEntry {
	readonly target: 'memory' | 'user';
	readonly key: string;
	readonly local?: string;
	readonly remote?: string;
	readonly remoteUpdatedAt?: number;
	readonly status: 'same' | 'localOnly' | 'remoteOnly' | 'conflict';
}

/** How the user settles one differing entry: keep the local version, or take the adapter's version. */
export type MemoryComparisonDecision = 'keepLocal' | 'takeRemote';

/** One entry of an adapter's remote copy, in the form of a local memory bullet. */
export interface IRemoteMemoryEntry {
	readonly target: 'memory' | 'user';
	readonly content: string;
	readonly updatedAt?: number;
}

export interface IMemoryAdapter {
	readonly id: string;
	readonly displayName: string;
	/**
	 * Mirrors a local write outward. Adapters never replace the local store. Keeping
	 * the local version of a reviewed entry is also delivered to the adapter as a write.
	 */
	mirror(op: IMemoryWriteOp): Promise<void>;
	/**
	 * Returns the remote copy; the runtime compares it with local memory. Adapters
	 * with their own comparison implement `compare` instead.
	 */
	entries?(): Promise<readonly IRemoteMemoryEntry[]>;
	/** Compares the remote copy with the local snapshot without changing either. */
	compare?(local: IMemorySnapshot): Promise<readonly IMemoryComparisonEntry[]>;
}

export interface IRuntimePluginHost {
	readonly apiVersion: typeof RUNTIME_PLUGIN_API_VERSION;
	readonly pluginId: string;
	log(message: string): void;
	/** Secrets of this plugin only, set through `latent.runtime.api.setPluginSecret`. */
	secret(key: string): string | undefined;
	/** A stored model binding including its credential, for plugins that call the same endpoint. */
	modelBinding(id: string): IModelBinding | undefined;
	registerGatewayPlatform(platform: string, factory: GatewayAdapterFactory): void;
	registerBotTool(tool: IRuntimeTool): void;
	registerMemoryAdapter(adapter: IMemoryAdapter): void;
	runBot(botId: string, input: IBotInput): Promise<{ readonly sessionId: string; readonly text: string }>;
	/** Queues a message in the delivery ledger; retried with backoff until delivered. */
	deliver(gatewayId: string, chatId: string, text: string): Promise<void>;
}

export interface IRuntimePluginRecord {
	readonly id: string;
	readonly modulePath: string;
	readonly enabled: boolean;
}

export interface IRuntimePluginState extends IRuntimePluginRecord {
	readonly active: boolean;
	readonly lastError?: string;
	readonly contributions: { readonly gatewayPlatforms: readonly string[]; readonly tools: readonly string[]; readonly memoryAdapters: readonly string[] };
}
