/* eslint-disable header/header */
import type { Database } from '@vscode/sqlite3';

/** Thin promise wrapper over the bundled SQLite driver; one file, WAL mode, FTS5 for recall. */
export class RuntimeDatabase {
	private constructor(private readonly db: Database) { }

	static async open(path: string): Promise<RuntimeDatabase> {
		const sqlite3 = await import('@vscode/sqlite3');
		const db = await new Promise<Database>((resolve, reject) => {
			const instance = new sqlite3.default.Database(path, error => error ? reject(error) : resolve(instance));
		});
		const database = new RuntimeDatabase(db);
		await database.exec('PRAGMA journal_mode = WAL');
		await database.exec('PRAGMA busy_timeout = 5000');
		await database.migrate();
		return database;
	}

	private async migrate(): Promise<void> {
		await this.exec(`
			CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, title TEXT NOT NULL, origin TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS session_memory (session_id TEXT PRIMARY KEY, prompt TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source_seq INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, timestamp REAL NOT NULL, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, reasoning TEXT, reasoning_content TEXT, UNIQUE(session_id, source_seq, content));
			CREATE TABLE IF NOT EXISTS turns (session_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (session_id, seq));
			CREATE TABLE IF NOT EXISTS jobs_executions (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, status TEXT NOT NULL, lateness TEXT NOT NULL, session_id TEXT, error TEXT);
			CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, bot_id TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, gateway_id TEXT NOT NULL, chat_id TEXT NOT NULL, text TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL, last_error TEXT, delivered_at INTEGER);
			CREATE TABLE IF NOT EXISTS recall_turns (session_id TEXT NOT NULL, thread_id TEXT, branch_id TEXT, seq INTEGER NOT NULL, role TEXT NOT NULL, block_type TEXT NOT NULL, text TEXT NOT NULL, ts INTEGER NOT NULL, harness TEXT NOT NULL, workdir TEXT NOT NULL, PRIMARY KEY (session_id, seq));
			CREATE VIRTUAL TABLE IF NOT EXISTS recall_fts USING fts5(text, session_id UNINDEXED, seq UNINDEXED, tokenize = 'unicode61');
			CREATE TABLE IF NOT EXISTS pairings (gateway_id TEXT NOT NULL, code TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (gateway_id, code));
		`);
	}

	exec(sql: string): Promise<void> {
		return new Promise((resolve, reject) => this.db.exec(sql, error => error ? reject(error) : resolve()));
	}

	run(sql: string, params: unknown[] = []): Promise<void> {
		return new Promise((resolve, reject) => this.db.run(sql, params, error => error ? reject(error) : resolve()));
	}

	get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
		return new Promise((resolve, reject) => this.db.get(sql, params, (error, row) => error ? reject(error) : resolve(row as T | undefined)));
	}

	all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
		return new Promise((resolve, reject) => this.db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows as T[])));
	}

	close(): Promise<void> {
		return new Promise((resolve, reject) => this.db.close(error => error ? reject(error) : resolve()));
	}
}
