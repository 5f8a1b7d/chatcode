/* eslint-disable header/header */
import assert from 'assert';
import { closePendingTools, compressContext, compressionFailed, compressionPartition, compressionThreshold, IConversationContext, observeUsage, pricedContext, shouldCompress } from '../../node/memory/contextCompression.js';

function conversation(): IConversationContext {
	return { version: 1, messages: [{ role: 'system', content: 'frozen soul and memory' }, ...Array.from({ length: 40 }, (_, i) => [{ role: 'user' as const, content: `User ${i}: preserve /project/important.ts` }, { role: 'assistant' as const, content: `${i}: ${'verified evidence '.repeat(1500)}` }]).flat()], tools: [], through: 79, model: 'test', compressions: 0 };
}

suite('Hermes-style context compression', () => {
	test('threshold follows small-window floor, output reservation and absolute cap', () => {
		assert.deepStrictEqual([compressionThreshold(128000), compressionThreshold(64000, 16000), compressionThreshold(1000000), compressionThreshold(1000000, 0, { threshold_tokens: null })], [96000, 40800, 256000, 500000]);
	});
	test('unanchored estimate waits once; usage-less response enables fallback', () => {
		const state = conversation();
		assert.strictEqual(shouldCompress(state, 128000), false);
		observeUsage(state);
		assert.strictEqual(shouldCompress(state, 128000), true);
	});
	test('usage anchor prices only appended deltas and detects same-length prefix edits', () => {
		const state = conversation(); observeUsage(state, 1000);
		assert.strictEqual(pricedContext(state), 1000);
		state.messages.push({ role: 'user', content: 'new' });
		assert.ok(pricedContext(state) > 1000 && pricedContext(state) < 1100);
		state.messages[0].content = 'edited';
		assert.ok(pricedContext(state) > 100000);
	});
	test('commits in place, archives first, refreshes snapshot only at successful boundary', async () => {
		const state = conversation(); const original = JSON.stringify(state); const events: string[] = [];
		const candidate = await compressContext(state, 'same-session', 128000, {
			checkpoint: async () => { events.push('checkpoint'); },
			complete: async () => { events.push('summary'); return { text: 'Verified work; pending next task.' }; },
			refresh: async () => { events.push('refresh'); return { system: 'new memory', tools: [] }; },
		}, new AbortController().signal);
		assert.ok(candidate);
		assert.deepStrictEqual([events, JSON.stringify(state) === original, candidate.messages[0].content, candidate.compressions, candidate.awaitingUsage], [['checkpoint', 'summary', 'refresh'], true, 'new memory', 1, true]);
		assert.ok(candidate.messages.some(message => String(message.content).includes('same-session')));
		assert.strictEqual(shouldCompress(candidate, 1000), false);
	});
	test('summary failure, truncation and cancellation preserve exact original state', async () => {
		for (const mode of ['throw', 'empty', 'truncated', 'cancel']) {
			const state = conversation(); const original = JSON.stringify(state); const controller = new AbortController();
			await assert.rejects(compressContext(state, 's', 128000, {
				checkpoint: async () => {},
				complete: async () => { if (mode === 'throw') { throw new Error('offline'); } if (mode === 'cancel') { controller.abort(); } return { text: mode === 'empty' ? '' : 'summary', truncated: mode === 'truncated' }; },
				refresh: async () => { throw new Error('Must not refresh'); },
			}, controller.signal));
			assert.strictEqual(JSON.stringify(state), original);
		}
	});
	test('tool pairs stay together across partitions and interruption closes missing results', () => {
		const state = conversation();
		state.messages.splice(5, 0, { role: 'assistant', content: null, tool_calls: [{ id: 'tool-a', type: 'function', function: { name: 'read_file', arguments: '{}' } }] }, { role: 'tool', content: 'result', tool_call_id: 'tool-a' });
		const split = compressionPartition(state.messages, 128000)!;
		for (const part of [split.head, split.middle, split.tail]) { assert.strictEqual(part.some(message => message.tool_calls?.some(call => call.id === 'tool-a')), part.some(message => message.tool_call_id === 'tool-a')); }
		state.messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'pending', type: 'function', function: { name: 'write_file', arguments: '{}' } }] });
		closePendingTools(state.messages);
		assert.match(String(state.messages.at(-1)?.content), /interrupted/);
	});
	test('failure cooldown escalates and survives serialization', () => {
		const state = conversation(); observeUsage(state); compressionFailed(state);
		assert.strictEqual(shouldCompress(JSON.parse(JSON.stringify(state)), 128000), false);
		const first = state.retryAt!; compressionFailed(state);
		assert.ok(state.retryAt! - first >= 240000);
	});
});
