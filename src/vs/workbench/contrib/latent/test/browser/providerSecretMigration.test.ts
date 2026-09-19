/* eslint-disable header/header */
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { legacySecretRefs, secretStorageKey } from '../../browser/migration/providerSecretMigration.js';

suite('Latent provider secret migration (P2-AS-014)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('derives every secret ref from the legacy state', () => {
		const refs = legacySecretRefs({
			version: 1,
			providers: { 'llm:openai': { enabled: true }, 'asr:deepgram': { enabled: false } },
			plans: { x: true },
			customProviders: [{ id: 'custom-1', service: 'llm', secretFields: [{ id: 'region' }] }],
		}, { 'asr:deepgram': ['projectId'] });
		assert.deepStrictEqual(refs.sort(), ['asr:deepgram', 'asr:deepgram.projectId', 'llm:custom-1', 'llm:custom-1.region', 'llm:openai', 'plan:x']);
	});

	test('secret keys are scoped by extension identifier', () => {
		assert.strictEqual(secretStorageKey('latentnote.latent-provider', 'customProviders.secret.v1.llm:openai'), '{"extensionId":"latentnote.latent-provider","key":"customProviders.secret.v1.llm:openai"}');
	});
});
