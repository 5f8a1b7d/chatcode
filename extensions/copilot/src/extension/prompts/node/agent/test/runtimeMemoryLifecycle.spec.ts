import { Raw } from '@vscode/prompt-tsx';
import { describe, expect, test } from 'vitest';
import { ChatFetchResponseType } from '../../../../../platform/chat/common/commonTypes';
import { IRunCommandExecutionService } from '../../../../../platform/commands/common/runCommandExecutionService';
import { ILogService } from '../../../../../platform/log/common/logService';
import { IChatEndpoint } from '../../../../../platform/networking/common/networking';
import { CancellationToken } from '../../../../../util/vs/base/common/cancellation';
import { RuntimeMemoryLifecycle } from '../runtimeMemoryLifecycle';

function fixture(disabled = false) {
	const calls: { command: string; args: unknown[] }[] = [];
	const commands: IRunCommandExecutionService = {
		_serviceBrand: undefined,
		executeCommand: async (command, ...args) => {
			calls.push({ command, args });
			if (disabled) { throw new Error('Runtime disabled'); }
			return command.endsWith('memoryReview') && !args.length ? 'Review only durable facts.' : undefined;
		},
	};
	return { calls, lifecycle: new RuntimeMemoryLifecycle(commands, { debug: () => undefined } as unknown as ILogService) };
}

const messages: Raw.ChatMessage[] = [{ role: Raw.ChatRole.User, content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: 'I prefer short answers.' }] }];

describe('Runtime memory lifecycle', () => {
	test('checkpoint excludes the system prompt and retains tool evidence', async () => {
		const { calls, lifecycle } = fixture();
		await lifecycle.checkpoint('s', [
			{ role: Raw.ChatRole.System, content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: 'Private system prompt' }] },
			...messages,
			{ role: Raw.ChatRole.Tool, toolCallId: 'tool', content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: 'Verified parser output' }] },
		]);
		expect(calls.at(-1)?.args).toEqual(['s', [{ role: 'user', text: 'I prefer short answers.' }, { role: 'tool', text: 'Verified parser output' }]]);
	});

	test('disabled runtime makes no model request', async () => {
		const { lifecycle } = fixture(true);
		let requested = false;
		await lifecycle.review('disabled', messages, async () => { requested = true; throw new Error('Should not request a model'); });
		expect(requested).toBe(false);
	});

	test('new user input cancels an in-flight review without committing its result', async () => {
		const { calls, lifecycle } = fixture();
		let started!: () => void;
		const startedPromise = new Promise<void>(resolve => started = resolve);
		const endpoint = { makeChatRequest: async (...args: unknown[]) => {
			const token = args[3] as CancellationToken;
			started();
			await new Promise<void>(resolve => { const listener = token.onCancellationRequested(() => { listener.dispose(); resolve(); }); });
			return { type: ChatFetchResponseType.Success, value: '[{"target":"user","action":"add","content":"stale"}]' };
		} } as unknown as IChatEndpoint;
		const pending = lifecycle.review('cancelled', messages, async () => endpoint);
		await startedPromise;
		RuntimeMemoryLifecycle.cancel('cancelled');
		await pending;
		expect(calls.filter(call => call.command.endsWith('memoryReview') && call.args.length)).toEqual([]);
	});

	test('successful review is committed through the runtime validator only', async () => {
		const { calls, lifecycle } = fixture();
		const result = '[{"target":"user","action":"add","content":"Prefers concise answers"}]';
		const endpoint = { makeChatRequest: async () => ({ type: ChatFetchResponseType.Success, value: result }) } as unknown as IChatEndpoint;
		await lifecycle.review('completed', messages, async () => endpoint);
		expect(calls.at(-1)).toEqual({ command: 'latent.runtime.api.memoryReview', args: [result] });
	});
});
