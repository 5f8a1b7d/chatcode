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

function normalizePath(value: string): string {
	return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Evaluates a tool call against the Bot's explicit scope (spec 01 P1-FR-083).
 * Anything outside the scope needs an approval; the caller decides how to ask.
 */
export function authorizeToolCall(scope: IToolAuthorizationScope, tool: string, args: Record<string, unknown>): IAuthorizationDecision {
	if (!scope.allowTools.some(pattern => globMatch(pattern, tool))) {
		return { allowed: false, reason: `tool ${tool} is not in allowTools` };
	}
	const path = typeof args.path === 'string' ? normalizePath(args.path) : undefined;
	if (path !== undefined) {
		if (path.startsWith('/') || path.startsWith('../') || path.includes('/../')) {
			return { allowed: false, reason: `path ${path} leaves the working directory` };
		}
		if (!scope.allowPaths.some(pattern => globMatch(normalizePath(pattern), path))) {
			return { allowed: false, reason: `path ${path} is not in allowPaths` };
		}
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
