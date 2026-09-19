/* eslint-disable header/header */
import { promises as fs } from 'fs';
import { isAbsolute } from 'path';
import { pathToFileURL } from 'url';
import { IBotInput, IModelBinding } from '../../../platform/latentRuntime/common/runtimeProtocol.js';
import { GatewayAdapterFactory, IMemoryAdapter, IRuntimePluginHost, IRuntimePluginRecord, IRuntimePluginState, IRuntimeTool, RUNTIME_PLUGIN_API_VERSION } from '../../../platform/latentRuntime/common/runtimePlugin.js';
import { ToolRegistry } from '../bots/tools.js';
import { GatewayRegistry } from '../gateway/gatewayRegistry.js';
import { MemoryAdapterRegistry } from '../memory/adapters.js';
import { JsonListStore } from '../runtimeConfig.js';

export interface IRuntimePluginServices {
	readonly gateways: Pick<GatewayRegistry, 'registerPlatform' | 'unregisterPlatform'>;
	readonly tools: Pick<ToolRegistry, 'register' | 'unregister'>;
	readonly memoryAdapters: Pick<MemoryAdapterRegistry, 'register' | 'unregister'>;
	readonly secret: (key: string) => string | undefined;
	readonly modelBinding: (id: string) => IModelBinding | undefined;
	readonly runBot: (botId: string, input: IBotInput) => Promise<{ readonly sessionId: string; readonly text: string }>;
	readonly deliver: (gatewayId: string, chatId: string, text: string) => Promise<void>;
	readonly log: (message: string) => void;
	/** Called after contributions change so gateways of newly available platforms connect. */
	readonly onDidChangeContributions: () => Promise<void>;
}

interface IActivePlugin {
	readonly gatewayPlatforms: Set<string>;
	readonly tools: Set<string>;
	readonly memoryAdapters: Set<string>;
	deactivate?: () => unknown;
	lastError?: string;
	active: boolean;
}

interface IPluginModule {
	activate?: (host: IRuntimePluginHost) => unknown;
	deactivate?: () => unknown;
}

export function pluginSecretKey(pluginId: string, key: string): string {
	return `plugin:${pluginId}:${key}`;
}

export function isPluginRecord(value: unknown): value is IRuntimePluginRecord {
	const candidate = value as Partial<IRuntimePluginRecord>;
	return typeof candidate === 'object' && candidate !== null && typeof candidate.id === 'string' && /^[\w.-]+$/.test(candidate.id) && typeof candidate.modulePath === 'string' && isAbsolute(candidate.modulePath) && typeof candidate.enabled === 'boolean';
}

/**
 * Loads runtime plugins (spec 01 §4 `latent.gatewayPlatforms`, `latent.botTools`,
 * `latent.memoryAdapters`). A failing plugin is reported in its state and never
 * stops the runtime; re-registering a plugin replaces all of its contributions.
 */
export class RuntimePluginHost {
	private readonly plugins = new Map<string, IActivePlugin>();

	constructor(private readonly records: Pick<JsonListStore<IRuntimePluginRecord>, 'list' | 'upsert'>, private readonly services: IRuntimePluginServices) { }

	async activateAll(): Promise<void> {
		for (const record of this.records.list()) {
			if (record.enabled) {
				await this.activate(record);
			}
		}
		await this.services.onDidChangeContributions();
	}

	async register(record: IRuntimePluginRecord): Promise<IRuntimePluginState> {
		await this.records.upsert(record);
		await this.deactivate(record.id);
		if (record.enabled) {
			await this.activate(record);
		}
		await this.services.onDidChangeContributions();
		return this.state(record);
	}

	list(): IRuntimePluginState[] {
		return this.records.list().map(record => this.state(record));
	}

	private state(record: IRuntimePluginRecord): IRuntimePluginState {
		const plugin = this.plugins.get(record.id);
		return {
			...record,
			active: plugin?.active === true,
			lastError: plugin?.lastError,
			contributions: { gatewayPlatforms: [...plugin?.gatewayPlatforms ?? []], tools: [...plugin?.tools ?? []], memoryAdapters: [...plugin?.memoryAdapters ?? []] },
		};
	}

	private async activate(record: IRuntimePluginRecord): Promise<void> {
		const plugin: IActivePlugin = { gatewayPlatforms: new Set(), tools: new Set(), memoryAdapters: new Set(), active: false };
		this.plugins.set(record.id, plugin);
		const log = (message: string) => this.services.log(`[plugin ${record.id}] ${message}`);
		const host: IRuntimePluginHost = {
			apiVersion: RUNTIME_PLUGIN_API_VERSION,
			pluginId: record.id,
			log,
			secret: key => this.services.secret(pluginSecretKey(record.id, key)),
			modelBinding: id => this.services.modelBinding(id),
			registerGatewayPlatform: (platform: string, factory: GatewayAdapterFactory) => {
				this.services.gateways.registerPlatform(platform, factory);
				plugin.gatewayPlatforms.add(platform);
			},
			registerBotTool: (tool: IRuntimeTool) => {
				this.services.tools.register(tool);
				plugin.tools.add(tool.definition.name);
			},
			registerMemoryAdapter: (adapter: IMemoryAdapter) => {
				this.services.memoryAdapters.register(adapter);
				plugin.memoryAdapters.add(adapter.id);
			},
			runBot: (botId, input) => this.services.runBot(botId, input),
			deliver: (gatewayId, chatId, text) => this.services.deliver(gatewayId, chatId, text),
		};
		try {
			const stat = await fs.stat(record.modulePath);
			// The query defeats the ES module cache so a re-registered plugin loads its new code.
			const module = await import(`${pathToFileURL(record.modulePath).href}?v=${stat.mtimeMs}`) as IPluginModule;
			if (typeof module.activate !== 'function') {
				throw new Error('the module does not export activate(host)');
			}
			await module.activate(host);
			plugin.deactivate = module.deactivate;
			plugin.active = true;
			log('activated');
		} catch (error) {
			plugin.lastError = error instanceof Error ? error.message : String(error);
			log(`failed to activate: ${plugin.lastError}`);
			await this.removeContributions(plugin);
		}
	}

	private async deactivate(id: string): Promise<void> {
		const plugin = this.plugins.get(id);
		if (!plugin) {
			return;
		}
		try {
			await plugin.deactivate?.();
		} catch (error) {
			this.services.log(`[plugin ${id}] deactivate failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		await this.removeContributions(plugin);
		this.plugins.delete(id);
	}

	private async removeContributions(plugin: IActivePlugin): Promise<void> {
		for (const platform of plugin.gatewayPlatforms) {
			await this.services.gateways.unregisterPlatform(platform);
		}
		for (const tool of plugin.tools) {
			this.services.tools.unregister(tool);
		}
		for (const adapter of plugin.memoryAdapters) {
			this.services.memoryAdapters.unregister(adapter);
		}
		plugin.gatewayPlatforms.clear();
		plugin.tools.clear();
		plugin.memoryAdapters.clear();
		plugin.active = false;
	}

	async dispose(): Promise<void> {
		for (const id of [...this.plugins.keys()]) {
			await this.deactivate(id);
		}
	}
}
