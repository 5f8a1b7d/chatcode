import * as vscode from 'vscode';
import { CatalogProvider, ProviderCatalog, ServiceId, loadProviderCatalog, providerKey } from '../catalog/catalog';
import type { IExternalProvider } from '../api';
import { externalActiveBindings, externalCatalogProviders, externalSecretPrefix, validateExternalProvider } from '../external/externalProviders';
import { ActiveProviderBinding, ProviderConfiguration, ProviderStore } from '../store/store';

export const ProviderEnabledSetting = 'latent.provider.enabled';
/** Legacy Study Buddy setting, honoured as a fallback until removed (spec 02 §6.2). */
export const LegacyCustomProvidersEnabledSetting = 'chat.customProviders.enabled';

/** Bindings per capability as rendered by the manager's capability matrix. */
export interface CapabilityMatrixEntry {
	providerId: string;
	providerName: string;
	modelId: string;
	modelName: string;
	isDefault: boolean;
	source: 'direct' | 'plan';
	sourceId: string;
	requiresApiKey: boolean;
	hasSecret: boolean;
}

export type CapabilityMatrix = Record<string, CapabilityMatrixEntry[]>;

type WebviewMessage =
	| { type: 'ready' }
	| { type: 'addCustom'; category: string; name: string; protocol?: string; baseUrl?: string; modelId?: string; requiresApiKey: boolean; secret?: string }
	| { type: 'removeCustom'; service: string; id: string }
	| { type: 'saveProvider'; service: string; id: string; config: ProviderConfiguration; secret?: string; extraSecrets?: Record<string, string> }
	| { type: 'deleteSecret'; service: string; id: string }
	| { type: 'enablePlan'; id: string; secret?: string }
	| { type: 'disablePlan'; id: string }
	| { type: 'probeModels'; service: string; id: string }
	| { type: 'setCapabilityDefault'; capability: string; providerId?: string; modelId?: string; source?: 'direct' | 'plan'; sourceId?: string };


