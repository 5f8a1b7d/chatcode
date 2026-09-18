/* eslint-disable header/header */
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { combineScores, formatAgentHit, recencyWeight, toFtsQuery } from '../../node/memory/recallRanking.js';

suite('Latent runtime recall ranking (P1-AS-022)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('recency decays with the half-life and 0 disables it', () => {
		const now = Date.now();
		assert.deepStrictEqual([
			recencyWeight(now, now, 30),
			Number(recencyWeight(now - 30 * 86_400_000, now, 30).toFixed(3)),
			recencyWeight(now - 365 * 86_400_000, now, 0),
		], [1, 0.5, 1]);
		assert.ok(combineScores(-5, now, now, 30) > combineScores(-5, now - 60 * 86_400_000, now, 30));
	});

	test('builds an FTS query from the free text', () => {
		assert.strictEqual(toFtsQuery('why did we switch off the streaming parser?'), '"why" OR "did" OR "we" OR "switch" OR "off" OR "the" OR "streaming" OR "parser"');
	});

	test('agent format carries provenance and the drill-down line', () => {
		const text = formatAgentHit({ sessionId: '987a1e04-0000-0000-0000-000000000000', seq: 40, timestamp: Date.UTC(2026, 8, 18), harness: 'latent-runtime', workdir: '/w', blockType: 'text', role: 'user', score: 0.5, text: 'switch off the parser', neighbors: [{ seq: 41, role: 'assistant', preview: 'done' }] });
		assert.deepStrictEqual(text.split('\n'), [
			'[2026-09-18T00:00:00.000Z] latent-runtime /w/987a1e04 text  score=0.500',
			'  → get 987a1e04-0000-0000-0000-000000000000 --from 39 --to 41 --memory local',
			'switch off the parser',
			'  ~ [assistant text seq41] done',
			'---',
		]);
	});
});
