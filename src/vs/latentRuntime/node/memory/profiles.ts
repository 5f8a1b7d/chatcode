/* eslint-disable header/header */
import { promises as fs, constants } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { dump, load } from 'js-yaml';
import { ICompressionOptions } from './contextCompression.js';
import { SkillRegistry } from '../capabilities/skills.js';
import { IBotConfig, IIndexedTurn } from '../../../platform/latentRuntime/common/runtimeProtocol.js';
import { RuntimeDatabase } from '../runtimeDatabase.js';
import { IMemoryOptions, MemoryStore } from './memoryStore.js';
import { RecallIndex } from './recallIndex.js';
import { FunesMemory } from './funes.js';

export interface IMemoryProfile {
	readonly home: string;
	readonly database: RuntimeDatabase;
	readonly memory: MemoryStore;
	readonly recall: RecallIndex;
	readonly funes: FunesMemory;
	readonly skills: SkillRegistry;
}

/** Separate files AND recall databases. A search engine never receives another profile's transcript. */
export class MemoryProfiles {
	private readonly profiles = new Map<string, Promise<IMemoryProfile>>();
	constructor(private readonly runtimeHome: string, private readonly legacy: RuntimeDatabase, private readonly log: (message: string) => void, private readonly onChange: () => void = () => {}) { }

	get(botId?: string): Promise<IMemoryProfile> {
		if (botId !== undefined && !botId.trim()) { throw new Error('A bot profile needs a non-empty id.'); }
		const key = botId ?? '';
		let profile = this.profiles.get(key);
		if (!profile) {
			profile = this.open(botId).catch(error => { this.profiles.delete(key); throw error; });
			this.profiles.set(key, profile);
		}
		return profile;
	}