export class ProviderManager implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private catalog: ProviderCatalog | undefined;
	private readonly store: ProviderStore;
	private readonly activeProbes = new Set<AbortController>();
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changeEmitter.event;
	private readonly disposables: vscode.Disposable[] = [];

	private focusCapability: string | undefined;
	private readonly externalProviders = new Map<string, IExternalProvider>();
	private configurationHidden = false;

	constructor(private readonly context: vscode.ExtensionContext, private readonly matrix: () => Promise<CapabilityMatrix>) {
		this.store = new ProviderStore(context);
		this.disposables.push(this.changeEmitter);
		this.disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(ProviderEnabledSetting) || event.affectsConfiguration(LegacyCustomProvidersEnabledSetting)) {
				if (!this.isEnabled()) {
					this.panel?.dispose();
					for (const probe of this.activeProbes) probe.abort();
				}
				this.changeEmitter.fire();
			}
		}));
	}

	async initialize(): Promise<void> {
		this.catalog = await loadProviderCatalog(this.context.extensionUri);
		this.changeEmitter.fire();
	}

	getCatalog(): ProviderCatalog | undefined {
		const external = [...this.externalProviders.values()].flatMap(externalCatalogProviders);
		return this.catalog ? { ...this.catalog, providers: [...this.catalog.providers, ...this.store.getCustomProviders(), ...external] } : undefined;
	}

	/** Product override: local configuration is hidden and only external providers are offered. */
	setConfigurationHidden(hidden: boolean): void {
		if (this.configurationHidden !== hidden) {
			this.configurationHidden = hidden;
			if (hidden) {
				this.panel?.dispose();
			}
			this.changeEmitter.fire();
		}
	}

	isConfigurationHidden(): boolean {
		return this.configurationHidden;
	}

	registerExternalProvider(provider: IExternalProvider): vscode.Disposable {
		validateExternalProvider(provider);
		const declared = vscode.extensions.all.some(extension => {
			const declarations = (extension.packageJSON as { contributes?: { latentProviderCapabilities?: { id?: string }[] } }).contributes?.latentProviderCapabilities;
			return Array.isArray(declarations) && declarations.some(declaration => declaration.id === provider.id);
		});
		if (!declared) {
			throw new Error(`Provider ${provider.id} is not declared under contributes.latentProviderCapabilities.`);
		}
		this.externalProviders.set(provider.id, provider);
		this.changeEmitter.fire();
		return new vscode.Disposable(() => {
			if (this.externalProviders.get(provider.id) === provider) {
				this.externalProviders.delete(provider.id);
				this.changeEmitter.fire();
			}
		});
	}

	/** Locally configured bindings (unless hidden) followed by external provider bindings. */
	listActiveBindings(): ActiveProviderBinding[] {
		const catalog = this.getCatalog();
		const local = catalog && !this.configurationHidden ? this.store.listActiveBindings(catalog).filter(binding => !this.externalProviders.has(binding.providerId)) : [];
		return [...local, ...[...this.externalProviders.values()].flatMap(externalActiveBindings)];
	}

	async hasSecret(ref: string): Promise<boolean> {
		return !!(await this.getSecret(ref));
	}

	async getSecret(ref: string): Promise<string | undefined> {
		if (ref.startsWith(externalSecretPrefix)) {
			return this.externalProviders.get(ref.slice(externalSecretPrefix.length))?.getCredential();
		}
		return this.store.getSecret(ref);
	}

	getStore(): ProviderStore {
		return this.store;
	}

	isEnabled(): boolean {
		const configuration = vscode.workspace.getConfiguration();
		const inspected = configuration.inspect<boolean>(ProviderEnabledSetting);
		if (inspected?.globalValue !== undefined || inspected?.workspaceValue !== undefined) {
			return configuration.get<boolean>(ProviderEnabledSetting) === true;
		}
		const legacy = configuration.inspect<boolean>(LegacyCustomProvidersEnabledSetting);
		if (legacy?.globalValue !== undefined || legacy?.workspaceValue !== undefined) {
			return configuration.get<boolean>(LegacyCustomProvidersEnabledSetting) === true;
		}
		return configuration.get<boolean>(ProviderEnabledSetting, true);
	}

	/** Opens the manager; with `capability` the capability matrix is shown filtered to that capability (P2-FR-053). */
	async open(options?: { capability?: string }): Promise<void> {
		if (this.configurationHidden) {
			void vscode.window.showInformationMessage(vscode.l10n.t('Models are provided by your organization. Local model configuration is not available in this build.'));
			return;
		}
		if (!this.isEnabled()) {
			void vscode.window.showInformationMessage(vscode.l10n.t('Enable latent.provider.enabled to manage providers.'));
			return;
		}
		this.focusCapability = options?.capability;
		if (this.panel) {
			this.panel.reveal();
			await this.sendState();
			return;
		}
		if (!this.catalog) {
			await this.initialize();
		}
		const panel = vscode.window.createWebviewPanel(
			'latentnote.customProviders',
			'Providers',
			vscode.ViewColumn.Active,
			{ enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] },
		);
		this.panel = panel;
		const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
		const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
		const cssUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'provider-manager.css'));
		const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'provider-manager.js'));
		panel.webview.html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';"><link href="${cssUri}" rel="stylesheet"></head><body><div id="app"></div><script nonce="${nonce}" src="${scriptUri}"></script></body></html>`;
		const onMessage = panel.webview.onDidReceiveMessage((message: WebviewMessage) => void this.handleMessage(message));
		panel.onDidDispose(() => {
			onMessage.dispose();
			this.panel = undefined;
		});
	}

	private async handleMessage(message: WebviewMessage): Promise<void> {
		if (!this.panel || !this.catalog || !this.isEnabled()) {
			return;
		}
		try {
			if (message.type === 'ready') {
				await this.sendState();
				return;
			}
			if (message.type === 'setCapabilityDefault') {
				await this.store.setCapabilityDefault(message.capability, message.providerId && message.modelId && message.source && message.sourceId ? { providerId: message.providerId, modelId: message.modelId, source: message.source, sourceId: message.sourceId } : undefined);
				this.changeEmitter.fire();
				await this.sendState();
				return;
			}
			if (message.type === 'addCustom') {
				const category = this.catalog.categories.find(category => category.id === message.category && category.id !== 'token-plan');
				if (!category) throw new Error('Unknown provider category.');
				const service = category.id as ServiceId;
				const added = await this.store.addCustomProvider({ category: category.id, service, name: message.name, type: message.protocol, defaultBaseUrl: message.baseUrl, requiresApiKey: message.requiresApiKey }, message.modelId, message.secret);
				this.changeEmitter.fire();
				await this.panel.webview.postMessage({ type: 'added', key: providerKey(added.service, added.id) });
				await this.sendState();
				return;
			}
			if (message.type === 'enablePlan' || message.type === 'disablePlan') {
				const plan = this.catalog.tokenPlans.find(plan => plan.id === message.id);
				if (!plan) {
					throw new Error('Unknown token plan.');
				}
				if (message.type === 'enablePlan') {
					await this.store.enablePlan(plan, message.secret);
				} else {
					await this.store.disablePlan(plan);
				}
				this.changeEmitter.fire();
				await this.sendState();
				return;
			}
			const provider = this.getCatalog()?.providers.find(provider => provider.service === message.service && provider.id === message.id);
			if (!provider) {
				throw new Error('Unknown provider.');
			}
			if (message.type === 'removeCustom') {
				await this.store.removeCustomProvider(provider.service, provider.id);
				this.changeEmitter.fire();
				await this.sendState();
				return;
			}
			if (message.type === 'saveProvider') {
				await this.store.saveProvider(provider, message.config, message.secret, message.extraSecrets);
				this.changeEmitter.fire();
				await this.sendState();
			} else if (message.type === 'deleteSecret') {
				await this.store.deleteProviderSecret(message.service, message.id, provider);
				this.changeEmitter.fire();
				await this.sendState();
			} else if (message.type === 'probeModels') {
				const models = await this.probeModels(provider);
				await this.panel.webview.postMessage({ type: 'models', key: providerKey(provider.service, provider.id), models });
			}
		} catch (error) {
			if (this.panel) await this.panel.webview.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
		}
	}

	private async sendState(): Promise<void> {
		if (!this.panel || !this.catalog) {
			return;
		}
		const catalog = this.getCatalog();
		if (catalog) {
			const focusCapability = this.focusCapability;
			this.focusCapability = undefined;
			await this.panel.webview.postMessage({ type: 'init', catalog, state: await this.store.snapshot(catalog), capabilities: await this.matrix(), focusCapability });
		}
	}

	private async probeModels(provider: CatalogProvider): Promise<string[]> {
		if (provider.service !== 'llm') {
			throw new Error('Model discovery is available for LLM providers.');
		}
		const config = this.store.getProvider(provider.service, provider.id);
		const base = config.baseUrl || provider.defaultBaseUrl;
		if (!base) {
			throw new Error('Set a Base URL first.');
		}
		const secret = await this.store.getSecret(providerKey(provider.service, provider.id));
		if (provider.requiresApiKey && !secret) {
			throw new Error('Save the API key first.');
		}
		const endpoint = new URL(base.replace(/\/$/, '').replace(/^ws/, 'http') + '/models');
		const headers: Record<string, string> = {};
		if (provider.type === 'anthropic') {
			headers['x-api-key'] = secret || '';
			headers['anthropic-version'] = '2023-06-01';
		} else if (provider.type === 'google') {
			headers['x-goog-api-key'] = secret || '';
		} else if (secret) {
			headers.authorization = `Bearer ${secret}`;
		}
		const controller = new AbortController();
		this.activeProbes.add(controller);
		const timeout = setTimeout(() => controller.abort(), 15000);
		try {
			const response = await fetch(endpoint, { headers, signal: controller.signal });
			if (!response.ok) {
				throw new Error(`Model discovery failed: HTTP ${response.status}`);
			}
			const payload = await response.json() as { data?: Array<{ id?: string }>; models?: Array<{ name?: string }> };
			return (payload.data?.map(model => model.id).filter((id): id is string => !!id) ?? payload.models?.map(model => model.name).filter((id): id is string => !!id) ?? []);
		} finally {
			clearTimeout(timeout);
			this.activeProbes.delete(controller);
		}
	}

	dispose(): void {
		this.panel?.dispose();
		for (const probe of this.activeProbes) probe.abort();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}
}
