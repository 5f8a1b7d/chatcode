/* eslint-disable header/header */
/** Newline-delimited JSON-RPC 2.0 framing shared by the runtime server and its clients. */

export interface IJsonRpcRequest {
	readonly jsonrpc: '2.0';
	readonly id: number | string;
	readonly method: string;
	readonly params?: unknown;
}

export interface IJsonRpcNotification {
	readonly jsonrpc: '2.0';
	readonly method: string;
	readonly params?: unknown;
}

export interface IJsonRpcResponse {
	readonly jsonrpc: '2.0';
	readonly id: number | string;
	readonly result?: unknown;
	readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

export type JsonRpcMessage = IJsonRpcRequest | IJsonRpcNotification | IJsonRpcResponse;

export const JsonRpcErrorCodes = {
	ParseError: -32700,
	InvalidRequest: -32600,
	MethodNotFound: -32601,
	InvalidParams: -32602,
	Internal: -32603,
	Unauthorized: -32001,
	CapabilityUnavailable: -32002,
} as const;

export class JsonRpcError extends Error {
	constructor(readonly code: number, message: string, readonly data?: unknown) {
		super(message);
		this.name = 'JsonRpcError';
	}
}

export function encodeMessage(message: JsonRpcMessage): string {
	return JSON.stringify(message) + '\n';
}

/** Accumulates socket chunks and yields complete messages; malformed lines are reported, not thrown. */
export class JsonRpcDecoder {
	private buffer = '';

	accept(chunk: string): { messages: JsonRpcMessage[]; malformed: string[] } {
		this.buffer += chunk;
		const messages: JsonRpcMessage[] = [];
		const malformed: string[] = [];
		let boundary = this.buffer.indexOf('\n');
		while (boundary >= 0) {
			const line = this.buffer.slice(0, boundary).trim();
			this.buffer = this.buffer.slice(boundary + 1);
			if (line) {
				try {
					const parsed = JSON.parse(line);
					if (isJsonRpcMessage(parsed)) {
						messages.push(parsed);
					} else {
						malformed.push(line);
					}
				} catch {
					malformed.push(line);
				}
			}
			boundary = this.buffer.indexOf('\n');
		}
		return { messages, malformed };
	}
}

export function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
	if (typeof value !== 'object' || value === null || (value as JsonRpcMessage).jsonrpc !== '2.0') {
		return false;
	}
	const candidate = value as Partial<IJsonRpcRequest & IJsonRpcResponse>;
	if (typeof candidate.method === 'string') {
		return candidate.id === undefined || typeof candidate.id === 'number' || typeof candidate.id === 'string';
	}
	return (typeof candidate.id === 'number' || typeof candidate.id === 'string') && ('result' in candidate || 'error' in candidate);
}

export function isRequest(message: JsonRpcMessage): message is IJsonRpcRequest {
	return 'method' in message && 'id' in message && message.id !== undefined;
}

export function isNotification(message: JsonRpcMessage): message is IJsonRpcNotification {
	return 'method' in message && !('id' in message && (message as IJsonRpcRequest).id !== undefined);
}

export function isResponse(message: JsonRpcMessage): message is IJsonRpcResponse {
	return !('method' in message);
}
