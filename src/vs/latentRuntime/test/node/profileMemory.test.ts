/* eslint-disable header/header */
import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MemoryProfiles } from '../../node/memory/profiles.js';
import { RuntimeDatabase } from '../../node/runtimeDatabase.js';
import { RecallIndex } from '../../node/memory/recallIndex.js';
import { ConversationContexts } from '../../node/memory/conversationContext.js';
import { IConversationMessage } from '../../../platform/latentRuntime/common/runtimeProtocol.js';

suite('Profile-local memory and conversations', () => {
	let root: string; let database: RuntimeDatabase; let profiles: MemoryProfiles;
	setup(async () => { root = await fs.mkdtemp(join(tmpdir(), 'profile-memory-test-')); await fs.mkdir(join(root, 'runtime')); database = await RuntimeDatabase.open(join(root, 'runtime', 'runtime.db')); profiles = new MemoryProfiles(join(root, 'runtime'), database, () => {}); });
	teardown(async () => { await profiles.dispose(); await database.close(); await fs.rm(root, { recursive: true, force: true }); });

	test('migrates history by owner, including checkpoints, without copying global user facts into bots', async () => {
		await fs.mkdir(join(root, 'memory')); await fs.writeFile(join(root, 'memory', 'USER.md'), 'Global personal preference');
		await database.run('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)', ['a-session', 'a', 'Bot Chat', 'workbench', 1, 1]);
		await database.run('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)', ['b-session', 'b', 'Bot Chat', 'workbench', 1, 1]);
		await new RecallIndex(database).index(['a-session', 'a-session#checkpoint-123', 'b-session', 'ordinary'].map(sessionId => ({ sessionId, seq: 0, role: 'user', blockType: 'text', text: `evidence ${sessionId}`, timestamp: 1, harness: 'test', workdir: root })));
		const a = await profiles.get('a'); const b = await profiles.get('b'); const general = await profiles.get();
		assert.deepStrictEqual(await a.database.all('SELECT DISTINCT session_id FROM recall_turns ORDER BY session_id'), [{ session_id: 'a-session' }, { session_id: 'a-session#checkpoint-123' }]);
		assert.deepStrictEqual(await b.database.all('SELECT DISTINCT session_id FROM recall_turns'), [{ session_id: 'b-session' }]);
		assert.deepStrictEqual(await general.database.all('SELECT DISTINCT session_id FROM recall_turns'), [{ session_id: 'ordinary' }]);
		assert.deepStrictEqual([(await general.memory.snapshot()).user, (await a.memory.snapshot()).user, (await b.memory.snapshot()).user], ['Global personal preference', '', '']);
		assert.strictEqual(await fs.readFile(join(root, 'memory', 'USER.md'), 'utf8'), 'Global personal preference');
		await profiles.dispose();
		await fs.unlink(join(root, 'memories', 'USER.md'));
		profiles = new MemoryProfiles(join(root, 'runtime'), database, () => {});
		assert.strictEqual((await (await profiles.get()).memory.snapshot()).user, '', 'a deliberately removed file must not resurrect old legacy memory');
	});

	test('profile writes and clones evolve independently and do not clone pending approvals', async () => {
		assert.throws(() => profiles.get(''), /non-empty/, 'an empty bot id must not alias the default profile');
		const a = await profiles.get('a'); await a.memory.write({ action: 'add', target: 'user', content: 'Prefers Chinese' });
		await a.memory.write({ action: 'replace', target: 'user', oldText: 'Chinese', content: 'Prefers English' });
		await profiles.clone('a', 'b'); const b = await profiles.get('b');
		await b.memory.write({ action: 'add', target: 'user', content: 'Likes short answers' });
		assert.deepStrictEqual([(await a.memory.snapshot()).user.includes('short'), (await b.memory.snapshot()).user.includes('short'), (await b.memory.snapshot()).staged.length], [false, true, 0]);
	});

	test('streaming conversation survives runtime restart with a frozen memory prefix', async () => {
		let contexts = new ConversationContexts(profiles, async () => ({ text: 'summary' }), () => {});
		const binding = { providerId: 'test', modelId: 'model', protocol: 'openai', baseUrl: 'https://unused.invalid', contextLength: 128000 };
		const first = await contexts.prepare({ sessionId: 'thread', requestId: 'r1', modelBindingId: 'm', history: [], text: 'hello', prompt: 'hello' }, binding);
		await contexts.commit('thread', 'r1', [{ role: 'assistant', content: 'answer' }], 'answer');
		await (await profiles.get()).memory.write({ action: 'add', target: 'user', content: 'New preference' });
		await profiles.dispose(); profiles = new MemoryProfiles(join(root, 'runtime'), database, () => {});
		contexts = new ConversationContexts(profiles, async () => ({ text: 'summary' }), () => {});
		const second = await contexts.prepare({ sessionId: 'thread', requestId: 'r2', modelBindingId: 'm', history: [{ role: 'user', text: 'hello' }, { role: 'assistant', text: 'answer' }], text: 'continue', prompt: 'continue' }, binding);
		assert.deepStrictEqual(second.messages, [...first.messages, { role: 'assistant', content: 'answer' }, { role: 'user', content: 'continue' }]);
		await assert.rejects(contexts.commit('thread', 'r1', [{ role: 'assistant', content: 'stale answer' }], 'stale answer'), /Stale/);
	});

	test('a changed branch rebuilds its working context without erasing original evidence', async () => {
		const contexts = new ConversationContexts(profiles, async () => ({ text: 'summary' }), () => {});
		const binding = { providerId: 'test', modelId: 'model', protocol: 'openai', baseUrl: 'https://unused.invalid' };
		await contexts.prepare({ sessionId: 'thread', requestId: 'r1', modelBindingId: 'm', history: [], text: 'old branch', prompt: 'old branch' }, binding);
		await contexts.commit('thread', 'r1', [{ role: 'assistant', content: 'old answer' }], 'old answer');
		const next = await contexts.prepare({ sessionId: 'thread', requestId: 'r2', modelBindingId: 'm', history: [], text: 'new branch', prompt: 'new branch' }, binding);
		assert.strictEqual(next.messages.some(message => message.content.includes('old branch')), false);
		assert.ok((await (await profiles.get()).recall.recall('old branch')).length > 0);
	});

	test('tool-loop checkpoints are idempotent when cancellation races the response', async () => {
		const contexts = new ConversationContexts(profiles, async () => ({ text: 'summary' }), () => {});
		const binding = { providerId: 'test', modelId: 'model', protocol: 'openai', baseUrl: 'https://unused.invalid' };
		const input = { sessionId: 'tools', requestId: 'r1', modelBindingId: 'm', history: [], text: 'read', prompt: 'read' };
		await contexts.prepare(input, binding);
		const messages: IConversationMessage[] = [{ role: 'assistant', content: '', tool_calls: [{ id: 'call', type: 'function', function: { name: 'memory', arguments: '{"action":"read"}' } }] }, { role: 'tool', content: 'notes', tool_call_id: 'call' }];
		const advanced = await contexts.prepare({ ...input, continuation: messages, offset: 0 }, binding);
		assert.strictEqual(advanced.offset, 2);
		await contexts.commit('tools', 'r1', messages, '', 0);
		const next = await contexts.prepare({ ...input, requestId: 'r2', history: [{ role: 'user', text: 'read' }], text: 'continue', prompt: 'continue' }, binding);
		assert.strictEqual(next.messages.filter(message => message.tool_call_id === 'call').length, 1);
		assert.strictEqual(next.messages.filter(message => message.role === 'user').length, 2);
	});
});
