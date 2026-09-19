import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CapabilityUnavailableError } from '../api';
import { chooseBinding, computeBindings } from '../capabilities/bindings';
import type { ProviderCatalog } from '../catalog/catalog';
import type { ActiveProviderBinding } from '../store/store';

const catalog: ProviderCatalog = {
	schemaVersion: 1,
	categories: [],
	providerGroups: [],
	providers: [
		{ id: 'a', service: 'llm', category: 'llm', name: 'Provider A', type: 'openai', requiresApiKey: true, models: [{ id: 'a-text', name: 'A Text', capabilities: { tools: true } }, { id: 'a-vision', name: 'A Vision', capabilities: { vision: true } }] },
		{ id: 'a', service: 'asr', category: 'asr', name: 'Provider A ASR', type: 'openai', requiresApiKey: true, supportedLanguages: ['en', 'zh'] },
		{ id: 'b', service: 'tts', category: 'tts', name: 'Provider B', type: 'openai', requiresApiKey: false },
		{ id: 'b', service: 'realtime', category: 'realtime', name: 'Provider B Realtime', type: 'openai-realtime', requiresApiKey: true },
	],
	tokenPlans: [],
};

const active: ActiveProviderBinding[] = [
	{ service: 'llm', providerId: 'a', source: 'direct', sourceId: 'a', baseUrl: 'https://a.example/v1', secretRef: 'llm:a', modelIds: ['a-text', 'a-vision'], protocol: 'openai' },
	{ service: 'asr', providerId: 'a', source: 'direct', sourceId: 'a', baseUrl: 'https://a.example/v1', secretRef: 'asr:a', modelIds: ['whisper'], protocol: 'openai' },
	{ service: 'tts', providerId: 'b', source: 'direct', sourceId: 'b', baseUrl: 'https://b.example/v1', secretRef: 'tts:b', modelIds: ['voice-1'], protocol: 'openai' },
	{ service: 'realtime', providerId: 'b', source: 'direct', sourceId: 'b', baseUrl: 'wss://b.example/v1', secretRef: 'realtime:b', modelIds: ['rt-1'], protocol: 'openai-realtime' },
];

describe('capability matrix (P2-AS-007, P2-AS-008)', () => {
	test('maps services to capabilities and marks defaults', () => {
		const matrix = computeBindings({ catalog, active, hasSecret: () => true, defaults: { text: { providerId: 'a', modelId: 'a-text', source: 'direct', sourceId: 'a' } } });
		assert.deepStrictEqual(Object.fromEntries([...matrix].map(([capability, list]) => [capability, list.map(binding => `${binding.providerId}/${binding.modelId}${binding.isDefault ? '*' : ''}`)])), {
			text: ['a/a-text*', 'a/a-vision'],
			imageUnderstanding: ['a/a-vision'],
			asr: ['a/whisper'],
			tts: ['b/voice-1'],
			realtimeVoice: ['b/rt-1'],
		});
	});

	test('prefers the default, then the named provider', () => {
		const matrix = computeBindings({ catalog, active, hasSecret: () => true, defaults: { text: { providerId: 'a', modelId: 'a-vision', source: 'direct', sourceId: 'a' } } });
		const text = matrix.get('text')!;
		assert.strictEqual(chooseBinding({ capability: 'text' }, text, () => true, true).modelId, 'a-vision');
		assert.strictEqual(chooseBinding({ capability: 'text', preferredProviderId: 'a', preferredModelId: 'a-text' }, text, () => true, true).modelId, 'a-text');
		assert.strictEqual(chooseBinding({ capability: 'text', requires: { tools: true } }, text, () => true, true).modelId, 'a-text');
	});

	test('explains why a capability is unavailable', () => {
		const matrix = computeBindings({ catalog, active, hasSecret: () => false, defaults: {} });
		const reasons: string[] = [];
		for (const request of [
			{ capability: 'asr' as const, secret: false, enabled: true },
			{ capability: 'tts' as const, secret: true, enabled: false },
			{ capability: 'realtimeVoice' as const, secret: true, enabled: true, bindings: [] },
			{ capability: 'asr' as const, secret: true, enabled: true, requires: { languages: ['ja'] } },
		]) {
			try {
				chooseBinding({ capability: request.capability, requires: request.requires }, request.bindings ?? matrix.get(request.capability) ?? [], () => request.secret, request.enabled);
				reasons.push('ok');
			} catch (error) {
				reasons.push(error instanceof CapabilityUnavailableError ? `${error.capability}:${error.reason}` : 'other');
			}
		}
		assert.deepStrictEqual(reasons, ['asr:missingCredential', 'tts:disabled', 'realtimeVoice:noProvider', 'asr:unsupportedRequirement']);
	});
});
