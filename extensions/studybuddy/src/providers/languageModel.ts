import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { StudyBuddyClient, StudyBuddyServiceError } from '../backend/client';
import { SseDecoder } from '../backend/protocol';
import type { SystemSelectionSnapshot } from '../editor/selection';
import { accessTokenSecret, projectIdForSystemSelection } from '../learning/explanationController';
import { developmentAuthorization } from '../learning/developmentAuthorization';
import { isPrivateNetworkHost } from '../utils';
import { CatalogModel } from './catalog';
import { ProviderManager } from './manager';

const vendor = 'latentnote-catalog';
export const studyBuddyServiceModelIdentifier = `${vendor}/studybuddy-service`;
const studyBuddyServiceModelId = 'studybuddy-service';

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

type WireMessage = { role: string; content?: string | Array<object>; tool_call_id?: string; tool_calls?: Array<object> };

export class CatalogLanguageModelProvider implements vscode.LanguageModelChatProvider<vscode.LanguageModelChatInformation>, vscode.Disposable {
	private registration: vscode.Disposable | undefined;
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this.changeEmitter.event;
	private readonly subscriptions: vscode.Disposable[] = [];
	private readonly bindings = new Map<string, Binding>();
	private readonly activeRequests = new Set<AbortController>();

	constructor(private readonly manager: ProviderManager, private readonly context: vscode.ExtensionContext) {
		this.subscriptions.push(manager.onDidChange(() => {
			for (const request of this.activeRequests) request.abort();
			this.changeEmitter.fire();
		}));
		this.registration = vscode.lm.registerLanguageModelChatProvider(vendor, this);
	}

