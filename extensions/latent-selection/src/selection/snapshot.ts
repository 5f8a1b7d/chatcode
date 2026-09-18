import type { ISelectionSnapshot } from '../api';

export interface ISelectionActionEvent {
	readonly targetWindowId: number;
	readonly actionId: string;
	readonly action: string;
	readonly selection: ISelectionSnapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

export function isSelectionSnapshot(value: unknown): value is ISelectionSnapshot {
	return isRecord(value)
		&& typeof value.selectionId === 'string'
		&& (value.source === 'editor' || value.source === 'thread' || value.source === 'system')
		&& typeof value.text === 'string'
		&& typeof value.capturedAt === 'number'
		&& typeof value.editable === 'boolean';
}

export function isSelectionActionEvent(value: unknown): value is ISelectionActionEvent {
	return isRecord(value)
		&& typeof value.targetWindowId === 'number'
		&& typeof value.actionId === 'string'
		&& typeof value.action === 'string'
		&& isSelectionSnapshot(value.selection);
}

/** Resolves `"os"` to the operating-system locale (P2-FR-020). */
export function resolveTargetLanguage(configured: string | undefined, osLocale: string | undefined, intlLocale: string): string {
	const value = configured?.trim();
	if (value && value !== 'os') {
		return value;
	}
	return osLocale?.trim() || intlLocale || 'en';
}

const displayNames: Record<string, string> = {
	'en': 'English', 'zh-cn': '中文（简体）', 'zh': '中文（简体）', 'zh-tw': '中文（繁體）', 'ja': '日本語', 'ko': '한국어', 'de': 'Deutsch', 'fr': 'Français', 'es': 'Español', 'pt-br': 'Português (Brasil)', 'pt': 'Português', 'it': 'Italiano', 'ru': 'Русский',
};

export function languageDisplayName(tag: string): string {
	const lower = tag.toLowerCase();
	return displayNames[lower] ?? displayNames[lower.split('-')[0]] ?? tag;
}

/** Builds the Translate prompt; the target language is stated explicitly so the label can be verified. */
export function translationPrompt(targetLanguage: string): string {
	return `Translate the selected text into ${languageDisplayName(targetLanguage)} (${targetLanguage}). Preserve meaning, terminology, formulas, and paragraph structure. Return only the translation.`;
}
