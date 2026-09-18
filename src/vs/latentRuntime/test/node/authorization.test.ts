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

	test('network hosts follow allowNetwork', () => {
		const wide = { ...scope, allowTools: ['http_fetch'] };
		assert.deepStrictEqual([
			authorizeToolCall(wide, 'http_fetch', { url: 'https://api.openalex.org/works' }).allowed,
			authorizeToolCall(wide, 'http_fetch', { url: 'https://example.com' }).reason,
			authorizeToolCall(wide, 'http_fetch', { url: 'not a url' }).reason,
		], [true, 'host example.com is not in allowNetwork', 'invalid url not a url']);
	});
});