	async provideLanguageModelChatInformation(): Promise<vscode.LanguageModelChatInformation[]> {
		const infos: vscode.LanguageModelChatInformation[] = [{
			id: studyBuddyServiceModelId,
			name: 'Study Buddy Service',
			family: 'studybuddy',
			version: '1',
			maxInputTokens: 32000,
			maxOutputTokens: 8000,
			capabilities: {},
			detail: 'Study Buddy',
		}];
		this.bindings.clear();
		if (!this.manager.isEnabled()) return infos;
		const catalog = this.manager.getCatalog();
		if (!catalog) return infos;
		const store = this.manager.getStore();
		for (const active of store.listActiveBindings(catalog).filter(binding => binding.service === 'llm' && supportedProtocol(binding.protocol))) {
			const provider = catalog.providers.find(provider => provider.service === 'llm' && provider.id === active.providerId);
			const plan = active.source === 'plan' ? catalog.tokenPlans.find(plan => plan.id === active.sourceId) : undefined;
			const requiresApiKey = active.source === 'plan' || provider?.requiresApiKey === true;
			if (requiresApiKey && !(await store.hasSecret(active.secretRef))) continue;
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
		if (model.id === studyBuddyServiceModelId) {
			await this.requestStudyBuddyService(messages, progress, token);
			return;
		}
		if (!this.manager.isEnabled()) throw vscode.LanguageModelError.Blocked('Custom providers are disabled.');
		const binding = this.bindings.get(model.id);
		if (!binding) throw vscode.LanguageModelError.NotFound('Model configuration changed.');
		const secret = await this.manager.getStore().getSecret(binding.secretRef);
		if (binding.requiresApiKey && !secret) throw vscode.LanguageModelError.Blocked('Provider credential is missing.');
		const controller = new AbortController();
		this.activeRequests.add(controller);
		const cancellation = token.onCancellationRequested(() => controller.abort());
		try {
			if (binding.protocol === 'anthropic') await this.requestAnthropic(binding, secret, messages, options, progress, controller.signal);
			else if (binding.protocol === 'google') await this.requestGoogle(binding, secret, messages, progress, controller.signal);
			else await this.requestOpenAI(binding, secret, messages, options, progress, controller.signal);
		} finally {
			cancellation.dispose();
			this.activeRequests.delete(controller);
		}
	}

	private async requestStudyBuddyService(messages: readonly vscode.LanguageModelChatRequestMessage[], progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken): Promise<void> {
		const configuredUrl = vscode.workspace.getConfiguration('latentnote.studyBuddy').get<string>('serviceUrl', 'http://127.0.0.1:8787');
		let serviceUrl: URL;
		try {
			serviceUrl = new URL(configuredUrl);
		} catch {
			throw new StudyBuddyServiceError('Study Buddy service URL must be a valid HTTP or HTTPS URL.');
		}
		if (!['http:', 'https:'].includes(serviceUrl.protocol) || (serviceUrl.protocol === 'http:' && !isPrivateNetworkHost(serviceUrl.hostname))) {
			throw new StudyBuddyServiceError('Study Buddy requires HTTPS for non-private service URLs.');
		}
		const stored = await this.context.secrets.get(accessTokenSecret);
		const authorization = stored
			? stored.toLowerCase().startsWith('bearer ') ? stored : `Bearer ${stored}`
			: developmentAuthorization(configuredUrl);
		if (!authorization) {
			throw new StudyBuddyServiceError('Set the Study Buddy access token before using the Study Buddy Service model.');
		}
		const turns = messages.map(message => {
			const text = textParts(message.content);
			return text ? `${message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'Study Buddy' : 'Learner'}: ${text}` : '';
		}).filter(Boolean);
		const latestQuestion = [...messages].reverse()
			.find(message => message.role === vscode.LanguageModelChatMessageRole.User && textParts(message.content))?.content;
		const requestId = `studybuddy-chat-${randomUUID()}`;
		const snapshot: SystemSelectionSnapshot = {
			kind: 'system',
			selectionId: requestId,
			text: latestQuestion ? textParts(latestQuestion) : turns.join('\n\n'),
			projectId: projectIdForSystemSelection(),
			capturedAt: Date.now(),
			application: 'Study Buddy Chat',
		};
		await new StudyBuddyClient(serviceUrl.toString(), authorization).explain(
			requestId,
			turns.join('\n\n'),
			snapshot,
			token,
			text => progress.report(new vscode.LanguageModelTextPart(text)),
		);
	}

	private async requestOpenAI(binding: Binding, secret: string | undefined, messages: readonly vscode.LanguageModelChatRequestMessage[], options: vscode.ProvideLanguageModelChatResponseOptions, progress: vscode.Progress<vscode.LanguageModelResponsePart>, signal: AbortSignal): Promise<void> {
		const azureBase = binding.baseUrl.replace(/\/$/, '').replace(/\/openai$/, '');
		const endpoint = binding.protocol === 'azure'
			? `${azureBase}/openai/deployments/${encodeURIComponent(binding.modelId)}/chat/completions?api-version=2024-10-21`
			: `${binding.baseUrl.replace(/\/$/, '')}/chat/completions`;
		const headers: Record<string, string> = { 'content-type': 'application/json' };
		if (secret) headers[binding.protocol === 'azure' ? 'api-key' : 'authorization'] = binding.protocol === 'azure' ? secret : `Bearer ${secret}`;
		const wireMessages = toOpenAIMessages(messages);
		const body = {
			model: binding.modelId,
			messages: wireMessages,
			stream: true,
			...(options.tools?.length ? { tools: options.tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema || { type: 'object', properties: {} } } })) } : {}),
		};
		const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal });
		await ensureSuccess(response);
		const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
		await readSse(response, data => {
			if (data === '[DONE]') return;
			const packet = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> } }> };
			const delta = packet.choices?.[0]?.delta;
			if (delta?.content) progress.report(new vscode.LanguageModelTextPart(delta.content));
			for (const call of delta?.tool_calls || []) {
				const current = toolCalls.get(call.index) || { id: '', name: '', arguments: '' };
				if (call.id) current.id = call.id;
				if (call.function?.name) current.name += call.function.name;
				if (call.function?.arguments) current.arguments += call.function.arguments;
				toolCalls.set(call.index, current);
			}
		});
		for (const call of toolCalls.values()) {
			if (call.name) progress.report(new vscode.LanguageModelToolCallPart(call.id || crypto.randomUUID(), call.name, parseToolInput(call.arguments)));
		}
	}

	private async requestAnthropic(binding: Binding, secret: string | undefined, messages: readonly vscode.LanguageModelChatRequestMessage[], options: vscode.ProvideLanguageModelChatResponseOptions, progress: vscode.Progress<vscode.LanguageModelResponsePart>, signal: AbortSignal): Promise<void> {
		const endpoint = `${binding.baseUrl.replace(/\/$/, '')}/messages`;
		const body = {
			model: binding.modelId,
			max_tokens: binding.model.outputWindow || 16000,
			messages: toAnthropicMessages(messages),
			...(options.tools?.length ? { tools: options.tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema || { type: 'object', properties: {} } })) } : {}),
		};
		const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': secret || '', 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body), signal });
		await ensureSuccess(response);
		const packet = await response.json() as { content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: object }> };
		for (const part of packet.content || []) {
			if (part.type === 'text' && part.text) progress.report(new vscode.LanguageModelTextPart(part.text));
			if (part.type === 'tool_use' && part.name) progress.report(new vscode.LanguageModelToolCallPart(part.id || crypto.randomUUID(), part.name, part.input || {}));
		}
	}

	private async requestGoogle(binding: Binding, secret: string | undefined, messages: readonly vscode.LanguageModelChatRequestMessage[], progress: vscode.Progress<vscode.LanguageModelResponsePart>, signal: AbortSignal): Promise<void> {
		const endpoint = `${binding.baseUrl.replace(/\/$/, '')}/models/${encodeURIComponent(binding.modelId)}:generateContent`;
		const contents = messages.map(message => ({ role: message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'model' : 'user', parts: toGoogleParts(message.content) }));
		const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': secret || '' }, body: JSON.stringify({ contents }), signal });
		await ensureSuccess(response);
		const packet = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
		for (const part of packet.candidates?.[0]?.content?.parts || []) if (part.text) progress.report(new vscode.LanguageModelTextPart(part.text));
	}

	async provideTokenCount(_model: vscode.LanguageModelChatInformation, text: string | vscode.LanguageModelChatRequestMessage): Promise<number> {
		const value = typeof text === 'string' ? text : text.content.map(part => part instanceof vscode.LanguageModelTextPart ? part.value : '').join('');
		return Math.ceil(value.length / 4);
	}

	dispose(): void {
		for (const request of this.activeRequests) request.abort();
		this.registration?.dispose();
		for (const subscription of this.subscriptions) subscription.dispose();
		this.changeEmitter.dispose();
	}
}

