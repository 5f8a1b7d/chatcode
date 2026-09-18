/* eslint-disable header/header */
import { Event } from '../../../base/common/event.js';
import { IChannel, IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import { IStudyBuddySelectionActionEvent, IStudyBuddySelectionService, StudyBuddySelectionOverlayUpdate } from './studyBuddySelection.js';

export class StudyBuddySelectionChannel implements IServerChannel {
	constructor(private readonly service: IStudyBuddySelectionService) { }

	listen<T>(_context: unknown, event: string): Event<T> {
		if (event === 'onDidRequestAction') {
			return this.service.onDidRequestAction as Event<T>;
		}
		throw new Error(`Event not found: ${event}`);
	}

	call<T>(_context: unknown, command: string, argument?: unknown): Promise<T> {
		switch (command) {
			case 'setEnabled': {
				if (!isRecord(argument) || !Number.isInteger(argument.windowId) || typeof argument.enabled !== 'boolean') {
					throw new Error('Invalid StudyBuddy setEnabled request');
				}
				const value = argument as { windowId: number; enabled: boolean };
				return this.service.setEnabled(value.windowId, value.enabled) as Promise<T>;
			}
			case 'updateOverlay': {
				if (!isRecord(argument) || !Number.isInteger(argument.windowId) || !isOverlayUpdate(argument.update)) {
					throw new Error('Invalid StudyBuddy updateOverlay request');
				}
				const value = argument as { windowId: number; update: StudyBuddySelectionOverlayUpdate };
				return this.service.updateOverlay(value.windowId, value.update) as Promise<T>;
			}
			case 'showEditorSelection': {
				if (!isRecord(argument) || typeof argument.windowId !== 'number' || !Number.isInteger(argument.windowId)
					|| typeof argument.text !== 'string' || argument.text.length > 50_000) {
					throw new Error('Invalid StudyBuddy editor selection request');
				}
				return this.service.showEditorSelection(argument.windowId, argument.text) as Promise<T>;
			}
		}
		throw new Error(`Call not found: ${command}`);
	}
}

function isOverlayUpdate(value: unknown): value is StudyBuddySelectionOverlayUpdate {
	return isRecord(value)
		&& typeof value.selectionId === 'string'
		&& typeof value.actionId === 'string'
		&& (value.action === 'explain' || value.action === 'translate' || value.action === 'summarize' || value.action === 'context')
		&& (value.phase === 'running' || value.phase === 'succeeded' || value.phase === 'failed')
		&& (value.text === undefined || typeof value.text === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

export class StudyBuddySelectionChannelClient implements IStudyBuddySelectionService {
	declare readonly _serviceBrand: undefined;

	readonly onDidRequestAction: Event<IStudyBuddySelectionActionEvent>;

	constructor(private readonly channel: IChannel) {
		this.onDidRequestAction = channel.listen<IStudyBuddySelectionActionEvent>('onDidRequestAction');
	}

	setEnabled(windowId: number, enabled: boolean): Promise<boolean> {
		return this.channel.call('setEnabled', { windowId, enabled });
	}

	showEditorSelection(windowId: number, text: string): Promise<void> {
		return this.channel.call('showEditorSelection', { windowId, text });
	}

	updateOverlay(windowId: number, update: StudyBuddySelectionOverlayUpdate): Promise<void> {
		return this.channel.call('updateOverlay', { windowId, update });
	}
}
