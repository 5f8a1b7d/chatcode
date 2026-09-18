import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { isCodingRequest } from '../chat/codingRequest';

test('routes direct coding requests and keeps explanations in Study Buddy', () => {
	assert.deepStrictEqual([
		isCodingRequest('change hello_world.py to TypeScript'),
		isCodingRequest('请把 hello_world.py 改成 TypeScript'),
		isCodingRequest('explain how to change hello_world.py'),
		isCodingRequest('What does this function do?'),
		isCodingRequest('change the summary title'),
		isCodingRequest('change this to TypeScript', true),
	], [true, true, false, false, false, true]);
});
