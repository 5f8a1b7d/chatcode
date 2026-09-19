/* eslint-disable header/header */
import { URI } from '../../../../base/common/uri.js';
import { hash } from '../../../../base/common/hash.js';

/**
 * Identity of an editable Tab: one editor input opened in one editor group.
 * The same resource opened in two groups yields two different keys (P1-FR-020).
 */
export interface ITabKey {
	readonly groupId: number;
	readonly typeId: string;
	readonly resource: URI;
}

export function tabKeyEquals(a: ITabKey | undefined, b: ITabKey | undefined): boolean {
	if (!a || !b) {
		return a === b;
	}
	return a.groupId === b.groupId && a.typeId === b.typeId && a.resource.toString() === b.resource.toString();
}

/** Stable, storage-safe string for a tab key. */
export function tabKeyToString(key: ITabKey): string {
	return `${key.groupId}:${key.typeId}:${key.resource.toString()}`;
}

/** Short hash used as a storage key suffix. */
export function tabKeyHash(key: ITabKey): string {
	return hash(tabKeyToString(key)).toString(36);
}

export function tabKeyFromJSON(value: { groupId: number; typeId: string; resource: string }): ITabKey {
	return { groupId: value.groupId, typeId: value.typeId, resource: URI.parse(value.resource) };
}

export function tabKeyToJSON(key: ITabKey): { groupId: number; typeId: string; resource: string } {
	return { groupId: key.groupId, typeId: key.typeId, resource: key.resource.toString() };
}
