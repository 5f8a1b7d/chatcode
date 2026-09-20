/* eslint-disable header/header */
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { compareMemory, memoryBullets, memoryEntryKey, memoryResolutionWrites } from '../../node/memory/memoryComparison.js';

suite('Latent memory adapter comparison', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const local = { memory: '# Memory\n\n- The build uses esbuild for bundling.\n- Prefer tabs for indentation.\n', user: '# User profile\n\n- Writes in English.\n' };
	const remote = [
		{ target: 'memory' as const, content: 'Prefer tabs for indentation.', updatedAt: 1 },
		{ target: 'memory' as const, content: 'The build uses esbuild and tsc for bundling.', updatedAt: 2 },
		{ target: 'user' as const, content: 'Uses metric units.', updatedAt: 3 },
	];

	test('differences are reported per entry; similar entries are conflicts; nothing is changed', () => {
		const before = JSON.stringify(local);
		const result = compareMemory(local, remote);
		assert.deepStrictEqual({
			entries: result.map(entry => [entry.target, entry.status, entry.local, entry.remote]),
			unchanged: JSON.stringify(local) === before,
			bullets: memoryBullets(local.user),
			whitespaceInsensitiveKey: memoryEntryKey('memory', ' a  b ') === memoryEntryKey('memory', 'a b'),
			targetSpecificKey: memoryEntryKey('memory', 'a') === memoryEntryKey('user', 'a'),
		}, {
			entries: [
				['memory', 'same', 'Prefer tabs for indentation.', 'Prefer tabs for indentation.'],
				['memory', 'conflict', 'The build uses esbuild for bundling.', 'The build uses esbuild and tsc for bundling.'],
				['user', 'remoteOnly', undefined, 'Uses metric units.'],
				['user', 'localOnly', 'Writes in English.', undefined],
			],
			unchanged: true,
			bullets: ['Writes in English.'],
			whitespaceInsensitiveKey: true,
			targetSpecificKey: false,
		});
	});

	test('keeping local writes only to the adapter; taking the remote version writes only locally', () => {
		const [same, conflict, remoteOnly, localOnly] = compareMemory(local, remote);
		assert.deepStrictEqual([same, conflict, remoteOnly, localOnly].map(entry => [memoryResolutionWrites(entry, 'keepLocal'), memoryResolutionWrites(entry, 'takeRemote')]), [
			[{}, {}],
			[
				{ remote: { action: 'replace', target: 'memory', oldText: 'The build uses esbuild and tsc for bundling.', content: 'The build uses esbuild for bundling.' } },
				{ local: { action: 'replace', target: 'memory', oldText: 'The build uses esbuild for bundling.', content: 'The build uses esbuild and tsc for bundling.' } },
			],
			[
				{ remote: { action: 'remove', target: 'user', oldText: 'Uses metric units.' } },
				{ local: { action: 'add', target: 'user', content: 'Uses metric units.' } },
			],
			[
				{ remote: { action: 'add', target: 'user', content: 'Writes in English.' } },
				{ local: { action: 'remove', target: 'user', oldText: 'Writes in English.' } },
			],
		]);
	});
});
