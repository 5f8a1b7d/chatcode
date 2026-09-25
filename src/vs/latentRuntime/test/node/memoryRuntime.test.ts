/* eslint-disable header/header */
import assert from 'assert';
import { promises as fs } from 'fs';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { RuntimeClient } from '../../../platform/latentRuntime/node/runtimeClient.js';
import { IBotConfig, IMemorySnapshot, IRuntimeSessionRef } from '../../../platform/latentRuntime/common/runtimeProtocol.js';
import { RuntimeServer } from '../../node/runtimeServer.js';

suite('Memory and compression through runtime RPC', () => {
	let root: string; let runtime: RuntimeServer; let client: RuntimeClient; let model: Server;
	let summaries = 0; const requests: { role: string; content: string; tool_calls?: object[] }[][] = [];
	setup(async () => {
		root = await fs.mkdtemp(join(tmpdir(), 'memory-rpc-'));
		summaries = 0; requests.length = 0;
		model = createServer(async (request, response) => {
			let raw = ''; for await (const chunk of request) { raw += chunk; }
			const body = JSON.parse(raw) as { messages: typeof requests[number]; max_tokens?: number; stream?: boolean };
			const { messages } = body;
			requests.push(messages);
			const last = messages.at(-1)!;
			let message: object;
			if (messages[0].content.startsWith('Summarize historical')) {
				summaries++;
				assert.strictEqual(body.max_tokens, undefined, 'summary reasoning must not be cut off by a small wire token cap');
				assert.strictEqual(body.stream, true);
				response.setHeader('content-type', 'text/event-stream');
				response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'Thinking about the evidence.' } }] })}\n\n`);
				response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Historical work completed. Preserve user requests and continue the latest task.' }, finish_reason: 'stop' }] })}\n\n`);
				response.end('data: [DONE]\n\n'); return;
			}
			else if (last.role === 'tool') { message = { content: last.content }; }
			else if (last.content.startsWith('@@')) {
				const match = /^@@(\w+) (.+)$/.exec(last.content)!;
				message = { content: '', tool_calls: [{ id: `call-${requests.length}`, type: 'function', function: { name: match[1], arguments: match[2] } }] };
			} else { message = { content: last.content.includes('long') ? 'Verified evidence and task decisions. '.repeat(300) : 'answer' }; }
			response.setHeader('content-type', 'application/json');
			response.end(JSON.stringify({ choices: [{ message, finish_reason: 'stop' }], usage: { total_tokens: Math.ceil(JSON.stringify(messages).length / 4) + 100 } }));
		});
		await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
		runtime = new RuntimeServer(join(root, 'runtime'), 'test-token', () => {}, () => {});
		await runtime.start(join(root, 'runtime.sock'));
		client = await RuntimeClient.connect(join(root, 'runtime.sock'), 'test-token');
		await client.call('models.setBinding', { id: 'test', binding: { providerId: 'test', modelId: 'test', protocol: 'openai', baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}`, contextLength: 16000 } });
		for (const id of ['a', 'b']) {
			await client.call('bots.upsert', { id, name: id, systemPrompt: `Soul of ${id}`, execution: { kind: 'provider', modelBindingId: 'test' }, capabilities: [], toolAuthorizationScope: { allowTools: ['*'], allowPaths: [], allowNetwork: [], autoApprove: true } } satisfies IBotConfig);
		}
	});
	teardown(async () => {
		client?.dispose(); await runtime?.shutdown();
		model?.closeAllConnections(); if (model?.listening) { await new Promise<void>(resolve => model.close(() => resolve())); }
		await fs.rm(root, { recursive: true, force: true });
	});
	const run = (botId: string, text: string, sessionId?: string) => client.call<{ session: IRuntimeSessionRef; text: string }>('bots.run', { botId, input: { text, sessionId } });

	test('new bots get a canonical chat and profile-local memory/search, including direct-id reads', async () => {
		const sessions = await client.call<IRuntimeSessionRef[]>('sessions.list');
		assert.deepStrictEqual(sessions.map(session => [session.botId, session.title]).sort(), [['a', 'Bot Chat'], ['b', 'Bot Chat']]);
		await run('a', '@@memory {"action":"add","target":"user","content":"Prefers Chinese"}');
		const a = await client.call<IMemorySnapshot>('memory.profile', { botId: 'a', action: 'snapshot' });
		const b = await client.call<IMemorySnapshot>('memory.profile', { botId: 'b', action: 'snapshot' });
		const general = await client.call<IMemorySnapshot>('memory.snapshot');
		assert.deepStrictEqual([a.user, b.user, general.user], ['Prefers Chinese', '', '']);
		const secret = await run('a', 'quartzsecret private planning result');
		const own = await run('a', '@@session_search {"query":"quartzsecret"}');
		const other = await run('b', '@@session_search {"query":"quartzsecret"}');
		const direct = await run('b', `@@session_search ${JSON.stringify({ sessionId: secret.session.sessionId })}`);
		assert.ok(own.text.includes('quartzsecret'));
		assert.ok(!other.text.includes('quartzsecret') && !direct.text.includes('quartzsecret'));
	});

	test('canonical /new compacts in place, refreshes memory, preserves tools and searchable history', async () => {
		const canonical = (await client.call<IRuntimeSessionRef[]>('sessions.list')).find(session => session.botId === 'a')!;
		for (let i = 0; i < 14; i++) { await run('a', `long ${i} quartzorigin`, canonical.sessionId); }
		assert.ok(summaries > 0, 'automatic compression should have run');
		const profile = await client.call<IMemorySnapshot & { profileHome: string }>('memory.profile', { botId: 'a', action: 'snapshot' });
		await fs.writeFile(join(profile.profileHome, 'config.yaml'), 'compression:\n  enabled: false\n');
		for (let i = 0; i < 4; i++) { await run('a', `long manual ${i}`, canonical.sessionId); }
		await run('a', '@@memory {"action":"add","target":"user","content":"Prefers concise replies"}', canonical.sessionId);
		const before = (await client.call<object[]>('sessions.turns', { sessionId: canonical.sessionId })).length;
		const compressed = await run('a', '/new', canonical.sessionId);
		assert.strictEqual(compressed.session.sessionId, canonical.sessionId);
		assert.strictEqual((await client.call<object[]>('sessions.turns', { sessionId: canonical.sessionId })).length, before);
		assert.match(compressed.text, /compacted/);
		await run('a', 'continue', canonical.sessionId);
		assert.ok(requests.at(-1)![0].content.includes('Prefers concise replies'));
		assert.ok(requests.at(-1)!.some(message => message.tool_calls?.length) && requests.at(-1)!.some(message => message.role === 'tool'), 'tool protocol should survive across user turns and compression');
		const archived = await run('a', '@@session_search {"query":"quartzorigin"}', canonical.sessionId);
		assert.ok(archived.text.includes('quartzorigin'), 'the active conversation must still be able to search its compacted evidence');
		const history = await run('a', '@@session_search {"query":"quartzorigin"}');
		assert.ok(history.text.includes('quartzorigin'));
		const ordinary = await run('a', 'ordinary');
		const fresh = await run('a', '/new', ordinary.session.sessionId);
		assert.notStrictEqual(fresh.session.sessionId, ordinary.session.sessionId);
	});

	test('a restarted runtime resumes the exact stored wire context, not reconstructed display turns', async () => {
		const first = await run('a', '@@memory {"action":"read"}');
		await run('a', 'continue', first.session.sessionId);
		const before = requests.at(-1)!;
		client.dispose(); await runtime.shutdown();
		runtime = new RuntimeServer(join(root, 'runtime'), 'test-token', () => {}, () => {});
		await runtime.start(join(root, 'runtime.sock'));
		client = await RuntimeClient.connect(join(root, 'runtime.sock'), 'test-token');
		await run('a', 'after restart', first.session.sessionId);
		assert.deepStrictEqual(requests.at(-1), [...before, { role: 'assistant', content: 'answer' }, { role: 'user', content: 'after restart' }]);
	});
});
