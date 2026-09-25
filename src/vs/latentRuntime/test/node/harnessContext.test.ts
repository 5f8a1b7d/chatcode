/* eslint-disable header/header */
import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RuntimeClient } from '../../../platform/latentRuntime/node/runtimeClient.js';
import { IBotConfig, IHarnessContextInput } from '../../../platform/latentRuntime/common/runtimeProtocol.js';
import { RuntimeServer } from '../../node/runtimeServer.js';

suite('Harness profile tools through runtime RPC', () => {
	let root: string; let runtime: RuntimeServer; let client: RuntimeClient;
	setup(async () => {
		root = await fs.mkdtemp(join(tmpdir(), 'harness-profile-test-'));
		runtime = new RuntimeServer(join(root, 'runtime'), 'fixture-token', () => {}, () => {});
		await runtime.start(join(root, 'runtime.sock'));
		client = await RuntimeClient.connect(join(root, 'runtime.sock'), 'fixture-token');
		for (const id of ['a', 'b']) {
			await client.call('bots.upsert', { id, name: id, systemPrompt: `Soul ${id}`, execution: { kind: 'harness', harness: 'codex' }, capabilities: [], toolAuthorizationScope: { allowTools: ['*'], allowPaths: [], allowNetwork: [], autoApprove: true } } satisfies IBotConfig);
		}
	});
	teardown(async () => { client?.dispose(); await runtime?.shutdown(); await fs.rm(root, { recursive: true, force: true }); });
	const call = <T>(input: IHarnessContextInput) => client.call<T>('harness.context', input);
	test('projects concurrent tool evidence and confines search, including direct-id reads, to the owning profile', async () => {
		const a = await call<{ sessionId: string }>({ action: 'create', botId: 'a' });
		const b = await call<{ sessionId: string }>({ action: 'create', botId: 'b' });
		await Promise.all(Array.from({ length: 8 }, (_, i) => call({ action: 'record', botId: 'a', sessionId: a.sessionId, role: 'tool', text: `quartzproof ${i}` })));
		const snapshot = await call<{ prompt: string; tools: { name: string }[] }>({ action: 'snapshot', botId: 'a', sessionId: a.sessionId });
		assert.ok(snapshot.prompt.includes('Soul a')); assert.ok(snapshot.tools.some(tool => tool.name === 'session_search'));
		const own = await call<string>({ action: 'tool', botId: 'a', sessionId: a.sessionId, tool: 'session_search', args: { sessionId: a.sessionId } });
		const other = await call<string>({ action: 'tool', botId: 'b', sessionId: b.sessionId, tool: 'session_search', args: { sessionId: a.sessionId } });
		assert.ok(own.includes('quartzproof 7')); assert.ok(!other.includes('quartzproof'));
		await assert.rejects(call({ action: 'snapshot', botId: 'b', sessionId: a.sessionId }), /ownership/);
	});
	test('default profile tools do not create a second __default__ memory home', async () => {
		const session = await call<{ sessionId: string }>({ action: 'create' });
		await call({ action: 'tool', sessionId: session.sessionId, tool: 'memory', args: { action: 'add', target: 'user', content: 'Prefers Chinese' } });
		const snapshot = await call<{ prompt: string }>({ action: 'snapshot', sessionId: session.sessionId });
		assert.ok(snapshot.prompt.includes('Prefers Chinese'));
		await call({ action: 'record', sessionId: session.sessionId, role: 'user', text: 'defaultquartz' });
		assert.ok((await call<string>({ action: 'tool', sessionId: session.sessionId, tool: 'session_search', args: { sessionId: session.sessionId } })).includes('defaultquartz'));
	});
});