function supportedProtocol(protocol: string | undefined): boolean {
	return protocol === 'openai' || protocol === 'azure' || protocol === 'anthropic' || protocol === 'google';
}

function textParts(parts: readonly (vscode.LanguageModelInputPart | unknown)[]): string {
	return parts.filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart).map(part => part.value).join('\n');
}

function toOpenAIMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): WireMessage[] {
	const output: WireMessage[] = [];
	for (const message of messages) {
		const role = message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';
		const images = message.content.filter((part): part is vscode.LanguageModelDataPart => part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('image/'));
		const text = textParts(message.content);
		const content: string | Array<object> = images.length ? [{ type: 'text', text }, ...images.map(part => ({ type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${Buffer.from(part.data).toString('base64')}` } }))] : text;
		const calls = message.content.filter((part): part is vscode.LanguageModelToolCallPart => part instanceof vscode.LanguageModelToolCallPart);
		if (calls.length) output.push({ role: 'assistant', content, tool_calls: calls.map(call => ({ id: call.callId, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } })) });
		else if (content) output.push({ role, content });
		for (const result of message.content.filter((part): part is vscode.LanguageModelToolResultPart => part instanceof vscode.LanguageModelToolResultPart)) output.push({ role: 'tool', tool_call_id: result.callId, content: textParts(result.content) });
	}
	return output;
}

function toAnthropicMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): Array<{ role: string; content: Array<object> }> {
	return messages.map(message => {
		const content: Array<object> = [];
		const text = textParts(message.content);
		if (text) content.push({ type: 'text', text });
		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('image/')) content.push({ type: 'image', source: { type: 'base64', media_type: part.mimeType, data: Buffer.from(part.data).toString('base64') } });
			if (part instanceof vscode.LanguageModelToolCallPart) content.push({ type: 'tool_use', id: part.callId, name: part.name, input: part.input });
			if (part instanceof vscode.LanguageModelToolResultPart) content.push({ type: 'tool_result', tool_use_id: part.callId, content: textParts(part.content) });
		}
		return { role: message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user', content };
	});
}

function toGoogleParts(parts: readonly (vscode.LanguageModelInputPart | unknown)[]): Array<object> {
	const output: Array<object> = [];
	for (const part of parts) {
		if (part instanceof vscode.LanguageModelTextPart) output.push({ text: part.value });
		if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('image/')) output.push({ inlineData: { mimeType: part.mimeType, data: Buffer.from(part.data).toString('base64') } });
	}
	return output;
}

async function ensureSuccess(response: Response): Promise<void> {
	if (!response.ok) throw new Error(`Model request failed: HTTP ${response.status} ${((await response.text()).slice(0, 300))}`);
}

async function readSse(response: Response, receive: (data: string) => void): Promise<void> {
	if (!response.body) throw new Error('Model response has no stream.');
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const sse = new SseDecoder();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			for (const packet of sse.accept(decoder.decode(value, { stream: true }))) receive(packet);
		}
		for (const packet of sse.accept(decoder.decode())) receive(packet);
		sse.finish();
	} finally {
		reader.releaseLock();
	}
}

function parseToolInput(raw: string): object {
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === 'object' ? parsed : {};
	} catch {
		return {};
	}
}
