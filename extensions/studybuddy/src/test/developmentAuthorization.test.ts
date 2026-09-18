import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { developmentAuthorization } from '../learning/developmentAuthorization';
import { isPrivateNetworkHost } from '../utils';

test('development credential is available only in the development launch environment', () => {
	assert.equal(developmentAuthorization('http://localhost:8787', { VSCODE_DEV: '1', NODE_ENV: 'development' }), 'Bearer studybuddy-development-superuser-v1');
	assert.equal(developmentAuthorization('http://192.168.0.101:8787', { VSCODE_DEV: '1', NODE_ENV: 'development' }), 'Bearer studybuddy-development-superuser-v1');
	assert.equal(developmentAuthorization('https://example.com', { VSCODE_DEV: '1', NODE_ENV: 'development' }), undefined);
	assert.equal(developmentAuthorization('http://localhost:8787', { VSCODE_DEV: '1', NODE_ENV: 'production' }), undefined);
	assert.equal(developmentAuthorization('http://localhost:8787', { NODE_ENV: 'development' }), undefined);
});

test('HTTP loopback names and private IPs are accepted, public names remain protected', () => {
	for (const hostname of ['localhost', 'api.localhost', '127.0.0.1', '::1', '192.168.0.101']) {
		assert.equal(isPrivateNetworkHost(hostname), true, hostname);
	}
	assert.equal(isPrivateNetworkHost('example.com'), false);
});
