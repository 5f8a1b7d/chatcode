/* eslint-disable header/header */
import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { ArtifactStore, writtenArtifactPath } from '../../node/artifacts/artifactStore.js';
import { builtinTools } from '../../node/bots/tools.js';
import { RuntimeDatabase } from '../../node/runtimeDatabase.js';

suite('Latent runtime artifacts', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	let root: string;
	let db: RuntimeDatabase;
	let store: ArtifactStore;

	setup(async () => {
		root = await fs.mkdtemp(join(tmpdir(), 'latent-artifacts-'));
		db = await RuntimeDatabase.open(join(root, 'runtime.db'));
		store = new ArtifactStore(root, db);
	});

	teardown(async () => {
		await db.close();
		await fs.rm(root, { recursive: true, force: true });
	});

	test('write_file persists one indexed final version with its relative path and MIME type', async () => {
		const workspace = join(root, 'workspace');
		const context = {
			workingDirectory: workspace, botId: 'verification', sessionId: 'group-member-session',
			recall: async () => '', memoryWrite: async () => '', runBot: async () => ({ sessionId: '', text: '' }), log: () => undefined,
			artifact: async (name: string, content: string | Uint8Array, mimeType: string, options?: { readonly replace?: boolean }) => (await store.add('group-member-session', 'verification', name, content, mimeType, options)).path,
		};
		await builtinTools.write_file.run({ path: 'verification/foundations.lean', content: 'theorem first : True := by trivial' }, context);
		await builtinTools.write_file.run({ path: 'verification/foundations.lean', content: 'theorem final : True := by trivial' }, context);
		const artifacts = await store.list();
		assert.deepStrictEqual(artifacts.map(artifact => [artifact.sessionId, artifact.botId, artifact.name, artifact.mimeType]), [['group-member-session', 'verification', 'verification/foundations.lean', 'text/x-lean']]);
		assert.strictEqual(await fs.readFile(artifacts[0].path, 'utf8'), 'theorem final : True := by trivial');
	});

	test('artifact rows and copied bytes survive reopening the runtime database', async () => {
		const created = await store.add('bot-chat-session', 'writing', 'paper/result.pdf', Uint8Array.from([37, 80, 68, 70]), 'application/pdf');
		await db.close();
		db = await RuntimeDatabase.open(join(root, 'runtime.db'));
		store = new ArtifactStore(root, db);
		const [restored] = await store.list({ sessionId: 'bot-chat-session' });
		assert.deepStrictEqual([restored.id, restored.name, restored.mimeType, [...await fs.readFile(restored.path)]], [created.id, 'paper/result.pdf', 'application/pdf', [37, 80, 68, 70]]);
	});

	test('the shared index does not hide older artifacts after 500 entries', async () => {
		await db.run(`WITH RECURSIVE sequence(value) AS (SELECT 0 UNION ALL SELECT value + 1 FROM sequence WHERE value < 500)
			INSERT INTO artifacts (id, session_id, bot_id, name, path, mime_type, size, created_at)
			SELECT printf('artifact-%03d', value), 's', 'b', printf('result-%03d.txt', value), printf('/tmp/result-%03d.txt', value), 'text/plain', 1, value FROM sequence`);
		assert.strictEqual((await store.list()).length, 501);
	});

	test('historical write_file turns retain a recoverable artifact path even when arguments were truncated', () => {
		assert.strictEqual(writtenArtifactPath('write_file({"content":"' + 'x'.repeat(120) + '","path":"verification/foundations.lean","more":"truncated) → wrote verification/foundations.lean'), 'verification/foundations.lean');
		assert.strictEqual(writtenArtifactPath('terminal({"command":"touch result.csv"}) → exit 0'), undefined);
	});
});
