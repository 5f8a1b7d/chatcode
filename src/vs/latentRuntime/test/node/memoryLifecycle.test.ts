/* eslint-disable header/header */
import assert from 'assert';
import { createServer } from 'http';
import { AddressInfo } from 'net';
import { IBotConfig } from '../../../platform/latentRuntime/common/runtimeProtocol.js';
import { BotRunner, SessionStore } from '../../node/bots/botRunner.js';
import { ApprovalService } from '../../node/bots/approvals.js';
import { ToolRegistry } from '../../node/bots/tools.js';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { memoryCheckpoint, parseMemoryReview } from '../../node/memory/memoryLifecycle.js';
import { MemoryStore } from '../../node/memory/memoryStore.js';
import { RecallIndex } from '../../node/memory/recallIndex.js';
import { RuntimeDatabase } from '../../node/runtimeDatabase.js';

suite('Latent memory lifecycle', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	let root: string;
	let db: RuntimeDatabase;
	setup(async () => { root = await fs.mkdtemp(join(tmpdir(), 'latent-memory-lifecycle-')); db = await RuntimeDatabase.open(join(root, 'runtime.db')); });
	teardown(async () => { await db.close(); await fs.rm(root, { recursive: true, force: true }); });

	test('review starts after ten turns, yields to new input, and skips scheduled jobs and read-only bots', async () => {
		const server = createServer((request, response) => {
			request.resume();
			request.on('end', () => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content: 'done' } }] })); });
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const sessions = new SessionStore(db);
		const reviews: AbortSignal[] = [];
		const bot: IBotConfig = { id: 'b', name: 'B', systemPrompt: 'Test', execution: { kind: 'provider', modelBindingId: 'model' }, toolAuthorizationScope: { allowTools: ['memory'], allowPaths: [], allowNetwork: [], autoApprove: true }, capabilities: [] };
		const runner = new BotRunner(sessions, {
			approvals: new ApprovalService(() => 100, () => undefined), tools: new ToolRegistry(), bot: () => bot,
			modelBinding: () => ({ providerId: 'test', modelId: 'test', protocol: 'openai', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }),
			toolContext: () => ({ workingDirectory: root, botId: bot.id, sessionId: '', recall: async () => '', memoryWrite: async () => '', artifact: async () => '', runBot: async () => ({ sessionId: '', text: '' }), log: () => undefined }),
			onTurn: async () => undefined, approvalTimeoutMs: 100, log: () => undefined,
			reviewMemory: async (_complete, _transcript, signal) => { reviews.push(signal); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); },
		});
		try {
			const session = await sessions.create(bot.id, 'Test', 'workbench');
			for (let turn = 0; turn < 10; turn++) { await runner.run(bot, { text: 'Test', sessionId: session.sessionId }, 'workbench'); }
			assert.strictEqual(reviews.length, 1);
			assert.strictEqual(reviews[0].aborted, false);
			await runner.run(bot, { text: 'Next', sessionId: session.sessionId }, 'workbench');
			assert.strictEqual(reviews[0].aborted, true);
			for (let turn = 0; turn < 9; turn++) { await runner.run(bot, { text: 'Scheduled', sessionId: session.sessionId }, 'job'); }
			const readonlyBot = { ...bot, toolAuthorizationScope: { ...bot.toolAuthorizationScope, allowTools: ['recall'] } };
			for (let turn = 0; turn < 10; turn++) { await runner.run(readonlyBot, { text: 'Read only', sessionId: session.sessionId }, 'workbench'); }
			assert.strictEqual(reviews.length, 1);
		} finally {
			server.closeAllConnections();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	test('a malformed review cannot partially apply earlier valid operations', () => {
		assert.throws(() => parseMemoryReview('[{"target":"user","action":"add","content":"prefers terse answers"},{"target":"user","action":"replace"}]'));
		assert.deepStrictEqual(parseMemoryReview('[]'), []);
	});

	test('review consolidation is a single pending change and cannot silently replace existing facts', async () => {
		const store = new MemoryStore(join(root, 'runtime'));
		await store.initialize();
		await store.write({ action: 'add', target: 'user', content: 'Prefers detailed explanations' });
		const [plan] = parseMemoryReview('[{"target":"user","action":"replace","oldText":"detailed","content":"Prefers concise explanations"}]');
		const result = await store.write(plan);
		assert.strictEqual(result.applied, false);
		assert.ok(result.staged);
		assert.strictEqual((await store.snapshot()).user, 'Prefers detailed explanations');
		await store.confirmStaged(result.staged.id, true);
		assert.strictEqual((await store.snapshot()).user, 'Prefers concise explanations');
	});

	test('pre-compression checkpoints keep tool evidence, are idempotent and exclude the active session', async () => {
		const index = new RecallIndex(db);
		const messages = [{ role: 'tool' as const, text: 'parser evidence from tool output' }];
		const first = memoryCheckpoint('ordinary-session', messages);
		const second = memoryCheckpoint('ordinary-session', messages);
		assert.strictEqual(first[0].sessionId, second[0].sessionId);
		await index.index(first);
		await index.index(second);
		assert.strictEqual((await index.recall('parser evidence'))[0].blockType, 'tool_result');
		assert.strictEqual((await index.recall('parser evidence', { excludeSessionId: 'ordinary-session' })).length, 0);
		assert.strictEqual((await db.get<{ count: number }>('SELECT COUNT(*) AS count FROM messages'))?.count, 1);
	});
});
