/* eslint-disable header/header */
import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { runtimeSessionHistory } from '../../browser/runtime/runtimeSessionHistory.js';
import { sessionsSearchSources } from '../../common/sessionsSearch.js';

suite('Latent runtime session projection', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps user, tool and assistant content in sequence without modifying the source', () => {
		const turns = [
			{ seq: 3, role: 'assistant' as const, text: 'Answer', timestamp: 30 },
			{ seq: 1, role: 'user' as const, text: 'Question', timestamp: 10 },
			{ seq: 2, role: 'tool' as const, text: 'Tool result', timestamp: 20 },
		];
		const history = runtimeSessionHistory(turns);
		assert.strictEqual(history.length, 2);
		assert.deepStrictEqual(history[0], { type: 'request', id: '1', prompt: 'Question', participant: '', timestamp: 10 });
		assert.strictEqual(history[1].type, 'response');
		assert.strictEqual(history[1].parts.length, 2);
		assert.deepStrictEqual(turns.map(turn => turn.seq), [3, 1, 2]);
	});

	test('forwards registered source changes and stops forwarding after disposal', async () => {
		const changed = disposables.add(new Emitter<void>());
		const registration = sessionsSearchSources.register({ id: 'runtime-projection-test', onDidChange: changed.event, search: async () => [] });
		let notifications = 0;
		disposables.add(sessionsSearchSources.onDidChange(() => notifications++));
		changed.fire();
		assert.strictEqual(notifications, 1);
		assert.deepStrictEqual(await sessionsSearchSources.all().find(source => source.id === 'runtime-projection-test')!.search('', CancellationToken.None), []);
		registration.dispose();
		changed.fire();
		assert.strictEqual(notifications, 2, 'only removal itself emits after disposal');
	});
});
