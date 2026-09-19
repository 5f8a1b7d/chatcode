/* eslint-disable header/header */
import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { timeout } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { loadReactRuntime } from '../../browser/reactRuntime.js';

suite('Latent React runtime', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('loads a ReactDOM bound to the loaded React', async () => {
		const runtime = await loadReactRuntime();
		const container = mainWindow.document.createElement('div');
		const root = runtime.createRoot(container);
		root.render(runtime.React.createElement('span', undefined, 'rendered'));
		await timeout(50);
		const text = container.textContent;
		root.unmount();
		assert.deepStrictEqual({ version: runtime.React.version, text }, { version: '18.3.1', text: 'rendered' });
	});
});
