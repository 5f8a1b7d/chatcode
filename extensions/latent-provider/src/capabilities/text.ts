import * as vscode from 'vscode';
import { SseDecoder } from './sse';
export { supportedTextProtocol } from './protocols';

/** The transport details of one text/vision model binding. */
export interface ITextBinding {
	readonly modelId: string;
	readonly baseUrl: string;
	readonly protocol: string;
	readonly outputWindow?: number;
}

export type TextProgress = (part: vscode.LanguageModelResponsePart) => void;

type WireMessage = { role: string; content?: string | Array<object>; tool_call_id?: string; tool_calls?: Array<object> };

/** Streams a chat completion for any supported protocol into `progress`. */
export async function requestText(binding: ITextBinding, secret: string | undefined, messages: readonly vscode.LanguageModelChatRequestMessage[], options: { tools?: readonly vscode.LanguageModelChatTool[] }, progress: TextProgress, signal: AbortSignal): Promise<void> {
	if (binding.protocol === 'anthropic') {
		await requestAnthropic(binding, secret, messages, options, progress, signal);
	} else if (binding.protocol === 'google') {
		await requestGoogle(binding, secret, messages, progress, signal);
	} else {
		await requestOpenAI(binding, secret, messages, options, progress, signal);
	}
}

async function requestOpenAI(binding: ITextBinding, secret: string | undefined, messages: readonly vscode.LanguageModelChatRequestMessage[], options: { tools?: readonly vscode.LanguageModelChatTool[] }, progress: TextProgress, signal: AbortSignal): Promise<void> {
	const azureBase = binding.baseUrl.replace(/\/$/, '').replace(/\/openai$/, '');
	const endpoint = binding.protocol === 'azure'
		? `${azureBase}/openai/deployments/${encodeURIComponent(binding.modelId)}/chat/completions?api-version=2024-10-21`
		: `${binding.baseUrl.replace(/\/$/, '')}/chat/completions`;
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (secret) {
		headers[binding.protocol === 'azure' ? 'api-key' : 'authorization'] = binding.protocol === 'azure' ? secret : `Bearer ${secret}`;
	}
	const body = {
		model: binding.modelId,
		messages: toOpenAIMessages(messages),
		stream: true,
		...(options.tools?.length ? { tools: options.tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema || { type: 'object', properties: {} } } })) } : {}),
	};
	const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal });
	await ensureSuccess(response);
	const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
	await readSse(response, data => {
		if (data === '[DONE]') {
			return;
		}
		const packet = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> } }> };
		const delta = packet.choices?.[0]?.delta;
		if (delta?.content) {
			progress(new vscode.LanguageModelTextPart(delta.content));
		}
		for (const call of delta?.tool_calls || []) {
			const current = toolCalls.get(call.index) || { id: '', name: '', arguments: '' };
			if (call.id) { current.id = call.id; }
			if (call.function?.name) { current.name += call.function.name; }
			if (call.function?.arguments) { current.arguments += call.function.arguments; }
			toolCalls.set(call.index, current);
		}
	});
	for (const call of toolCalls.values()) {
		if (call.name) {
			progress(new vscode.LanguageModelToolCallPart(call.id || crypto.randomUUID(), call.name, parseToolInput(call.arguments)));
		}
	}
}

async function requestAnthropic(binding: ITextBinding, secret: string | undefined, messages: readonly vscode.LanguageModelChatRequestMessage[], options: { tools?: readonly vscode.LanguageModelChatTool[] }, progress: TextProgress, signal: AbortSignal): Promise<void> {
	const endpoint = `${binding.baseUrl.replace(/\/$/, '')}/messages`;
	const body = {
		model: binding.modelId,
		max_tokens: binding.outputWindow || 16000,
		messages: toAnthropicMessages(messages),
		...(options.tools?.length ? { tools: options.tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema || { type: 'object', properties: {} } })) } : {}),
	};
	const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': secret || '', 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body), signal });
	await ensureSuccess(response);
	const packet = await response.json() as { content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: object }> };
	for (const part of packet.content || []) {
		if (part.type === 'text' && part.text) {
			progress(new vscode.LanguageModelTextPart(part.text));
		}
		if (part.type === 'tool_use' && part.name) {
			progress(new vscode.LanguageModelToolCallPart(part.id || crypto.randomUUID(), part.name, part.input || {}));
		}
	}
}

async function requestGoogle(binding: ITextBinding, secret: string | undefined, messages: readonly vscode.LanguageModelChatRequestMessage[], progress: TextProgress, signal: AbortSignal): Promise<void> {
	const endpoint = `${binding.baseUrl.replace(/\/$/, '')}/models/${encodeURIComponent(binding.modelId)}:generateContent`;
	const contents = messages.map(message => ({ role: message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'model' : 'user', parts: toGoogleParts(message.content) }));
	const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': secret || '' }, body: JSON.stringify({ contents }), signal });
	await ensureSuccess(response);
	const packet = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
	for (const part of packet.candidates?.[0]?.content?.parts || []) {
		if (part.text) {
			progress(new vscode.LanguageModelTextPart(part.text));
		}
	}
}

export function textParts(parts: readonly (vscode.LanguageModelInputPart | unknown)[]): string {
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
		if (calls.length) {
			output.push({ role: 'assistant', content, tool_calls: calls.map(call => ({ id: call.callId, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } })) });
		} else if (content) {
			output.push({ role, content });
		}
		for (const result of message.content.filter((part): part is vscode.LanguageModelToolResultPart => part instanceof vscode.LanguageModelToolResultPart)) {
			output.push({ role: 'tool', tool_call_id: result.callId, content: textParts(result.content) });
		}
	}
	return output;
}

function toAnthropicMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): Array<{ role: string; content: Array<object> }> {
	return messages.map(message => {
		const content: Array<object> = [];
		const text = textParts(message.content);
		if (text) {
			content.push({ type: 'text', text });
		}
		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('image/')) {
				content.push({ type: 'image', source: { type: 'base64', media_type: part.mimeType, data: Buffer.from(part.data).toString('base64') } });
			}
			if (part instanceof vscode.LanguageModelToolCallPart) {
				content.push({ type: 'tool_use', id: part.callId, name: part.name, input: part.input });
			}
			if (part instanceof vscode.LanguageModelToolResultPart) {
				content.push({ type: 'tool_result', tool_use_id: part.callId, content: textParts(part.content) });
			}
		}
		return { role: message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user', content };
	});
}

function toGoogleParts(parts: readonly (vscode.LanguageModelInputPart | unknown)[]): Array<object> {
	const output: Array<object> = [];
	for (const part of parts) {
		if (part instanceof vscode.LanguageModelTextPart) {
			output.push({ text: part.value });
		}
		if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('image/')) {
			output.push({ inlineData: { mimeType: part.mimeType, data: Buffer.from(part.data).toString('base64') } });
		}
	}
	return output;
}

export async function ensureSuccess(response: Response): Promise<void> {
	if (!response.ok) {
		throw new Error(`Model request failed: HTTP ${response.status} ${((await response.text()).slice(0, 300))}`);
	}
}

async function readSse(response: Response, receive: (data: string) => void): Promise<void> {
	if (!response.body) {
		throw new Error('Model response has no stream.');
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const sse = new SseDecoder();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			for (const packet of sse.accept(decoder.decode(value, { stream: true }))) {
				receive(packet);
			}
		}
		for (const packet of sse.accept(decoder.decode())) {
			receive(packet);
		}
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
