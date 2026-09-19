import * as vscode from 'vscode';
import { CatalogModel } from '../catalog/catalog';
import { ProviderManager } from '../manager/manager';
import { requestText, supportedTextProtocol } from '../capabilities/text';

const vendor = 'latentnote-catalog';

interface Binding {
	modelId: string;
	name: string;
	providerId: string;
	baseUrl: string;
	protocol: string;
	secretRef: string;
	model: CatalogModel;
	requiresApiKey: boolean;
}

/**
 * Exposes every active text binding through the VS Code Language Model API so
 * chat, inline chat, and the floating composer can pick provider models.
 * Model identifiers (`provider:<id>/<model>`, `plan:<id>/<model>`) are unchanged
 * from the Study Buddy extension so saved selections keep working (spec 02 §6.5).
 */
export class CatalogLanguageModelProvider implements vscode.LanguageModelChatProvider<vscode.LanguageModelChatInformation>, vscode.Disposable {
	private registration: vscode.Disposable | undefined;
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this.changeEmitter.event;
	private readonly subscriptions: vscode.Disposable[] = [];
	private readonly bindings = new Map<string, Binding>();
	private readonly activeRequests = new Set<AbortController>();

	constructor(private readonly manager: ProviderManager) {
		this.subscriptions.push(manager.onDidChange(() => {
			for (const request of this.activeRequests) {
				request.abort();
			}
			this.changeEmitter.fire();
		}));
		this.registration = vscode.lm.registerLanguageModelChatProvider(vendor, this);
	}

	async provideLanguageModelChatInformation(): Promise<vscode.LanguageModelChatInformation[]> {
		const infos: vscode.LanguageModelChatInformation[] = [];
		this.bindings.clear();
		if (!this.manager.isEnabled()) {
			return infos;
		}
		const catalog = this.manager.getCatalog();
		if (!catalog) {
			return infos;
		}
		for (const active of this.manager.listActiveBindings().filter(binding => binding.service === 'llm' && supportedTextProtocol(binding.protocol))) {
			const provider = catalog.providers.find(provider => provider.service === 'llm' && provider.id === active.providerId);
			const plan = active.source === 'plan' ? catalog.tokenPlans.find(plan => plan.id === active.sourceId) : undefined;
			const requiresApiKey = active.source === 'plan' || provider?.requiresApiKey === true;
			if (requiresApiKey && !(await this.manager.hasSecret(active.secretRef))) {
				continue;
			}
			const ownerName = plan?.name || provider?.name || active.providerId;
			for (const modelId of active.modelIds) {
				const model = provider?.models?.find(model => model.id === modelId) || { id: modelId, name: modelId };
				this.addBinding(infos, { modelId, name: `${ownerName} · ${model.name}`, providerId: active.providerId, baseUrl: active.baseUrl, protocol: active.protocol || 'openai', secretRef: active.secretRef, model, requiresApiKey }, `${active.source === 'plan' ? 'plan' : 'provider'}:${active.sourceId}`);
			}
		}
		return infos;
	}

	private addBinding(infos: vscode.LanguageModelChatInformation[], binding: Binding, prefix: string): void {
		const id = `${prefix}/${binding.modelId}`;
		this.bindings.set(id, binding);
		const context = binding.model.contextWindow || 128000;
		const output = binding.model.outputWindow || 16000;
		infos.push({
			id,
			name: binding.name,
			family: binding.modelId,
			version: '1',
			maxInputTokens: Math.max(1, context - output),
			maxOutputTokens: output,
			capabilities: { toolCalling: binding.model.capabilities?.tools === true && binding.protocol !== 'google', imageInput: binding.model.capabilities?.vision === true },
			detail: binding.providerId,
		});
	}

	async provideLanguageModelChatResponse(model: vscode.LanguageModelChatInformation, messages: readonly vscode.LanguageModelChatRequestMessage[], options: vscode.ProvideLanguageModelChatResponseOptions, progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken): Promise<void> {
		if (!this.manager.isEnabled()) {
			throw vscode.LanguageModelError.Blocked('Latent providers are disabled.');
		}
		const binding = this.bindings.get(model.id);
		if (!binding) {
			throw vscode.LanguageModelError.NotFound('Model configuration changed.');
		}
		const secret = await this.manager.getSecret(binding.secretRef);
		if (binding.requiresApiKey && !secret) {
			throw vscode.LanguageModelError.Blocked('Provider credential is missing.');
		}
		const controller = new AbortController();
		this.activeRequests.add(controller);
		const cancellation = token.onCancellationRequested(() => controller.abort());
		try {
			await requestText({ modelId: binding.modelId, baseUrl: binding.baseUrl, protocol: binding.protocol, outputWindow: binding.model.outputWindow }, secret, messages, { tools: options.tools }, part => progress.report(part), controller.signal);
		} finally {
			cancellation.dispose();
			this.activeRequests.delete(controller);
		}
	}

	async provideTokenCount(_model: vscode.LanguageModelChatInformation, text: string | vscode.LanguageModelChatRequestMessage): Promise<number> {
		const value = typeof text === 'string' ? text : text.content.map(part => part instanceof vscode.LanguageModelTextPart ? part.value : '').join('');
		return Math.ceil(value.length / 4);
	}

	dispose(): void {
		for (const request of this.activeRequests) {
			request.abort();
		}
		this.registration?.dispose();
		for (const subscription of this.subscriptions) {
			subscription.dispose();
		}
		this.changeEmitter.dispose();
	}
}
