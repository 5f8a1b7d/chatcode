/* eslint-disable header/header */
import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DeferredPromise } from '../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { IScheduledJob } from '../../../platform/latentRuntime/common/runtimeProtocol.js';
import { JobScheduler } from '../../node/jobs/scheduler.js';
import { JsonListStore } from '../../node/runtimeConfig.js';
import { RuntimeDatabase } from '../../node/runtimeDatabase.js';
import { RecallIndex } from '../../node/memory/recallIndex.js';
import { combineScores } from '../../node/memory/recallRanking.js';

suite('Latent runtime lifecycle regression', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	let root: string;
	let db: RuntimeDatabase;
	setup(async () => { root = await fs.mkdtemp(join(tmpdir(), 'latent-lifecycle-')); db = await RuntimeDatabase.open(join(root, 'runtime.db')); });
	teardown(async () => { await db.close(); await fs.rm(root, { recursive: true, force: true }); });

	test('deleting a running job does not resurrect it and its output remains in the execution ledger', async () => {
		const jobs = new JsonListStore<IScheduledJob>(root, 'jobs', (item): item is IScheduledJob => !!item, () => undefined);
		const started = new DeferredPromise<void>();
		const result = new DeferredPromise<{ sessionId: string }>();
		const scheduler = new JobScheduler(jobs, db, { runJob: async () => { started.complete(); return result.p; }, isBotRunning: () => false, log: () => undefined, onChange: () => undefined });
		await scheduler.upsert({ id: 'j', name: 'Test', botId: 'b', prompt: 'Test', schedule: 'every 1h', enabled: true });
		const running = scheduler.runNow('j');
		await started.p;
		await jobs.remove('j');
		await result.complete({ sessionId: 'output' });
		await running;
		assert.deepStrictEqual([jobs.list(), (await scheduler.executions('j')).map(run => [run.status, run.sessionId])], [[], [['succeeded', 'output']]]);
	});

	test('editing or pausing a running job survives completion', async () => {
		const jobs = new JsonListStore<IScheduledJob>(root, 'jobs', (item): item is IScheduledJob => !!item, () => undefined);
		const started = new DeferredPromise<void>();
		const result = new DeferredPromise<{ sessionId: string }>();
		const scheduler = new JobScheduler(jobs, db, { runJob: async () => { started.complete(); return result.p; }, isBotRunning: () => false, log: () => undefined, onChange: () => undefined });
		const job = { id: 'j', name: 'Test', botId: 'b', prompt: 'Test', schedule: 'every 1h', enabled: true };
		await scheduler.upsert(job);
		const running = scheduler.runNow('j');
		await started.p;
		await scheduler.upsert({ ...job, name: 'Edited', enabled: false });
		await result.complete({ sessionId: 'output' });
		await running;
		assert.deepStrictEqual([jobs.get('j')?.name, jobs.get('j')?.enabled, jobs.get('j')?.nextRunAt], ['Edited', false, undefined]);
	});

	test('rebuilding preserves workbench history and includes committed WAL data in the Funes snapshot', async () => {
		const index = new RecallIndex(db);
		await index.index([{ sessionId: 'ordinary', seq: 0, role: 'user', blockType: 'text', text: 'persistent decision', timestamp: Date.now(), harness: 'workbench', workdir: root }]);
		await index.rebuild(async () => []);
		const path = join(root, 'state.db');
		await db.run('VACUUM INTO ?', [path]);
		const snapshot = await RuntimeDatabase.open(path);
		try {
			assert.deepStrictEqual([(await index.recall('persistent decision')).length, (await snapshot.get<{ count: number }>('SELECT COUNT(*) AS count FROM messages'))?.count], [1, 1]);
		} finally { await snapshot.close(); }
	});

	test('recall excludes the current session; Funes mirror is stable and retains edits as new turns', async () => {
		const index = new RecallIndex(db);
		const turn = { sessionId: 's', seq: 0, role: 'user' as const, blockType: 'text' as const, text: 'streaming parser', timestamp: Date.now(), harness: 'workbench', workdir: root };
		await index.index([turn, { ...turn, sessionId: 'other', text: 'streaming parser evidence' }]);
		await index.index([turn]);
		await index.index([{ ...turn, text: 'streaming parser revised' }]);
		const hits = await index.recall('streaming parser', { excludeSessionId: 's' });
		const mirror = await db.all<{ content: string }>('SELECT content FROM messages WHERE session_id = ? ORDER BY id', ['s']);
		assert.deepStrictEqual([hits.map(hit => hit.sessionId), mirror.map(row => row.content), combineScores(-5, 0, 0, 0) > combineScores(-1, 0, 0, 0)], [['other'], ['streaming parser', 'streaming parser revised'], true]);
	});
});
