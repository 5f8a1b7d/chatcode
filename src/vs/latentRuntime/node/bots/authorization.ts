/* eslint-disable header/header */
import { IToolAuthorizationScope } from '../../../platform/latentRuntime/common/runtimeProtocol.js';

export interface IAuthorizationDecision {
	readonly allowed: boolean;
	readonly reason?: string;
}

/** Minimal glob matcher (`*`, `**`, `?`) without external dependencies. */
export function globMatch(pattern: string, value: string): boolean {
	let expression = '';
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i];
		if (char === '*') {
			if (pattern[i + 1] === '*') {
				i++;
				if (pattern[i + 1] === '/') {
					i++;
					expression += '(?:.*/)?';
				} else {
					expression += '.*';
				}
			} else {
				expression += '[^/]*';
			}
		} else if (char === '?') {
			expression += '[^/]';
		} else {
			expression += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
		}
	}
	return new RegExp(`^${expression}$`).test(value);
}

/** Path globs also match the folder a `folder/**` pattern names, so `cwd: "experiments"` fits `experiments/**`. */
function pathMatch(pattern: string, path: string): boolean {
	return globMatch(pattern, path) || (pattern.endsWith('/**') && path === pattern.slice(0, -3));
}

function normalizePath(value: string): string {
	return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Splits an `allowTools` entry into the tool pattern and an optional path qualifier,
 * so a scope can say `write_file paper/**` (tool allowed only for paths under `paper/`).
 */
function parseToolEntry(entry: string): { readonly tool: string; readonly path?: string } {
	const match = /^(?<tool>\S+)\s+(?<path>\S.*)$/.exec(entry.trim());
	return match?.groups ? { tool: match.groups.tool, path: normalizePath(match.groups.path.trim()) } : { tool: entry.trim() };
}

/**
 * Evaluates a tool call against the Bot's explicit scope (spec 01 P1-FR-083).
 * Anything outside the scope needs an approval; the caller decides how to ask.
 */
export function authorizeToolCall(scope: IToolAuthorizationScope, tool: string, args: Record<string, unknown>): IAuthorizationDecision {
	const entries = scope.allowTools.map(parseToolEntry).filter(entry => globMatch(entry.tool, tool));
	if (!entries.length) {
		return { allowed: false, reason: `tool ${tool} is not in allowTools` };
	}
	const rawPath = typeof args.path === 'string' ? args.path : typeof args.cwd === 'string' ? args.cwd : undefined;
	const path = rawPath !== undefined ? normalizePath(rawPath) : undefined;
	if (path !== undefined && (path.startsWith('/') || path.startsWith('../') || path.includes('/../') || path === '..')) {
		return { allowed: false, reason: `path ${path} leaves the working directory` };
	}
	const unqualified = entries.some(entry => entry.path === undefined);
	if (unqualified) {
		if (path !== undefined && !scope.allowPaths.some(pattern => pathMatch(normalizePath(pattern), path))) {
			return { allowed: false, reason: `path ${path} is not in allowPaths` };
		}
	} else if (path === undefined || !entries.some(entry => pathMatch(entry.path!, path))) {
		return { allowed: false, reason: `${tool} is only allowed for ${entries.map(entry => entry.path).join(', ')}` };
	}
	const url = typeof args.url === 'string' ? args.url : undefined;
	if (url !== undefined) {
		let host: string;
		try {
			host = new URL(url).hostname;
		} catch {
			return { allowed: false, reason: `invalid url ${url}` };
		}
		if (!scope.allowNetwork.some(pattern => globMatch(pattern, host))) {
			return { allowed: false, reason: `host ${host} is not in allowNetwork` };
		}
	}
	return { allowed: true };
}
