/* eslint-disable header/header */
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { RuntimeDatabase } from '../runtimeDatabase.js';
import { homedir } from 'os';
import { join } from 'path';
import { IFunesState } from '../../../platform/latentRuntime/common/runtimeProtocol.js';

/** Uses the actual Funes pipeline, with an isolated local index and its supported Hermes SQLite reader. */
export class FunesMemory {
	private executable = process.env['LATENT_FUNES_PATH'] || 'funes';
	private version: string | undefined;
	private lastError: string | undefined;
	private pending: Promise<void> = Promise.resolve();
	private dirty = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private indexedAt: number | undefined;
	private readonly home: string;

	constructor(runtimeHome: string, private readonly database: RuntimeDatabase, private readonly log: (message: string) => void, private readonly onChange: () => void = () => {}) { this.home = join(runtimeHome, '..', 'memory', 'funes'); }

	async initialize(): Promise<void> {
		await fs.mkdir(this.home, { recursive: true });
		for (const candidate of [...new Set([this.executable, join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'funes.exe' : 'funes')])]) {
			try { this.executable = candidate; this.version = (await this.run(['--version'], 5000)).trim(); this.lastError = undefined; return; }
			catch (error) { this.lastError = error instanceof Error ? error.message : String(error); }
		}
		this.lastError = 'Funes is not installed. Install it on this runtime host or set LATENT_FUNES_PATH; local keyword recall remains available.';
	}

	state(): IFunesState { return { available: !!this.version, version: this.version, indexedAt: this.indexedAt, lastError: this.lastError }; }

	private run(args: string[], timeout = 60_000): Promise<string> {
		return new Promise((resolve, reject) => execFile(this.executable, args, { env: { ...process.env, FUNES_HOME: this.home }, timeout, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => error ? reject(new Error(`${error.message}\n${stderr.slice(-1500)}`)) : resolve(stdout)));
	}

	/** Index after turns settle, coalescing arrivals while an index pass is running. No remote publishing. */
	schedule(): void {
		if (!this.version) { return; }
		this.dirty = true;
		if (this.timer) { clearTimeout(this.timer); }
		this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 2000);
	}

	async flush(): Promise<void> {
		if (!this.version || !this.dirty) { return this.pending; }
		this.dirty = false;
		this.pending = this.pending.then(async () => {
			try {
				// Funes 1.3.x requires this basename. VACUUM includes committed WAL data.
				const source = join(this.home, 'source');
				await fs.mkdir(source, { recursive: true });
				const temporary = join(source, `snapshot-${Date.now()}.db`);
				try {
					await this.database.run('VACUUM INTO ?', [temporary]);
					await fs.rename(temporary, join(source, 'state.db'));
				} finally { await fs.rm(temporary, { force: true }); }
				await this.run(['index', join(source, 'state.db'), '--harness', 'hermes', '--yes'], 180_000);
				this.indexedAt = Date.now(); this.lastError = undefined;
			} catch (error) {
				this.lastError = error instanceof Error ? error.message : String(error);
				this.log(`Funes indexing failed: ${this.lastError}`);
			} finally { this.onChange(); }
		});
		return this.pending;
	}

	async recall(query: string, excludeSessionId?: string): Promise<string | undefined> {
		if (!this.version || !this.indexedAt) { return undefined; }
		try {
			const result = await this.run(['recall', '-k', excludeSessionId ? '30' : '8', '--memory', 'local', '--', query]);
			this.lastError = undefined;
			return result.split(/\n---\n/).filter(block => !excludeSessionId || !block.split('\n').slice(0, 3).some(line => line.includes(`→ get ${excludeSessionId} --from `) || line.includes(`→ get ${excludeSessionId}#checkpoint-`))).slice(0, 8).join('\n---\n').slice(0, 40_000);
		} catch (error) { this.lastError = error instanceof Error ? error.message : String(error); return undefined; }
	}

	async get(sessionId: string, from: number, to: number): Promise<string | undefined> {
		if (!this.version || !this.indexedAt) { return undefined; }
		try { return (await this.run(['get', sessionId, '--from', String(from), '--to', String(to), '--memory', 'local'])).slice(0, 40_000); }
		catch { return undefined; }
	}

	dispose(): void { if (this.timer) { clearTimeout(this.timer); } }
}
