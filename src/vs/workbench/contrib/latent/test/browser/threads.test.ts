/* eslint-disable header/header */
import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IChatModelReference, IChatService } from '../../../chat/common/chatService/chatService.js';
import { IChatModel, IChatRequestModel, IExportableChatData, ISerializableChatData, isSerializableSessionData } from '../../../chat/common/model/chatModel.js';
import { ChatAgentLocation } from '../../../chat/common/constants.js';
import { ThreadService } from '../../browser/threads/threadService.js';

suite('Latent thread lifetime and versions', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	const resource = URI.parse('vscode-chat-session://local/fixture');
	const model = new class extends mock<IChatModel>() {
		override getRequests() { return []; }
	};

	class ChatService extends mock<IChatService>() {
		override onDidSubmitRequest = Event.None;
		override onDidDisposeSession = Event.None;
		owners = 0;
		override getSession(): IChatModel { return model; }
		override getSessionTitle() { return ''; }
		override acquireExistingSession(): IChatModelReference {
			this.owners++;
			return { object: model, dispose: () => this.owners-- };
		}
		override async acquireOrLoadSession() { return this.acquireExistingSession(); }
	}

	test('adopted and restored sessions remain owned when another host releases them', async () => {
		const storage = disposables.add(new InMemoryStorageService());
		const chat = new ChatService();
		const first = new ThreadService(chat, storage, new NullLogService());
		const thread = first.adoptSession(resource);
		assert.strictEqual(chat.owners, 1);
		first.dispose();
		const restored = disposables.add(new ThreadService(chat, storage, new NullLogService()));
		await restored.getTurns(thread.id);
		await restored.getTurns(thread.id);
		assert.deepStrictEqual({ owners: chat.owners, title: restored.getThread(thread.id)?.title }, { owners: 1, title: 'New Thread' });
	});

	test('edited branches use persistent data with a new identity, not an imported transcript', async () => {
		const originalData: ISerializableChatData = { version: 3, sessionId: 'original', creationDate: 1, customTitle: 'Original', initialLocation: ChatAgentLocation.Chat, responderUsername: 'Assistant', requests: [] };
		const original = new class extends mock<IChatModel>() {
			override getRequests() { return [{ message: { text: 'original message' }, attachedContext: [] } as unknown as IChatRequestModel]; }
			override toJSON() { return { ...originalData }; }
		};
		let loaded: IExportableChatData | ISerializableChatData | undefined;
		const chat = new class extends ChatService {
			override getSession() { return original; }
			override acquireExistingSession() { return { object: original, dispose() { } }; }
			override loadSessionFromData(data: IExportableChatData | ISerializableChatData) {
				loaded = data;
				return { object: new class extends mock<IChatModel>() {
					override get sessionResource() { return URI.parse('vscode-chat-session://local/branch'); }
				}, dispose() { } };
			}
		};
		const service = disposables.add(new ThreadService(chat, disposables.add(new InMemoryStorageService()), new NullLogService()));
		const thread = service.adoptSession(resource);
		await service.editTurn(thread.id, thread.activeBranchId, 0);
		assert.ok(isSerializableSessionData(loaded), 'export-only branches are excluded from the upstream store');
		assert.notStrictEqual(loaded.sessionId, originalData.sessionId);
		assert.strictEqual(originalData.sessionId, 'original');
		assert.strictEqual(loaded.inputState, undefined);
		assert.strictEqual(service.getThread(thread.id)?.branches.length, 2);
	});

	test('the edited sibling exposes both versions of the fork turn', () => {
		const storage = disposables.add(new InMemoryStorageService());
		storage.store('latent.threads.v1', JSON.stringify({ version: 1, activeByTab: {}, threads: [{ id: 'thread', title: 'Fixture', origin: 'workbench', createdAt: 1, updatedAt: 1, activeBranchId: 'edited', branches: [
			{ id: 'root', sessionResource: resource.toString(), createdAt: 1, label: 'Original' },
			{ id: 'edited', sessionResource: resource.with({ path: '/edited' }).toString(), createdAt: 2, label: 'Edited', parentBranchId: 'root', forkTurnIndex: 0 },
		] }] }), StorageScope.PROFILE, StorageTarget.MACHINE);
		const service = disposables.add(new ThreadService(new ChatService(), storage, new NullLogService()));
		assert.deepStrictEqual(service.getVersions('thread', 'edited', 0), { versions: ['root', 'edited'], currentIndex: 1 });
	});
});
