/* eslint-disable header/header */
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';

/**
 * Encrypted secret file for gateway tokens and model credentials (spec 01 §3.4).
 * The key lives in a mode-0600 file next to it so the runtime can decrypt
 * without the workbench running; moving the key into the OS keychain is a
 * follow-up that only changes `loadKey`.
 */
export class RuntimeSecrets {
	private key: Buffer | undefined;
	private values = new Map<string, string>();
	private readonly file: string;
	private readonly keyFile: string;

	constructor(home: string) {
		this.file = join(home, 'secrets.enc');
		this.keyFile = join(home, 'runtime.key');
	}

	async load(): Promise<void> {
		this.key = await this.loadKey();
		try {
			const raw = await fs.readFile(this.file);
			const iv = raw.subarray(0, 12);
			const tag = raw.subarray(12, 28);
			const payload = raw.subarray(28);
			const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
			decipher.setAuthTag(tag);
			const json = Buffer.concat([decipher.update(payload), decipher.final()]).toString('utf8');
			this.values = new Map(Object.entries(JSON.parse(json) as Record<string, string>));
		} catch {
			this.values = new Map();
		}
	}

	private async loadKey(): Promise<Buffer> {
		try {
			const existing = await fs.readFile(this.keyFile);
			if (existing.length === 32) {
				return existing;
			}
		} catch {
			// create below
		}
		const key = randomBytes(32);
		await fs.writeFile(this.keyFile, key, { mode: 0o600 });
		return key;
	}

	get(key: string): string | undefined {
		return this.values.get(key);
	}

	keys(): string[] {
		return [...this.values.keys()];
	}

	async set(key: string, value: string): Promise<void> {
		this.values.set(key, value);
		await this.save();
	}

	async delete(key: string): Promise<void> {
		this.values.delete(key);
		await this.save();
	}

	private async save(): Promise<void> {
		if (!this.key) {
			this.key = await this.loadKey();
		}
		const iv = randomBytes(12);
		const cipher = createCipheriv('aes-256-gcm', this.key, iv);
		const payload = Buffer.concat([cipher.update(JSON.stringify(Object.fromEntries(this.values)), 'utf8'), cipher.final()]);
		await fs.writeFile(this.file, Buffer.concat([iv, cipher.getAuthTag(), payload]), { mode: 0o600 });
	}
}
