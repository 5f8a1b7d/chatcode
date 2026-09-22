/* eslint-disable header/header */
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { basename, join } from 'path';
import { IArtifact } from '../../../platform/latentRuntime/common/runtimeProtocol.js';
import { RuntimeDatabase } from '../runtimeDatabase.js';

/** Files produced by bot runs, stored with provenance (spec 01 §3.3 artifacts). */
export class ArtifactStore {
	private readonly root: string;

	constructor(home: string, private readonly database: RuntimeDatabase) {
		this.root = join(home, 'artifacts');
	}

	async add(sessionId: string, botId: string, name: string, content: string | Uint8Array, mimeType: string, options?: { readonly replace?: boolean }): Promise<IArtifact> {
		const displayName = artifactName(name);
		if (options?.replace) {
			const existing = await this.database.get<{ id: string; path: string }>('SELECT id, path FROM artifacts WHERE session_id = ? AND bot_id = ? AND name = ? ORDER BY created_at DESC LIMIT 1', [sessionId, botId, displayName]);
			if (existing) {
				await fs.writeFile(existing.path, content);
				const createdAt = Date.now();
				const size = Buffer.byteLength(content);
				await this.database.run('UPDATE artifacts SET mime_type = ?, size = ?, created_at = ? WHERE id = ?', [mimeType, size, createdAt, existing.id]);
				return { id: existing.id, sessionId, botId, name: displayName, path: existing.path, mimeType, size, createdAt };
			}
		}
		const safeName = basename(displayName).replace(/[^\w.-]/g, '_').slice(0, 120) || 'artifact';
		const directory = join(this.root, sessionId);
		await fs.mkdir(directory, { recursive: true });
		const id = randomUUID();
		const path = join(directory, `${id.slice(0, 8)}-${safeName}`);
		await fs.writeFile(path, content);
		const artifact: IArtifact = { id, sessionId, botId, name: displayName, path, mimeType, size: Buffer.byteLength(content), createdAt: Date.now() };
		await this.database.run('INSERT INTO artifacts (id, session_id, bot_id, name, path, mime_type, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, sessionId, botId, displayName, path, mimeType, artifact.size, artifact.createdAt]);
		return artifact;
	}

	async remove(id: string): Promise<void> {
		const artifact = await this.database.get<{ path: string }>('SELECT path FROM artifacts WHERE id = ?', [id]);
		if (!artifact) { return; }
		await fs.rm(artifact.path, { force: true });
		await this.database.run('DELETE FROM artifacts WHERE id = ?', [id]);
	}

	async has(sessionId: string, botId: string, name: string): Promise<boolean> {
		return !!await this.database.get('SELECT 1 FROM artifacts WHERE session_id = ? AND bot_id = ? AND name = ? LIMIT 1', [sessionId, botId, artifactName(name)]);
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
		const rows = await this.database.all<{ id: string; session_id: string; bot_id: string; name: string; path: string; mime_type: string; size: number; created_at: number }>(`SELECT * FROM artifacts${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY created_at DESC`, params);
		return rows.map(row => ({ id: row.id, sessionId: row.session_id, botId: row.bot_id, name: row.name, path: row.path, mimeType: row.mime_type, size: row.size, createdAt: row.created_at }));
	}
}

function artifactName(name: string): string {
	return name.replace(/\\/g, '/').replace(/[\u0000-\u001f\u007f]/g, '_').replace(/^\/+/, '').slice(-240) || 'artifact';
}

/** Recovers the path from the bounded tool-call summary stored in historical session turns. */
export function writtenArtifactPath(turn: string): string | undefined {
	const args = /^write_file\((.{0,220})\) →/.exec(turn)?.[1];
	const encoded = args && /"path"\s*:\s*("(?:\\.|[^"\\])*")/.exec(args)?.[1];
	if (!encoded) { return undefined; }
	try {
		const value = JSON.parse(encoded);
		return typeof value === 'string' && value ? value : undefined;
	} catch {
		return undefined;
	}
}
