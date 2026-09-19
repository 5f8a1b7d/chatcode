/* eslint-disable header/header */
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { encodeMessage, isNotification, isRequest, isResponse, JsonRpcDecoder } from '../../../platform/latentRuntime/common/jsonRpc.js';

suite('Latent runtime JSON-RPC framing', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('decodes complete lines across chunks and reports malformed ones', () => {
		const decoder = new JsonRpcDecoder();
		const first = decoder.accept('{"jsonrpc":"2.0","id":1,"method":"runtime.getSta');
		const second = decoder.accept('te"}\nnot json\n{"jsonrpc":"2.0","method":"notify","params":{"kind":"state"}}\n{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n');
		assert.deepStrictEqual({
			firstMessages: first.messages.length,
			kinds: second.messages.map(message => isRequest(message) ? 'request' : isNotification(message) ? 'notification' : isResponse(message) ? 'response' : 'other'),
			malformed: second.malformed,
		}, { firstMessages: 0, kinds: ['request', 'notification', 'response'], malformed: ['not json'] });
	});

	test('encodes one message per line', () => {
		assert.strictEqual(encodeMessage({ jsonrpc: '2.0', id: 2, method: 'x' }), '{"jsonrpc":"2.0","id":2,"method":"x"}\n');
	});
});
