/* eslint-disable header/header */
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { IBotConfig } from '../../../platform/latentRuntime/common/runtimeProtocol.js';
import { IRuntimeToolContext } from '../../../platform/latentRuntime/common/runtimePlugin.js';
import { BotPresets, IBotPresetRecord } from '../../node/bots/botPresets.js';
import { handoffTool, ToolRegistry } from '../../node/bots/tools.js';

class MemoryListStore<T extends { readonly id: string }> {
	constructor(private items: T[] = []) { }
	list(): readonly T[] { return this.items; }
	get(id: string): T | undefined { return this.items.find(item => item.id === id); }
	async upsert(item: T): Promise<void> { this.items = [...this.items.filter(candidate => candidate.id !== item.id), item]; }
	async remove(id: string): Promise<boolean> {
		const before = this.items.length;
		this.items = this.items.filter(item => item.id !== id);
		return this.items.length !== before;
	}
}

function bot(id: string, systemPrompt = `You are ${id}.`, handoffTargets?: string[]): IBotConfig {
	return { id, name: id.toUpperCase(), systemPrompt, execution: { kind: 'provider', modelBindingId: 'm' }, toolAuthorizationScope: { allowTools: ['handoff'], allowPaths: ['**'], allowNetwork: [], autoApprove: true }, capabilities: [], handoffTargets };
}

suite('Latent bot presets and hand-off', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a preset creates its Bot once; user edits and deletions survive re-registration until restored', async () => {
		const bots = new MemoryListStore<IBotConfig>([bot('mine')]);
		const presets = new BotPresets(new MemoryListStore<IBotPresetRecord>(), bots);
		const firstRun = await presets.register('ext', [bot('a'), bot('b'), bot('mine')]);
		await bots.upsert(bot('a', 'Edited by the user.'));
		await bots.remove('b');
		const secondRun = await presets.register('ext', [bot('a', 'Updated default.'), bot('b'), bot('c')]);
		const afterSecondRun = bots.list().map(candidate => [candidate.id, candidate.systemPrompt]);
		const foreign = await presets.register('other', [bot('a')]).then(() => 'accepted', (error: Error) => error.message);
		const restored = await presets.restore({ botIds: ['a', 'b'] });
		assert.deepStrictEqual({
			firstRun,
			secondRun,
			afterSecondRun,
			foreign,
			presets: presets.list().map(preset => [preset.owner, preset.bot.id]),
			restored,
			afterRestore: bots.list().map(candidate => [candidate.id, candidate.systemPrompt]),
		}, {
			firstRun: ['a', 'b'],
			secondRun: ['c'],
			afterSecondRun: [['mine', 'You are mine.'], ['a', 'Edited by the user.'], ['c', 'You are c.']],
			foreign: 'Bot preset a belongs to ext.',
			presets: [['ext', 'a'], ['ext', 'b'], ['ext', 'c']],
			restored: ['a', 'b'],
			afterRestore: [['mine', 'You are mine.'], ['c', 'You are c.'], ['a', 'Updated default.'], ['b', 'You are b.']],
		});
	});

	test('hand-off runs only listed targets and refuses cycles', async () => {
		const bots = new Map([bot('lead', '', ['helper']), bot('helper', '', ['lead'])].map(candidate => [candidate.id, candidate]));
		const running = new Set<string>();
		const tool = handoffTool({ get: id => bots.get(id), isRunning: id => running.has(id) });
		const context = (botId: string): IRuntimeToolContext => ({
			workingDirectory: '/tmp', botId, sessionId: `${botId}-session`, log: () => undefined,
			recall: async () => '', memoryWrite: async () => '', artifact: async () => '',
			runBot: async (target, input) => ({ sessionId: `${target}-session`, text: `${target} answered: ${input.text}` }),
		});
		running.add('lead');
		const results = [
			await tool.run({ bot: 'helper', request: 'check this' }, context('lead')),
			await tool.run({ bot: 'writer', request: 'x' }, context('lead')),
			await tool.run({ bot: 'lead', request: 'back to you' }, context('helper')),
		];
		assert.deepStrictEqual(results, [
			'Hand-off to HELPER (session helper-session):\nhelper answered: Hand-off from LEAD (session lead-session):\ncheck this',
			'Refused: LEAD may hand off only to helper.',
			'Refused: LEAD is already working on a request in this chain.',
		]);
		assert.throws(() => new ToolRegistry([tool]).register(tool), /built in/);
	});
});
