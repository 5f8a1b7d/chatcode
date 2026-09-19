/* eslint-disable header/header */
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { authorizeToolCall, globMatch } from '../../node/bots/authorization.js';

suite('Latent runtime tool authorization (P1-AS-021)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const scope = { allowTools: ['read_file', 'recall'], allowPaths: ['docs/**'], allowNetwork: ['api.openalex.org'], autoApprove: true };

	test('glob matching covers * ** and ?', () => {
		assert.deepStrictEqual([
			globMatch('docs/**', 'docs/a/b.md'),
			globMatch('docs/**', 'docs'),
			globMatch('docs/*', 'docs/a/b.md'),
			globMatch('*.md', 'x.md'),
			globMatch('api.?penalex.org', 'api.openalex.org'),
		], [true, false, false, true, true]);
	});

	test('allows only tools and paths inside the scope', () => {
		assert.deepStrictEqual([
			authorizeToolCall(scope, 'read_file', { path: 'docs/x.md' }).allowed,
			authorizeToolCall(scope, 'write_file', { path: 'docs/x.md' }).reason,
			authorizeToolCall(scope, 'read_file', { path: 'src/x.ts' }).reason,
			authorizeToolCall(scope, 'read_file', { path: '../secrets' }).reason,
			authorizeToolCall(scope, 'recall', { query: 'x' }).allowed,
		], [true, 'tool write_file is not in allowTools', 'path src/x.ts is not in allowPaths', 'path ../secrets leaves the working directory', true]);
	});

	test('path-qualified tool entries limit a tool to their paths', () => {
		const qualified = { allowTools: ['read_file', 'write_file paper/**', 'terminal experiments/**', 'zotero.*'], allowPaths: ['**'], allowNetwork: [], autoApprove: true };
		assert.deepStrictEqual([
			authorizeToolCall(qualified, 'write_file', { path: 'paper/intro.tex' }).allowed,
			authorizeToolCall(qualified, 'write_file', { path: 'experiments/run.py' }).reason,
			authorizeToolCall(qualified, 'read_file', { path: 'experiments/run.py' }).allowed,
			authorizeToolCall(qualified, 'terminal', { cwd: 'experiments/a', command: 'python run.py' }).allowed,
			authorizeToolCall(qualified, 'terminal', { cwd: 'experiments', command: 'ls' }).allowed,
			authorizeToolCall(qualified, 'terminal', { command: 'ls' }).reason,
			authorizeToolCall(qualified, 'zotero.search', { query: 'x' }).allowed,
		], [true, 'write_file is only allowed for paper/**', true, true, true, 'terminal is only allowed for experiments/**', true]);
	});

	test('network hosts follow allowNetwork', () => {
		const wide = { ...scope, allowTools: ['http_fetch'] };
		assert.deepStrictEqual([
			authorizeToolCall(wide, 'http_fetch', { url: 'https://api.openalex.org/works' }).allowed,
			authorizeToolCall(wide, 'http_fetch', { url: 'https://example.com' }).reason,
			authorizeToolCall(wide, 'http_fetch', { url: 'not a url' }).reason,
		], [true, 'host example.com is not in allowNetwork', 'invalid url not a url']);
	});
});
