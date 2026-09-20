import { Raw } from '@vscode/prompt-tsx';
import { ChatFetchResponseType, ChatLocation } from '../../../../platform/chat/common/commonTypes';
import { getTextPart } from '../../../../platform/chat/common/globalStringUtils';
import { IRunCommandExecutionService } from '../../../../platform/commands/common/runCommandExecutionService';
import { ILogService } from '../../../../platform/log/common/logService';
import { IChatEndpoint } from '../../../../platform/networking/common/networking';
import { CancellationTokenSource } from '../../../../util/vs/base/common/cancellation';

/** Hermes lifecycle adapted to the existing workbench endpoint and runtime memory store. */
export class RuntimeMemoryLifecycle {
	private static readonly reviews = new Map<string, CancellationTokenSource>();

	constructor(
		@IRunCommandExecutionService private readonly commands: IRunCommandExecutionService,
		@ILogService private readonly log: ILogService,
	) { }

	static cancel(sessionId: string | undefined): void {
		if (sessionId) { this.reviews.get(sessionId)?.cancel(); }
	}

	private evidence(messages: readonly Raw.ChatMessage[]): { role: 'user' | 'assistant' | 'tool'; text: string }[] {
		return messages.flatMap(message => {
			if (message.role === Raw.ChatRole.System) { return []; }
			const role = message.role === Raw.ChatRole.User ? 'user' : message.role === Raw.ChatRole.Assistant ? 'assistant' : 'tool';
			const text = getTextPart(message.content);
			return text ? [{ role, text }] : [];
		});
	}

	async checkpoint(sessionId: string | undefined, messages: readonly Raw.ChatMessage[]): Promise<void> {
		if (!sessionId) { return; }
		try {
			await this.commands.executeCommand('latent.runtime.api.ensureStarted');
			await this.commands.executeCommand('latent.runtime.api.memoryCheckpoint', sessionId, this.evidence(messages));
		} catch (error) {
			// The native session transcript still remains available when the optional runtime is disabled.
			this.log.debug(`[RuntimeMemory] Checkpoint unavailable: ${String(error)}`);
		}
	}

	async review(sessionId: string, messages: readonly Raw.ChatMessage[], endpoint: () => Promise<IChatEndpoint>): Promise<void> {
		RuntimeMemoryLifecycle.cancel(sessionId);
		const cancellation = new CancellationTokenSource();
		RuntimeMemoryLifecycle.reviews.set(sessionId, cancellation);
		const timer = setTimeout(() => cancellation.cancel(), 60_000);
		try {
			await this.commands.executeCommand('latent.runtime.api.ensureStarted');
			const prompt: string = await this.commands.executeCommand('latent.runtime.api.memoryReview');
			if (cancellation.token.isCancellationRequested) { return; }
			const transcript = this.evidence(messages).map(message => `${message.role}: ${message.text}`).join('\n\n').slice(-60_000);
			const model = await endpoint();
			if (cancellation.token.isCancellationRequested) { return; }
			const result = await model.makeChatRequest('runtimeMemoryReview', [
				{ role: Raw.ChatRole.System, content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: prompt }] },
				{ role: Raw.ChatRole.User, content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: transcript }] },
			], undefined, cancellation.token, ChatLocation.Other, undefined, { max_tokens: 2000, temperature: 0 });
			if (result.type === ChatFetchResponseType.Success && !cancellation.token.isCancellationRequested) {
				await this.commands.executeCommand('latent.runtime.api.memoryReview', result.value);
			}
		} catch (error) {
			if (!cancellation.token.isCancellationRequested) { this.log.debug(`[RuntimeMemory] Review unavailable: ${String(error)}`); }
		} finally {
			clearTimeout(timer);
			if (RuntimeMemoryLifecycle.reviews.get(sessionId) === cancellation) { RuntimeMemoryLifecycle.reviews.delete(sessionId); }
			cancellation.dispose();
		}
	}
}
