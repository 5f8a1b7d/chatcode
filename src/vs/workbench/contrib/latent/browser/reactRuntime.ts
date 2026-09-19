/* eslint-disable header/header */
// eslint-disable-next-line local/code-import-patterns
import type * as React from 'react';
// eslint-disable-next-line local/code-import-patterns
import type { Root } from 'react-dom/client';
import { importAMDNodeModule } from '../../../../amdX.js';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';

/** React and the ReactDOM entry point used by fork-owned React surfaces. */
export interface IReactRuntime {
	readonly React: typeof React;
	createRoot(container: Element | DocumentFragment): Root;
}

interface IReactDOMModule {
	createRoot(container: Element | DocumentFragment): Root;
}

type AMDFactory = (...dependencies: unknown[]) => unknown;
type AMDDefine = ((...args: unknown[]) => unknown) & { amd?: unknown };

let runtime: Promise<IReactRuntime> | undefined;

/**
 * Loads React and ReactDOM from their UMD bundles once per renderer.
 *
 * The ReactDOM bundle declares the AMD dependency `react`, which the upstream AMD importer
 * does not resolve. Instead of extending that importer, the dependency is supplied here by
 * rewriting only `define` calls that name `react` while ReactDOM loads.
 */
export function loadReactRuntime(): Promise<IReactRuntime> {
	runtime ??= (async () => {
		const react = await importAMDNodeModule<typeof React>('react', 'umd/react.production.min.js');
		const dependency = provideAMDDependency('react', react);
		try {
			const reactDOM = await importAMDNodeModule<IReactDOMModule>('react-dom', 'umd/react-dom.production.min.js');
			return { React: react, createRoot: container => reactDOM.createRoot(container) };
		} finally {
			dependency.dispose();
		}
	})();
	return runtime;
}

/** Resolves `moduleId` to `value` for AMD modules defined until the result is disposed. */
function provideAMDDependency(moduleId: string, value: unknown): IDisposable {
	const target = globalThis as { define?: AMDDefine };
	const original = target.define;
	if (typeof original !== 'function') {
		throw new Error('The AMD importer did not install a define function.');
	}
	const define: AMDDefine = (...args) => {
		const index = typeof args[0] === 'string' ? 1 : 0;
		const dependencies = args[index];
		const factory = args[index + 1];
		if (!Array.isArray(dependencies) || !dependencies.includes(moduleId) || typeof factory !== 'function') {
			return original(...args);
		}
		const remaining = dependencies.filter(dependency => dependency !== moduleId);
		const withDependency: AMDFactory = (...resolved) => {
			let next = 0;
			return (factory as AMDFactory)(...dependencies.map(dependency => dependency === moduleId ? value : resolved[next++]));
		};
		return original(...args.slice(0, index), remaining, withDependency);
	};
	define.amd = original.amd;
	target.define = define;
	return toDisposable(() => {
		if (target.define === define) {
			target.define = original;
		}
	});
}
