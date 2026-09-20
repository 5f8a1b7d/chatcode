/* eslint-disable header/header */
import { randomUUID } from 'crypto';
import { IJobExecution, IScheduledJob } from '../../../platform/latentRuntime/common/runtimeProtocol.js';
import { JsonListStore } from '../runtimeConfig.js';
import { RuntimeDatabase } from '../runtimeDatabase.js';
import { cadenceSeconds, classifyLateness, computeNextRun, parseSchedule } from './schedule.js';

export interface ISchedulerHost {
	readonly runJob: (job: IScheduledJob, lateness: IJobExecution['lateness']) => Promise<{ sessionId: string }>;
	readonly isBotRunning: (botId: string) => boolean;
	readonly log: (message: string) => void;
	readonly onChange: () => void;
}

/** Ticker with heartbeat, catch-up on start, no overlap unless allowed, and an execution ledger (P1-FR-082, §5). */
export class JobScheduler {
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly startedAt = Date.now();
	private lastTick = Date.now();
	private readonly runningJobs = new Set<string>();

	constructor(private readonly jobs: JsonListStore<IScheduledJob>, private readonly database: RuntimeDatabase, private readonly host: ISchedulerHost) { }

	start(): void {
		this.timer = setInterval(() => void this.tick(), 30_000);
		void this.tick();
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
		}
	}

	async upsert(job: IScheduledJob): Promise<IScheduledJob> {
		const parsed = parseSchedule(job.schedule);
		const next = job.enabled ? computeNextRun(parsed, Date.now(), job.lastRunAt) : undefined;
		const stored: IScheduledJob = { ...job, nextRunAt: next };
		await this.jobs.upsert(stored);
		this.host.onChange();
		return stored;
	}

	async runNow(id: string): Promise<{ sessionId: string } | undefined> {
		const job = this.jobs.get(id);
		return job ? this.execute(job, 'onTime') : undefined;
	}

	nextRuns(): { jobId: string; name: string; at: number }[] {
		return this.jobs.list().filter(job => job.enabled && job.nextRunAt !== undefined).map(job => ({ jobId: job.id, name: job.name, at: job.nextRunAt! })).sort((a, b) => a.at - b.at).slice(0, 10);
	}

	async executions(jobId?: string): Promise<IJobExecution[]> {
		const rows = await this.database.all<{ id: string; job_id: string; started_at: number; finished_at: number | null; status: string; lateness: string; session_id: string | null; error: string | null }>(`SELECT * FROM jobs_executions${jobId ? ' WHERE job_id = ?' : ''} ORDER BY started_at DESC LIMIT 200`, jobId ? [jobId] : []);
		return rows.map(row => ({ id: row.id, jobId: row.job_id, startedAt: row.started_at, finishedAt: row.finished_at ?? undefined, status: row.status as IJobExecution['status'], lateness: row.lateness as IJobExecution['lateness'], sessionId: row.session_id ?? undefined, error: row.error ?? undefined }));
	}

	private async tick(): Promise<void> {
		const now = Date.now();
		const wasOffline = now - this.lastTick > 120_000 || now - this.startedAt < 60_000;
		this.lastTick = now;
		for (const job of this.jobs.list()) {
			if (!job.enabled) {
				continue;
			}
			let parsed;
			try {
				parsed = parseSchedule(job.schedule);
			} catch (error) {
				this.host.log(`job ${job.id}: invalid schedule (${error instanceof Error ? error.message : String(error)})`);
				continue;
			}
			const due = job.nextRunAt ?? computeNextRun(parsed, job.lastRunAt ?? now - 1, job.lastRunAt);
			if (due === undefined) {
				continue;
			}
			if (due > now) {
				if (job.nextRunAt !== due) {
					await this.jobs.upsert({ ...job, nextRunAt: due });
				}
				continue;
			}
			await this.execute(job, classifyLateness(due, now, cadenceSeconds(parsed), wasOffline));
		}
	}

	private async execute(job: IScheduledJob, lateness: IJobExecution['lateness']): Promise<{ sessionId: string } | undefined> {
		const id = randomUUID();
		const startedAt = Date.now();
		if ((this.runningJobs.has(job.id) || this.host.isBotRunning(job.botId)) && !job.allowOverlap) {
			await this.database.run('INSERT INTO jobs_executions (id, job_id, started_at, finished_at, status, lateness) VALUES (?, ?, ?, ?, ?, ?)', [id, job.id, startedAt, startedAt, 'skipped', lateness]);
			await this.advance(job, startedAt, 'skipped');
			return undefined;
		}
		this.runningJobs.add(job.id);
		await this.database.run('INSERT INTO jobs_executions (id, job_id, started_at, status, lateness) VALUES (?, ?, ?, ?, ?)', [id, job.id, startedAt, 'running', lateness]);
		try {
			const result = await this.host.runJob(job, lateness);
			await this.database.run('UPDATE jobs_executions SET finished_at = ?, status = ?, session_id = ? WHERE id = ?', [Date.now(), 'succeeded', result.sessionId, id]);
			await this.advance(job, startedAt, 'succeeded');
			return result;
		} catch (error) {
			await this.database.run('UPDATE jobs_executions SET finished_at = ?, status = ?, error = ? WHERE id = ?', [Date.now(), 'failed', error instanceof Error ? error.message : String(error), id]);
			await this.advance(job, startedAt, 'failed');
			return undefined;
		} finally {
			this.runningJobs.delete(job.id);
		}
	}

	private async advance(job: IScheduledJob, ranAt: number, status: IScheduledJob['lastStatus']): Promise<void> {
		const current = this.jobs.get(job.id);
		if (!current) { this.host.onChange(); return; }
		const parsed = parseSchedule(current.schedule);
		const next = current.enabled ? computeNextRun(parsed, Date.now(), ranAt) : undefined;
		await this.jobs.upsert({ ...current, lastRunAt: ranAt, lastStatus: status, nextRunAt: next, enabled: parsed.kind === 'at' ? false : current.enabled });
		this.host.onChange();
	}
}
