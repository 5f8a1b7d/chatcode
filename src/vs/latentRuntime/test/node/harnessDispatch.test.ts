/* eslint-disable header/header */
import * as assert from 'assert';
import { HarnessDispatch } from '../../node/bots/harnessDispatch.js';
import { IBotConfig } from '../../../platform/latentRuntime/common/runtimeProtocol.js';

const bot: IBotConfig = { id: 'a', name: 'A', systemPrompt: '', execution: { kind: 'harness', harness: 'codex' }, capabilities: [], toolAuthorizationScope: { allowTools: [], allowPaths: [], allowNetwork: [], autoApprove: false } };
suite('External harness dispatch', () => {
	test('fails without a client, claims once, never invokes a fallback', async () => {
		const dispatch = new HarnessDispatch();
		await assert.rejects(dispatch.run(bot, { text: 'hello' }, 'workbench'), /No Codex client/);
		dispatch.poll();
		const pending = dispatch.run(bot, { text: 'hello', requestId: 'r' }, 'scheduler');
		assert.strictEqual(dispatch.finish('r', { sessionId: 's', text: '' }), false);
		assert.strictEqual(dispatch.poll().runs[0].requestId, 'r');
		assert.deepStrictEqual(dispatch.poll().runs, []);
		dispatch.finish('r', { sessionId: 's', text: 'done' });
		assert.deepStrictEqual(await pending, { sessionId: 's', text: 'done' });
		dispatch.dispose();
	});
	test('cancellation rejects the waiter and ignores late completion', async () => {
		const dispatch = new HarnessDispatch(); dispatch.poll();
		const pending = dispatch.run(bot, { text: 'hello', requestId: 'r' }, 'workbench');
		dispatch.poll(); dispatch.cancel('r');
		await assert.rejects(pending, /cancelled/);
		assert.deepStrictEqual(dispatch.poll().cancelled, ['r']);
		assert.strictEqual(dispatch.finish('r', { sessionId: 's', text: 'late' }), false);
		dispatch.dispose();
	});
});
