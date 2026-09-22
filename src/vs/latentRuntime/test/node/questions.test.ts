import assert from 'assert';
import { QuestionService } from '../../node/bots/questions.js';

suite('Bot clarification questions', () => {
	test('lists a batch and resumes with the submitted answers', async () => {
		const notifications: string[] = [];
		const service = new QuestionService(() => 1000, event => notifications.push(event.kind));
		const pending = service.request({ botId: 'bot', sessionId: 'session', requestId: 'run', questions: [{ id: 'source', question: 'Which source?', choices: ['A', 'B'] }, { id: 'format', question: 'Which format?', multiSelect: true }] });
		const [request] = service.list();
		assert.equal(request.questions.length, 2);
		assert.equal(service.respond(request.id, { source: 'A', format: 'PDF, Markdown' }), true);
		assert.deepStrictEqual(await pending, { source: 'A', format: 'PDF, Markdown' });
		assert.deepStrictEqual(notifications, ['questionRequested', 'questionResolved']);
	});

	test('aborting a run clears its pending question', async () => {
		const service = new QuestionService(() => 1000, () => undefined);
		const controller = new AbortController();
		const pending = service.request({ botId: 'bot', sessionId: 'session', questions: [{ id: 'answer', question: 'Continue?' }] }, controller.signal);
		controller.abort();
		assert.equal(await pending, undefined);
		assert.deepStrictEqual(service.list(), []);
	});
});