	private async open(botId?: string): Promise<IMemoryProfile> {
		// A readable id plus a hash avoids traversal, long filenames and case-insensitive collisions.
		const directory = botId === undefined ? '' : `bot-${botId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64)}-${createHash('sha256').update(botId).digest('hex').slice(0, 12)}`;
		const home = botId === undefined ? join(this.runtimeHome, '..') : join(this.runtimeHome, '..', 'profiles', directory);
		await fs.mkdir(join(home, 'memories'), { recursive: true, mode: 0o700 });
		await fs.mkdir(join(home, 'skills'), { recursive: true, mode: 0o700 });
		const migrationMarker = join(home, 'memories', '.legacy-import-v1');
		if (botId === undefined && !await fs.access(migrationMarker).then(() => true, () => false)) {
			for (const file of ['MEMORY.md', 'USER.md', 'pending.json']) {
				try { await fs.copyFile(join(this.runtimeHome, '..', 'memory', file), join(home, 'memories', file), constants.COPYFILE_EXCL); }
				catch (error) { if (!['ENOENT', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) { throw error; } }
			}
			try { await fs.cp(join(this.runtimeHome, '..', 'memory', 'entries'), join(home, 'memories', 'entries'), { recursive: true, force: false }); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
			await fs.writeFile(migrationMarker, 'Imported local legacy memory; original files retained.\n', { mode: 0o600 });
		}
		if (botId === undefined) {
			try { await fs.writeFile(join(home, 'SOUL.md'), 'You are a helpful assistant.', { flag: 'wx', mode: 0o600 }); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; } }
		}
		const memory = new MemoryStore(this.runtimeHome, join(home, 'memories'), async () => (await this.readConfig(home)).memory ?? {});
		await memory.initialize();
		const database = await RuntimeDatabase.open(join(home, 'state.db'));
		try {
			await fs.chmod(join(home, 'state.db'), 0o600);
			await database.exec('CREATE TABLE IF NOT EXISTS profile_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS session_context (session_id TEXT PRIMARY KEY, data TEXT NOT NULL);');
			const recall = new RecallIndex(database);
			if (!await database.get('SELECT value FROM profile_meta WHERE key = ?', ['legacy-import-v1'])) {
				if (botId !== undefined) {
					for (const session of await this.legacy.all<{ id: string; bot_id: string; title: string; origin: string; created_at: number; updated_at: number }>('SELECT * FROM sessions WHERE bot_id = ?', [botId])) {
						await database.run('INSERT OR IGNORE INTO sessions (id, bot_id, title, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [session.id, session.bot_id, session.title, session.origin, session.created_at, session.updated_at]);
						for (const turn of await this.legacy.all<{ seq: number; role: string; text: string; ts: number }>('SELECT * FROM turns WHERE session_id = ?', [session.id])) {
							await database.run('INSERT OR IGNORE INTO turns (session_id, seq, role, text, ts) VALUES (?, ?, ?, ?, ?)', [session.id, turn.seq, turn.role, turn.text, turn.ts]);
						}
					}
				}
				const rows = await this.legacy.all<{ session_id: string; seq: number; role: string; block_type: string; text: string; ts: number; harness: string; workdir: string }>(
					`SELECT r.* FROM recall_turns r WHERE ${botId === undefined ? 'NOT EXISTS (SELECT 1 FROM sessions s WHERE r.session_id = s.id OR substr(r.session_id, 1, length(s.id) + 12) = s.id || \'#checkpoint-\')' : 'EXISTS (SELECT 1 FROM sessions s WHERE s.bot_id = ? AND (r.session_id = s.id OR substr(r.session_id, 1, length(s.id) + 12) = s.id || \'#checkpoint-\'))'}`,
					botId === undefined ? [] : [botId]);
				await recall.index(rows.map(row => ({ sessionId: row.session_id, seq: row.seq, role: row.role, blockType: row.block_type, text: row.text, timestamp: row.ts, harness: row.harness, workdir: row.workdir }) as IIndexedTurn));
				await database.run('INSERT INTO profile_meta (key, value) VALUES (?, ?)', ['legacy-import-v1', 'done']);
			}
			const funes = new FunesMemory(this.runtimeHome, database, this.log, this.onChange, join(home, 'funes'));
			await funes.initialize();
			funes.schedule();
			return { home, database, memory, recall, funes, skills: new SkillRegistry(this.runtimeHome, join(home, 'skills')) };
		} catch (error) { await database.close(); throw error; }
	}

	async soul(bot: IBotConfig): Promise<string> {
		const profile = await this.get(bot.id);
		try { await fs.writeFile(join(profile.home, 'SOUL.md'), bot.systemPrompt, { flag: 'wx', mode: 0o600 }); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; } }
		return fs.readFile(join(profile.home, 'SOUL.md'), 'utf8');
	}

	async compressionOptions(bot?: IBotConfig): Promise<ICompressionOptions> {
		const profile = await this.get(bot?.id);
		const config = await this.readConfig(profile.home);
		const options = config.compression ?? {};
		if (typeof options !== 'object' || Array.isArray(options)) { throw new Error('compression must be a YAML mapping.'); }
		const known = new Set(['enabled', 'threshold', 'threshold_tokens', 'protect_first_n', 'protect_last_n', 'min_tail_user_messages', 'max_attempts', 'target_ratio', 'tail_mode', 'model_thresholds', 'checkpoint_required', 'progress_notices', 'proactive_prune_tokens', 'proactive_prune_min_result_chars', 'proactive_prune_min_reclaim_tokens', 'micro_compact', 'micro_compact_every_n_turns', 'micro_compact_defrag_threshold_tokens', 'hygiene_hard_message_limit', 'hygiene_timeout_seconds', 'hygiene_total_ceiling_seconds', 'hygiene_failure_cooldown_seconds', 'hygiene_max_turn_hold_seconds', 'context_timeout_seconds', 'context_total_ceiling_seconds', 'abort_on_summary_failure', 'idle_compact_after_seconds', 'in_place', 'summary_model_binding_id', 'fallback_model_binding_ids']);
		const unsupported = Object.keys(options).filter(key => !known.has(key));
		if (unsupported.length) { throw new Error(`Unsupported compression settings for this provider runtime: ${unsupported.join(', ')}.`); }
		for (const key of ['enabled', 'checkpoint_required', 'progress_notices', 'micro_compact', 'abort_on_summary_failure', 'in_place'] as const) {
			if (options[key] !== undefined && typeof options[key] !== 'boolean') { throw new Error(`compression.${key} must be boolean.`); }
		}
		for (const [key, minimum] of Object.entries({ proactive_prune_tokens: 0, proactive_prune_min_result_chars: 200, proactive_prune_min_reclaim_tokens: 0, micro_compact_every_n_turns: 1, micro_compact_defrag_threshold_tokens: 1, hygiene_hard_message_limit: 1, hygiene_timeout_seconds: 1, hygiene_total_ceiling_seconds: 1, hygiene_failure_cooldown_seconds: 0, hygiene_max_turn_hold_seconds: 0, context_timeout_seconds: 1, context_total_ceiling_seconds: 1, idle_compact_after_seconds: 0 })) {
			const value = (options as Record<string, unknown>)[key];
			if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < minimum)) { throw new Error(`Invalid compression.${key}.`); }
		}
		if (options.summary_model_binding_id !== undefined && typeof options.summary_model_binding_id !== 'string' || options.fallback_model_binding_ids !== undefined && (!Array.isArray(options.fallback_model_binding_ids) || options.fallback_model_binding_ids.some(id => typeof id !== 'string' || !id))) { throw new Error('Invalid summary model-binding configuration.'); }
		if (options.threshold !== undefined && (!Number.isFinite(options.threshold) || options.threshold <= 0 || options.threshold > 1)
			|| options.threshold_tokens != null && (!Number.isFinite(options.threshold_tokens) || options.threshold_tokens < 1)
			|| options.max_attempts !== undefined && (!Number.isInteger(options.max_attempts) || options.max_attempts < 1 || options.max_attempts > 10)
			|| options.min_tail_user_messages !== undefined && (!Number.isInteger(options.min_tail_user_messages) || options.min_tail_user_messages < 1)
			|| options.target_ratio !== undefined && (!Number.isFinite(options.target_ratio) || options.target_ratio <= 0 || options.target_ratio >= 1)
			|| options.tail_mode !== undefined && options.tail_mode !== 'lean' && options.tail_mode !== 'legacy'
			|| Object.values(options.model_thresholds ?? {}).some(value => !Number.isFinite(value) || value <= 0 || value > 1)
			|| [options.protect_first_n, options.protect_last_n].some(value => value !== undefined && (!Number.isInteger(value) || value < 0))) { throw new Error('Invalid compression settings in profile config.yaml.'); }
		return options;
	}

	private async readConfig(home: string): Promise<{ compression?: ICompressionOptions; memory?: IMemoryOptions }> {
		const file = join(home, 'config.yaml');
		try { await fs.writeFile(file, dump({ compression: { enabled: true, threshold: 0.5, threshold_tokens: 256000, protect_first_n: 3, protect_last_n: 20 } }), { flag: 'wx', mode: 0o600 }); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; } }
		const config = load(await fs.readFile(file, 'utf8'));
		if (config != null && (typeof config !== 'object' || Array.isArray(config))) { throw new Error('Profile config.yaml must be a mapping.'); }
		return config ?? {};
	}

	async saveSoul(bot: IBotConfig): Promise<void> {
		const profile = await this.get(bot.id);
		const temporary = join(profile.home, 'SOUL.md.tmp');
		await fs.writeFile(temporary, bot.systemPrompt, { mode: 0o600 });
		await fs.rename(temporary, join(profile.home, 'SOUL.md'));
	}

	async skillInstructions(bot: IBotConfig, library: SkillRegistry): Promise<string> {
		const profile = await this.get(bot.id);
		const installed = new Set((await profile.skills.list()).map(skill => skill.id));
		for (const skill of await library.list()) {
			if (bot.capabilities.includes(skill.id) && !installed.has(skill.id)) { await profile.skills.install({ kind: 'path', location: skill.path }); }
		}
		return profile.skills.instructions(bot.capabilities);
	}

	/** Copy durable facts only, never another bot's sessions or pending approvals. */
	async clone(sourceId: string, targetId: string): Promise<void> {
		if (sourceId === targetId) { throw new Error('Cannot clone a profile into itself.'); }
		const source = await this.get(sourceId);
		const target = await this.get(targetId);
		const snapshot = await target.memory.snapshot();
		if (snapshot.memory.trim() || snapshot.user.trim()) { throw new Error('The target profile already has memories.'); }
		for (const name of ['MEMORY.md', 'USER.md']) { await fs.copyFile(join(source.home, 'memories', name), join(target.home, 'memories', name)); }
		await fs.cp(join(source.home, 'memories', 'entries'), join(target.home, 'memories', 'entries'), { recursive: true, force: false });
		for (const name of ['SOUL.md', 'config.yaml']) {
			try { await fs.copyFile(join(source.home, name), join(target.home, name)); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
		}
		try { await fs.cp(join(source.home, 'skills'), join(target.home, 'skills'), { recursive: true, dereference: true }); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
	}

	async dispose(): Promise<void> {
		for (const promise of this.profiles.values()) {
			const profile = await promise;
			await profile.funes.dispose();
			await profile.database.close();
		}
	}
}
