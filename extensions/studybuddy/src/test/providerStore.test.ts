import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ProviderStore, ProviderStoragePort } from '../providers/store';
import type { CatalogProvider, ProviderCatalog, TokenPlan } from '../providers/catalog';

function createStorage() {
	const state = new Map<string, object>();
	const secrets = new Map<string, string>();
	const port: ProviderStoragePort = {
		globalState: {
			get<T>(key: string): T | undefined { return state.get(key) as T | undefined; },
			async update(key: string, value: object): Promise<void> { state.set(key, structuredClone(value)); },
		},
		secrets: {
			async get(key: string): Promise<string | undefined> { return secrets.get(key); },
			async store(key: string, value: string): Promise<void> { secrets.set(key, value); },
			async delete(key: string): Promise<void> { secrets.delete(key); },
		},
	};
	return { port, state, secrets };
}

const provider: CatalogProvider = {
	id: 'minimax', service: 'llm', category: 'llm', name: 'MiniMax', type: 'anthropic',
	defaultBaseUrl: 'https://api.minimaxi.com/anthropic/v1', requiresApiKey: true,
};

const plan: TokenPlan = {
	id: 'minimax', name: 'MiniMax', category: 'token_plan',
	modalities: {
		llm: { providerId: 'minimax', baseUrl: 'https://api.minimaxi.com/anthropic/v1', apiFormat: 'anthropic' },
		image: { providerId: 'minimax-image', baseUrl: 'https://api.minimaxi.com' },
	},
};

const catalog: ProviderCatalog = {
	schemaVersion: 1,
	categories: [{ id: 'llm', label: 'LLM', order: 0 }, { id: 'image', label: 'Image', order: 1 }],
	providerGroups: [],
	providers: [provider, { id: 'minimax-image', service: 'image', category: 'image', name: 'MiniMax Image', requiresApiKey: true }],
	tokenPlans: [plan],
};

describe('provider configuration storage', () => {
	test('keeps credentials out of saved settings and disables a provider when its key is deleted', async () => {
		const storage = createStorage();
		const store = new ProviderStore(storage.port);
		await assert.rejects(store.saveProvider(provider, { enabled: true }), /credential/);
		await store.saveProvider(provider, { enabled: true, baseUrl: provider.defaultBaseUrl, modelId: 'MiniMax-M3', fields: { apiKey: 'leak', language: 'en' } }, 'sk-example');
		assert.deepStrictEqual(store.getProvider('llm', 'minimax'), { enabled: true, baseUrl: provider.defaultBaseUrl, modelId: 'MiniMax-M3', fields: { language: 'en' } });
		assert.equal(JSON.stringify([...storage.state.values()]).includes('sk-example'), false);
		assert.equal(await store.getSecret('llm:minimax'), 'sk-example');
		await store.deleteProviderSecret('llm', 'minimax');
		assert.equal(store.getProvider('llm', 'minimax').enabled, false);
		assert.equal(await store.getSecret('llm:minimax'), undefined);
	});

	test('token plans share a separate credential without replacing direct provider settings', async () => {
		const storage = createStorage();
		const store = new ProviderStore(storage.port);
		await store.saveProvider(provider, { enabled: true, modelId: 'direct-model' }, 'direct-key');
		await store.enablePlan(plan, 'plan-key');
		assert.deepStrictEqual(store.listActiveBindings(catalog).map(binding => [binding.source, binding.service, binding.baseUrl, binding.secretRef]), [
			['direct', 'llm', 'https://api.minimaxi.com/anthropic/v1', 'llm:minimax'],
			['plan', 'llm', 'https://api.minimaxi.com/anthropic/v1', 'plan:minimax'],
			['plan', 'image', 'https://api.minimaxi.com', 'plan:minimax'],
		]);
		assert.deepStrictEqual({ direct: store.getProvider('llm', 'minimax').modelId, plan: store.getPlan(plan.id), directKey: await store.getSecret('llm:minimax'), planKey: await store.getSecret('plan:minimax') }, {
			direct: 'direct-model', plan: true, directKey: 'direct-key', planKey: 'plan-key',
		});
		await store.disablePlan(plan);
		assert.deepStrictEqual({ direct: store.getProvider('llm', 'minimax').modelId, plan: store.getPlan(plan.id), planKey: await store.getSecret('plan:minimax') }, {
			direct: 'direct-model', plan: false, planKey: 'plan-key',
		});
	});

	test('stores provider-specific credential fields only in SecretStorage', async () => {
		const storage = createStorage();
		const store = new ProviderStore(storage.port);
		const pdf: CatalogProvider = { id: 'alidocmind', service: 'pdf', category: 'pdf', name: 'AliDocMind', requiresApiKey: true, secretFields: [{ id: 'accessKeyId', label: 'Access Key ID' }] };
		await assert.rejects(store.saveProvider(pdf, { enabled: true }, 'access-secret'), /Access Key ID/);
		await store.saveProvider(pdf, { enabled: true, fields: { accessKeyId: 'must-not-save', source_webSearch: 'true' } }, 'access-secret', { accessKeyId: 'access-id' });
		assert.equal(JSON.stringify([...storage.state.values()]).includes('access-id'), false);
		assert.equal(JSON.stringify([...storage.state.values()]).includes('must-not-save'), false);
		assert.equal(await store.getSecret('pdf:alidocmind.accessKeyId'), 'access-id');
		assert.equal((await store.snapshot({ ...catalog, providers: [pdf] })).hasSecrets['pdf:alidocmind.accessKeyId'], true);
		await store.deleteProviderSecret('pdf', 'alidocmind', pdf);
		assert.equal(await store.getSecret('pdf:alidocmind.accessKeyId'), undefined);
		assert.equal(store.getProvider('pdf', 'alidocmind').enabled, false);
	});
});
