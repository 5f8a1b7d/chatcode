export type CanonicalModelEvent =
	| { readonly type: 'text_delta'; readonly text: string }
	| { readonly type: 'finished'; readonly text: string }
	| { readonly type: 'cancelled'; readonly code: string }
	| { readonly type: 'refused'; readonly code: string }
	| { readonly type: 'failed'; readonly code: string };

export interface MemoryReceipt {
	readonly schemaVersion: 1;
	readonly memoryId: string;
	readonly persistedAt: string;
}

export class SseDecoder {
	private buffer = '';

	accept(text: string): string[] {
		const combined = this.buffer + text;
		const hasTrailingCarriageReturn = combined.endsWith('\r');
		const completeText = hasTrailingCarriageReturn ? combined.slice(0, -1) : combined;
		this.buffer = completeText.replaceAll('\r\n', '\n').replaceAll('\r', '\n') + (hasTrailingCarriageReturn ? '\r' : '');
		const result: string[] = [];
		let boundary = this.buffer.indexOf('\n\n');
		while (boundary >= 0) {
			const block = this.buffer.slice(0, boundary);
			this.buffer = this.buffer.slice(boundary + 2);
			const data = block
				.split('\n')
				.filter(line => line.startsWith('data:'))
				.map(line => line.slice(5).trimStart())
				.join('\n');
			if (data) {
				result.push(data);
			}
			boundary = this.buffer.indexOf('\n\n');
		}
		return result;
	}

	finish(): void {
		if (this.buffer.trim()) {
			throw new Error('Study Buddy returned an incomplete stream event.');
		}
	}
}

export function parseCanonicalEvent(data: string): CanonicalModelEvent | undefined {
	if (data === '[DONE]') {
		return undefined;
	}
	const value: unknown = JSON.parse(data);
	if (!isRecord(value) || typeof value.type !== 'string') {
		throw new Error('Study Buddy returned an invalid stream event.');
	}
	switch (value.type) {
		case 'text_delta':
			if (typeof value.text !== 'string') {
				throw new Error('Study Buddy returned an invalid text delta.');
			}
			return { type: value.type, text: value.text };
		case 'finished':
			return { type: value.type, text: readFinishedText(value) };
		case 'cancelled':
		case 'refused':
			return { type: value.type, code: stringValue(value.code, value.type) };
		case 'failed': {
			const failure = isRecord(value.failure) ? value.failure : {};
			return { type: value.type, code: stringValue(failure.code, 'failed') };
		}
		default:
			return undefined;
	}
}

export function parseMemoryReceipt(value: unknown): MemoryReceipt {
	if (
		!isRecord(value) ||
		value.schemaVersion !== 1 ||
		typeof value.memoryId !== 'string' ||
		!value.memoryId ||
		typeof value.persistedAt !== 'string' ||
		!value.persistedAt
	) {
		throw new Error('Study Buddy returned an invalid memory receipt.');
	}
	return {
		schemaVersion: 1,
		memoryId: value.memoryId,
		persistedAt: value.persistedAt,
	};
}

function readFinishedText(event: Record<string, unknown>): string {
	if (!Array.isArray(event.message)) {
		return '';
	}
	return event.message
		.filter(isRecord)
		.filter(block => block.type === 'text' && typeof block.text === 'string')
		.map(block => block.text as string)
		.join('');
}

function stringValue(value: unknown, fallback: string): string {
	return typeof value === 'string' && value ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
