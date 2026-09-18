import * as vscode from 'vscode';
import { parseCanonicalEvent, parseMemoryReceipt, SseDecoder, type MemoryReceipt } from './protocol';
import type { SelectionSnapshot } from '../editor/selection';

export interface ExplanationResult {
	readonly text: string;
	readonly traceId?: string;
	readonly modelDecisionId?: string;
}

export interface SavedMemory {
	readonly memoryId: string;
	readonly selectedText: string;
	readonly explanation: string;
	readonly createdAt: string;
	readonly source: { readonly uri?: string };
}

export class StudyBuddyServiceError extends Error {
	constructor(
		message: string,
		readonly code?: string,
	) {
		super(message);
	}
}

export class StudyBuddyClient {
	constructor(
		private readonly serviceUrl: string,
		private readonly authorization: string,
	) { }

	async explain(
		requestId: string,
		prompt: string,
		selection: SelectionSnapshot,
		token: vscode.CancellationToken,
		onDelta: (text: string) => void,
	): Promise<ExplanationResult> {
		const controller = new AbortController();
		const cancellation = token.onCancellationRequested(() => controller.abort());
		try {
			const response = await this.request(this.endpoint('/v1/extension/explain'), {
				method: 'POST',
				headers: {
					accept: 'text/event-stream',
					authorization: this.authorization,
					'content-type': 'application/json',
					'x-studybuddy-task-id': requestId,
				},
				body: JSON.stringify({ prompt, pageText: selection.text }),
				signal: controller.signal,
			});
			if (!response.ok || !response.body) {
				throw await responseError(response);
			}
			const decoder = new SseDecoder();
			const textDecoder = new TextDecoder();
			const reader = response.body.getReader();
			let received = '';
			let finishedText = '';
			let terminal = false;
			const acceptData = (data: string): void => {
				const event = parseCanonicalEvent(data);
				if (!event) {
					return;
				}
				switch (event.type) {
					case 'text_delta':
						received += event.text;
						onDelta(event.text);
						break;
					case 'finished':
						finishedText = event.text;
						terminal = true;
						break;
					case 'cancelled':
						throw new vscode.CancellationError();
					case 'refused':
					case 'failed':
						throw new StudyBuddyServiceError(
							vscode.l10n.t('Study Buddy could not explain this selection ({0}).', event.code),
							event.code,
						);
				}
			};
			try {
				while (!token.isCancellationRequested) {
					const chunk = await reader.read();
					if (chunk.done) {
						break;
					}
					for (const data of decoder.accept(textDecoder.decode(chunk.value, { stream: true }))) {
						acceptData(data);
					}
				}
				for (const data of decoder.accept(textDecoder.decode())) {
					acceptData(data);
				}
				decoder.finish();
			} finally {
				await reader.cancel().catch(() => undefined);
			}
			if (token.isCancellationRequested) {
				throw new vscode.CancellationError();
			}
			if (!terminal) {
				throw new StudyBuddyServiceError(vscode.l10n.t('The Study Buddy stream ended unexpectedly.'));
			}
			return {
				text: finishedText || received,
				traceId: response.headers.get('x-studybuddy-trace-id') ?? undefined,
				modelDecisionId: response.headers.get('x-studybuddy-model-decision-id') ?? undefined,
			};
		} catch (error) {
			if (token.isCancellationRequested || isAbortError(error)) {
				throw new vscode.CancellationError();
			}
			throw error;
		} finally {
			cancellation.dispose();
		}
	}

	async saveMemory(
		requestId: string,
		selection: SelectionSnapshot,
		explanation: string,
		traceId?: string,
		modelDecisionId?: string,
	): Promise<MemoryReceipt> {
		const response = await this.request(this.endpoint('/v1/extension/memories'), {
			method: 'POST',
			headers: {
				authorization: this.authorization,
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				schemaVersion: 1,
				requestId,
				projectId: selection.projectId,
				taskId: requestId,
				selectedText: selection.text,
				explanation,
				createdAt: new Date().toISOString(),
				...(traceId ? { traceId } : {}),
				...(modelDecisionId ? { modelDecisionId } : {}),
				source: selection.kind === 'editor'
					? {
						uri: selection.uri,
						documentVersion: selection.documentVersion,
						range: selection.range,
					}
					: {
						kind: selection.kind,
						selectionId: selection.selectionId,
						capturedAt: new Date(selection.capturedAt).toISOString(),
						...(selection.application ? { application: selection.application } : {}),
					},
			}),
		});
		if (!response.ok) {
			throw await responseError(response);
		}
		const body: unknown = await response.json();
		return parseMemoryReceipt(body);
	}

	async searchMemories(projectId: string, query: string, token: vscode.CancellationToken): Promise<readonly SavedMemory[]> {
		const url = this.endpoint('/v1/extension/memories/search');
		url.searchParams.set('projectId', projectId);
		url.searchParams.set('query', query);
		const controller = new AbortController();
		const cancellation = token.onCancellationRequested(() => controller.abort());
		try {
			const response = await this.request(url, {
				method: 'GET',
				headers: { authorization: this.authorization },
				signal: controller.signal,
			});
			if (!response.ok) {
				throw await responseError(response);
			}
			const body: unknown = await response.json();
			if (!isRecord(body) || body.schemaVersion !== 1 || !Array.isArray(body.memories)) {
				throw new StudyBuddyServiceError(vscode.l10n.t('Study Buddy returned an invalid memory search result.'));
			}
			return body.memories.map((value: unknown) => {
				if (!isRecord(value) || typeof value.memoryId !== 'string' || typeof value.selectedText !== 'string' || typeof value.explanation !== 'string' || typeof value.createdAt !== 'string' || !isRecord(value.source)) {
					throw new StudyBuddyServiceError(vscode.l10n.t('Study Buddy returned an invalid memory search result.'));
				}
				return {
					memoryId: value.memoryId,
					selectedText: value.selectedText,
					explanation: value.explanation,
					createdAt: value.createdAt,
					source: { uri: typeof value.source.uri === 'string' ? value.source.uri : undefined },
				};
			});
		} catch (error) {
			if (token.isCancellationRequested || isAbortError(error)) {
				throw new vscode.CancellationError();
			}
			throw error;
		} finally {
			cancellation.dispose();
		}
	}

	private endpoint(path: string): URL {
		const root = this.serviceUrl.endsWith('/') ? this.serviceUrl : `${this.serviceUrl}/`;
		return new URL(path.replace(/^\//, ''), root);
	}

	private async request(url: URL, init: RequestInit): Promise<Response> {
		try {
			return await fetch(url, init);
		} catch (error) {
			if (error instanceof TypeError) {
				throw new StudyBuddyServiceError(
					vscode.l10n.t(
						'Cannot connect to Study Buddy. Start the local service and verify the latentnote.studyBuddy.serviceUrl setting.',
					),
					'service_unreachable',
				);
			}
			throw error;
		}
	}
}

async function responseError(response: Response): Promise<StudyBuddyServiceError> {
	let code: string | undefined;
	let message = vscode.l10n.t('Study Buddy request failed with status {0}.', response.status);
	try {
		const body: unknown = await response.json();
		if (isRecord(body)) {
			if (typeof body.code === 'string') {
				code = body.code;
			}
			if (typeof body.message === 'string') {
				message = body.message;
			}
		}
	} catch {
		// The status remains useful when the server did not return JSON.
	}
	return new StudyBuddyServiceError(message, code);
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === 'AbortError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
