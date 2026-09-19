/* eslint-disable header/header */
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';
import { IArtifact } from '../../../platform/latentRuntime/common/runtimeProtocol.js';
import { RuntimeDatabase } from '../runtimeDatabase.js';

/** Files produced by bot runs, stored with provenance (spec 01 §3.3 artifacts). */
export class ArtifactStore {
	private readonly root: string;

	constructor(home: string, private readonly database: RuntimeDatabase) {
		this.root = join(home, 'artifacts');
	}

	async add(sessionId: string, botId: string, name: string, content: Buffer | string, mimeType: string): Promise<IArtifact> {
		const safeName = name.replace(/[^\w.-]/g, '_').slice(0, 120) || 'artifact';
		const directory = join(this.root, sessionId);
		await fs.mkdir(directory, { recursive: true });
		const id = randomUUID();
		const path = join(directory, `${id.slice(0, 8)}-${safeName}`);
		await fs.writeFile(path, content);
		const artifact: IArtifact = { id, sessionId, botId, name: safeName, path, mimeType, size: Buffer.byteLength(content), createdAt: Date.now() };
		await this.database.run('INSERT INTO artifacts (id, session_id, bot_id, name, path, mime_type, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, sessionId, botId, safeName, path, mimeType, artifact.size, artifact.createdAt]);
		return artifact;
	}

	async list(filter?: { sessionId?: string; botId?: string }): Promise<IArtifact[]> {
		const conditions: string[] = [];
		const params: unknown[] = [];
		if (filter?.sessionId) {
			conditions.push('session_id = ?');
			params.push(filter.sessionId);
		}
		if (filter?.botId) {
			conditions.push('bot_id = ?');
			params.push(filter.botId);
		}
		const rows = await this.database.all<{ id: string; session_id: string; bot_id: string; name: string; path: string; mime_type: string; size: number; created_at: number }>(`SELECT * FROM artifacts${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT 500`, params);
		return rows.map(row => ({ id: row.id, sessionId: row.session_id, botId: row.bot_id, name: row.name, path: row.path, mimeType: row.mime_type, size: row.size, createdAt: row.created_at }));
	}
}
