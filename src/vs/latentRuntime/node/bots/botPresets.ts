/* eslint-disable header/header */
import { IBotConfig, IBotPreset } from '../../../platform/latentRuntime/common/runtimeProtocol.js';

/** A stored preset; a record exists once its Bot has been created, so it is never created again. */
export interface IBotPresetRecord extends IBotPreset {
	/** Id of the preset's Bot. */
	readonly id: string;
}

interface IListStore<T extends { readonly id: string }> {
	list(): readonly T[];
	get(id: string): T | undefined;
	upsert(item: T): Promise<void>;
	remove(id: string): Promise<boolean>;
}

export function isBotPresetRecord(value: unknown, isBot: (candidate: unknown) => candidate is IBotConfig): value is IBotPresetRecord {
	const candidate = value as Partial<IBotPresetRecord>;
	return typeof candidate === 'object' && candidate !== null && typeof candidate.id === 'string' && typeof candidate.owner === 'string' && isBot(candidate.bot) && candidate.bot.id === candidate.id;
}

/**
 * Default Bots contributed by extensions. Each preset creates its Bot once; after
 * that the Bot belongs to the user, and later edits or deletions are kept until
 * the user restores the preset.
 */
export class BotPresets {
	constructor(private readonly presets: IListStore<IBotPresetRecord>, private readonly bots: IListStore<IBotConfig>) { }

	/**
	 * Replaces the presets of `owner`. Bots of presets seen for the first time are
	 * created unless a Bot with that id exists; existing Bots are never changed.
	 * Returns the ids of the Bots created.
	 */
	async register(owner: string, bots: readonly IBotConfig[]): Promise<string[]> {
		const taken = bots.find(bot => {
			const record = this.presets.get(bot.id);
			return record && record.owner !== owner;
		});
		if (taken) {
			throw new Error(`Bot preset ${taken.id} belongs to ${this.presets.get(taken.id)!.owner}.`);
		}
		const created: string[] = [];
		for (const bot of bots) {
			if (!this.presets.get(bot.id) && !this.bots.get(bot.id)) {
				await this.bots.upsert(bot);
				created.push(bot.id);
			}
			await this.presets.upsert({ id: bot.id, owner, bot });
		}
		for (const record of this.presets.list().filter(candidate => candidate.owner === owner && !bots.some(bot => bot.id === candidate.id))) {
			await this.presets.remove(record.id);
		}
		return created;
	}

	list(): IBotPreset[] {
		return this.presets.list().map(record => ({ owner: record.owner, bot: record.bot }));
	}

	/** Resets the matching Bots to their presets, recreating deleted ones. Returns the ids restored. */
	async restore(filter: { readonly owner?: string; readonly botIds?: readonly string[] } = {}): Promise<string[]> {
		const restored: string[] = [];
		for (const record of this.presets.list()) {
			if ((filter.owner === undefined || record.owner === filter.owner) && (filter.botIds === undefined || filter.botIds.includes(record.id))) {
				await this.bots.upsert(record.bot);
				restored.push(record.id);
			}
		}
		return restored;
	}
}
