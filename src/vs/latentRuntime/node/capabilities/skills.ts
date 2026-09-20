/* eslint-disable header/header */
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { basename, join } from 'path';
import { ICapabilitySource, IRuntimeCapability } from '../../../platform/latentRuntime/common/runtimeProtocol.js';

/** Runtime Capabilities in the agentskills.io layout: one folder per skill with a `SKILL.md` front matter. */
export class SkillRegistry {
	private readonly root: string;

	constructor(home: string) {
		this.root = join(home, 'capabilities');
	}

	async list(): Promise<IRuntimeCapability[]> {
		await fs.mkdir(this.root, { recursive: true });
		const entries = await fs.readdir(this.root, { withFileTypes: true });
		const skills: IRuntimeCapability[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory()) {
				continue;
			}
			const path = join(this.root, entry.name);
			try {
				const text = await fs.readFile(join(path, 'SKILL.md'), 'utf8');
				const meta = parseFrontMatter(text);
				skills.push({ id: entry.name, name: meta.name ?? entry.name, description: meta.description ?? '', path, source: meta.source ?? 'local' });
			} catch {
				// not a skill folder
			}
		}
		return skills;
	}

	async remove(id: string): Promise<void> {
		if (!id || id === '.' || id === '..' || /[/\\]/.test(id)) { throw new Error('Invalid skill id.'); }
		await fs.rm(join(this.root, id), { recursive: true, force: true });
	}

	async install(source: ICapabilitySource): Promise<IRuntimeCapability> {
		await fs.mkdir(this.root, { recursive: true });
		const name = basename(source.location.replace(/\.git$/, '')).replace(/[^\w.-]/g, '-') || 'skill';
		if (name === '.' || name === '..') { throw new Error('Invalid skill folder name.'); }
		const target = join(this.root, name);
		if (source.kind === 'path') {
			await fs.cp(source.location, target, { recursive: true });
		} else {
			await new Promise<void>((resolve, reject) => execFile('git', ['clone', '--depth', '1', source.location, target], error => error ? reject(error) : resolve()));
		}
		const text = await fs.readFile(join(target, 'SKILL.md'), 'utf8').catch(() => { throw new Error('The source has no SKILL.md.'); });
		const meta = parseFrontMatter(text);
		return { id: name, name: meta.name ?? name, description: meta.description ?? '', path: target, source: source.location };
	}

	/** Loads the instructions of the named skills for a bot's system prompt. */
	async instructions(ids: readonly string[]): Promise<string> {
		const parts: string[] = [];
		for (const id of ids) {
			if (!id || id === '.' || id === '..' || /[/\\]/.test(id)) { continue; }
			try {
				parts.push(await fs.readFile(join(this.root, id, 'SKILL.md'), 'utf8'));
			} catch {
				// skipped silently; the bot still runs without the skill
			}
		}
		return parts.join('\n\n');
	}
}

function parseFrontMatter(text: string): Record<string, string> {
	const match = /^---\n([\s\S]*?)\n---/.exec(text);
	const result: Record<string, string> = {};
	if (!match) {
		return result;
	}
	for (const line of match[1].split('\n')) {
		const separator = line.indexOf(':');
		if (separator > 0) {
			result[line.slice(0, separator).trim()] = line.slice(separator + 1).trim().replace(/^["']|["']$/g, '');
		}
	}
	return result;
}
