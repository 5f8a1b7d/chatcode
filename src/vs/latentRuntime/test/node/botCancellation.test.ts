import assert from 'assert';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import type { IBotConfig, IRuntimeSessionRef, IRuntimeSessionTurn } from '../../../platform/latentRuntime/common/runtimeProtocol.js';
import { BotRunner, type SessionStore, wireUserContent } from '../../node/bots/botRunner.js';
import { ApprovalService } from '../../node/bots/approvals.js';
import { ToolRegistry } from '../../node/bots/tools.js';

suite('Bot request cancellation', () => {
	let server: Server;
	teardown(async () => { server?.closeAllConnections(); if (server?.listening) { await new Promise<void>(resolve => server.close(() => resolve())); } });

	async function setupRunner(toolCall = false) {
		let started!: () => void;
		const reachedModel = new Promise<void>(resolve => { started = resolve; });
		server = createServer((_, response) => {
			started();
			if (toolCall) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'call', function: { name: 'write_file', arguments: '{"path":"never-written","content":"x"}' } }] } }] })); }
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const session: IRuntimeSessionRef = { sessionId: 's', botId: 'b', title: 'Test', origin: 'workbench', createdAt: 0, updatedAt: 0 };
		const turns: IRuntimeSessionTurn[] = [];
		const sessions: Pick<SessionStore, 'get' | 'create' | 'append' | 'turns'> = {
			get: async () => session, create: async () => session,
			append: async (_, role, text) => { const turn = { seq: turns.length, role, text, timestamp: Date.now() }; turns.push(turn); return turn; },
			turns: async () => [...turns],
		};
		let prompted!: () => void;
		const reachedApproval = new Promise<void>(resolve => { prompted = resolve; });
		const approvals = new ApprovalService(() => 60000, event => { if (event.kind === 'approvalRequested') { prompted(); } });
		const bot: IBotConfig = { id: 'b', name: 'Bot', systemPrompt: '', execution: { kind: 'provider', modelBindingId: 'm' }, capabilities: [], toolAuthorizationScope: { allowTools: [], allowPaths: [], allowNetwork: [], autoApprove: false } };
		const runner = new BotRunner(sessions, { approvals, tools: new ToolRegistry(), bot: () => bot, modelBinding: () => ({ providerId: 'test', modelId: 'test', protocol: 'openai', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }), approvalTimeoutMs: 60000, onTurn: async () => undefined, log: () => undefined, toolContext: () => ({ botId: bot.id, sessionId: session.sessionId, workingDirectory: '/', recall: async () => '', memoryWrite: async () => '', artifact: async () => '', runBot: async () => ({ sessionId: '', text: '' }), log: () => undefined }) });
		return { runner, bot, turns, approvals, reachedModel, reachedApproval };
	}

	test('interrupt aborts the HTTP request and releases the session without a fake assistant reply', async () => {
		const { runner, bot, turns, reachedModel } = await setupRunner();
		const run = runner.run(bot, { text: 'work', requestId: 'request' }, 'workbench');
		const rejected = assert.rejects(run, /abort/i);
		await reachedModel;
		assert.equal(runner.interrupt('request'), true);
		await rejected;
		assert.deepStrictEqual({ running: runner.isRunning(bot.id), stillInterruptible: runner.interrupt('request'), roles: turns.map(turn => turn.role) }, { running: false, stillInterruptible: false, roles: ['user'] });
	});

	test('interrupt dismisses an outstanding approval and never executes the requested write', async () => {
		const { runner, bot, turns, approvals, reachedApproval } = await setupRunner(true);
		const run = runner.run(bot, { text: 'work', requestId: 'request' }, 'workbench');
		const rejected = assert.rejects(run, /abort/i);
		await reachedApproval;
		assert.equal(approvals.list()[0].requestId, 'request');
		runner.interrupt('request');
		await rejected;
		assert.deepStrictEqual({ approvals: approvals.list(), roles: turns.map(turn => turn.role), running: runner.isRunning(bot.id) }, { approvals: [], roles: ['user'], running: false });
	});
});

suite('Bot attachment transport', () => {
	test('maps images and files to OpenAI-compatible user content parts', () => {
		assert.deepStrictEqual(wireUserContent('inspect', [
			{ id: 'i', name: 'image.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,QQ==', size: 1 },
			{ id: 'f', name: 'paper.pdf', mimeType: 'application/pdf', dataUrl: 'data:application/pdf;base64,Qg==', size: 1 },
		]), [
			{ type: 'text', text: 'inspect' },
			{ type: 'image_url', image_url: { url: 'data:image/png;base64,QQ==' } },
			{ type: 'file', file: { filename: 'paper.pdf', file_data: 'data:application/pdf;base64,Qg==' } },
		]);
	});
});
