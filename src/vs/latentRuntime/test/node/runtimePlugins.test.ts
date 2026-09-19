/* eslint-disable header/header */
import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { IRuntimePluginRecord } from '../../../platform/latentRuntime/common/runtimePlugin.js';
import { ToolRegistry, wireToolName } from '../../node/bots/tools.js';
import { pluginSecretKey, RuntimePluginHost } from '../../node/plugins/runtimePlugins.js';

suite('Latent runtime plugins (latent.gatewayPlatforms, latent.botTools, latent.memoryAdapters)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function host(records: IRuntimePluginRecord[], secrets: Record<string, string> = {}) {
		const tools = new ToolRegistry();
		const platforms = new Set<string>();
		const adapters = new Set<string>();
		const events: string[] = [];
		const store = {
			list: () => records,
			upsert: async (record: IRuntimePluginRecord) => { records.splice(0, records.length, ...records.filter(candidate => candidate.id !== record.id), record); },
		};
		const pluginHost = new RuntimePluginHost(store, {
			gateways: { registerPlatform: platform => { platforms.add(platform); }, unregisterPlatform: async platform => { platforms.delete(platform); } },
			tools,
			memoryAdapters: { register: adapter => { adapters.add(adapter.id); }, unregister: id => { adapters.delete(id); } },
			secret: key => secrets[key],
			modelBinding: () => undefined,
			runBot: async () => ({ sessionId: 's', text: '' }),
			deliver: async () => undefined,
			log: message => events.push(message),
			onDidChangeContributions: async () => { events.push('applied'); },
		});
		return { pluginHost, tools, platforms, adapters, events };
	}

	async function pluginFile(source: string): Promise<string> {
		const directory = await fs.mkdtemp(join(tmpdir(), 'latent-plugin-'));
		const file = join(directory, 'plugin.mjs');
		await fs.writeFile(file, source, 'utf8');
		return file;
	}

	test('a plugin contributes platforms, tools, and adapters; re-registering replaces them', async () => {
		const modulePath = await pluginFile(`export function activate(host) {
			host.registerGatewayPlatform('chat', () => { throw new Error('unused'); });
			host.registerBotTool({ definition: { name: 'papers.search', description: 'd', parameters: {} }, run: async () => host.secret('key') ?? 'none' });
			host.registerMemoryAdapter({ id: 'backup', displayName: 'Backup', mirror: async () => undefined });
		}`);
		const { pluginHost, tools, platforms, adapters } = host([], { [pluginSecretKey('p', 'key')]: 'scoped', key: 'global' });
		const state = await pluginHost.register({ id: 'p', modulePath, enabled: true });
		const tool = tools.byWireName(wireToolName('papers.search'));
		const secret = await tool?.run({}, undefined!);
		await pluginHost.register({ id: 'p', modulePath, enabled: false });
		assert.deepStrictEqual({
			state: [state.active, state.contributions],
			wireName: wireToolName('papers.search'),
			secret,
			afterDisable: [[...platforms], tools.byWireName('papers_search'), [...adapters]],
		}, {
			state: [true, { gatewayPlatforms: ['chat'], tools: ['papers.search'], memoryAdapters: ['backup'] }],
			wireName: 'papers_search',
			secret: 'scoped',
			afterDisable: [[], undefined, []],
		});
	});

	test('a failing plugin is reported and contributes nothing', async () => {
		const modulePath = await pluginFile(`export function activate(host) {
			host.registerGatewayPlatform('half', () => undefined);
			throw new Error('boom');
		}`);
		const { pluginHost, platforms } = host([{ id: 'bad', modulePath, enabled: true }]);
		await pluginHost.activateAll();
		const [state] = pluginHost.list();
		assert.deepStrictEqual([state.active, state.lastError, [...platforms]], [false, 'boom', []]);
	});

	test('built-in tools cannot be replaced', () => {
		assert.throws(() => new ToolRegistry().register({ definition: { name: 'write_file', description: '', parameters: {} }, run: async () => '' }), /built in/);
	});
});
