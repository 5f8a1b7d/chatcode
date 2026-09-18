/* eslint-disable header/header */
import { promises as fs } from 'fs';
import { join } from 'path';

/** JSON list store with a validator; invalid entries are dropped and reported, never crash the runtime. */
export class JsonListStore<T extends { readonly id: string }> {
	private items: T[] = [];
	private readonly file: string;

	constructor(home: string, name: string, private readonly validate: (value: unknown) => value is T, private readonly onInvalid: (reason: string) => void) {
		this.file = join(home, `${name}.json`);
	}

	async load(): Promise<void> {
		try {
			const parsed: unknown = JSON.parse(await fs.readFile(this.file, 'utf8'));
			if (!Array.isArray(parsed)) {
				throw new Error('not a list');
			}
			this.items = [];
			for (const entry of parsed) {
				if (this.validate(entry)) {
					this.items.push(entry);
				} else {
					this.onInvalid(`${this.file}: dropped invalid entry ${JSON.stringify(entry).slice(0, 120)}`);
				}
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				this.onInvalid(`${this.file}: ${error instanceof Error ? error.message : String(error)}`);
			}
			this.items = [];
		}
	}

	list(): readonly T[] {
		return this.items;
	}

	get(id: string): T | undefined {
		return this.items.find(item => item.id === id);
	}

	async upsert(item: T): Promise<void> {
		if (!this.validate(item)) {
			throw new Error('Invalid configuration entry.');
		}
		const index = this.items.findIndex(candidate => candidate.id === item.id);
		if (index >= 0) {
			this.items[index] = item;
		} else {
			this.items.push(item);
		}
		await this.save();
	}

	async remove(id: string): Promise<boolean> {
		const before = this.items.length;
		this.items = this.items.filter(item => item.id !== id);
		if (this.items.length !== before) {
			await this.save();
			return true;
		}
		return false;
	}

	private async save(): Promise<void> {
		await fs.writeFile(this.file, JSON.stringify(this.items, null, '\t') + '\n', 'utf8');
	}
}
