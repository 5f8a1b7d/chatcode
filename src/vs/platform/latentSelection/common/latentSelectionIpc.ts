/* eslint-disable header/header */
import { Event } from '../../../base/common/event.js';
import { IChannel, IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import { ILatentSelectionService, ISelectionActionEvent, ISelectionBarAction, ISelectionOverlayUpdate, ISelectionSnapshot, isOverlayUpdate, isSelectionBarActions, isSelectionSnapshot } from './latentSelection.js';

export class LatentSelectionChannel implements IServerChannel {
	constructor(private readonly service: ILatentSelectionService) { }

	listen<T>(_context: unknown, event: string): Event<T> {
		if (event === 'onDidRequestAction') {
			return this.service.onDidRequestAction as Event<T>;
		}
		throw new Error(`Event not found: ${event}`);
	}

	call<T>(_context: unknown, command: string, argument?: unknown): Promise<T> {
		if (!isRecord(argument) || !Number.isInteger(argument.windowId)) {
			throw new Error(`Invalid Latent selection request: ${command}`);
		}
		const windowId = argument.windowId as number;
		switch (command) {
			case 'setEnabled':
				if (typeof argument.enabled !== 'boolean') {
					throw new Error('Invalid Latent setEnabled request');
				}
				return this.service.setEnabled(windowId, argument.enabled) as Promise<T>;
			case 'setSystemActions':
				if (!isSelectionBarActions(argument.actions)) {
					throw new Error('Invalid Latent setSystemActions request');
				}
				return this.service.setSystemActions(windowId, argument.actions) as Promise<T>;
			case 'showSelection':
				if (!isSelectionSnapshot(argument.selection) || !isSelectionBarActions(argument.actions)) {
					throw new Error('Invalid Latent showSelection request');
				}
				return this.service.showSelection(windowId, argument.selection, argument.actions) as Promise<T>;
			case 'updateOverlay':
				if (!isOverlayUpdate(argument.update)) {
					throw new Error('Invalid Latent updateOverlay request');
				}
				return this.service.updateOverlay(windowId, argument.update) as Promise<T>;
			case 'setPinned':
				return this.service.setPinned(windowId, argument.pinned === true) as Promise<T>;
			case 'hide':
				return this.service.hide(windowId) as Promise<T>;
		}
		throw new Error(`Call not found: ${command}`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

export class LatentSelectionChannelClient implements ILatentSelectionService {
	declare readonly _serviceBrand: undefined;

	readonly onDidRequestAction: Event<ISelectionActionEvent>;

	constructor(private readonly channel: IChannel) {
		this.onDidRequestAction = channel.listen<ISelectionActionEvent>('onDidRequestAction');
	}

	setEnabled(windowId: number, enabled: boolean): Promise<boolean> {
		return this.channel.call('setEnabled', { windowId, enabled });
	}

	setSystemActions(windowId: number, actions: readonly ISelectionBarAction[]): Promise<void> {
		return this.channel.call('setSystemActions', { windowId, actions });
	}

	showSelection(windowId: number, selection: ISelectionSnapshot, actions: readonly ISelectionBarAction[]): Promise<void> {
		return this.channel.call('showSelection', { windowId, selection, actions });
	}

	updateOverlay(windowId: number, update: ISelectionOverlayUpdate): Promise<void> {
		return this.channel.call('updateOverlay', { windowId, update });
	}

	setPinned(windowId: number, pinned: boolean): Promise<void> {
		return this.channel.call('setPinned', { windowId, pinned });
	}

	hide(windowId: number): Promise<void> {
		return this.channel.call('hide', { windowId });
	}
}
