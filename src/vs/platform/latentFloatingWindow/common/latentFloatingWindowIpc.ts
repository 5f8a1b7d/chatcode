/* eslint-disable header/header */
import { Event } from '../../../base/common/event.js';
import { IChannel, IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import { IFloatingNewThreadEvent, IFloatingVoiceEvent, IFloatingWindowState, ILatentFloatingWindowService, isFloatingWindowState } from './latentFloatingWindow.js';

export class LatentFloatingWindowChannel implements IServerChannel {
	constructor(private readonly service: ILatentFloatingWindowService) { }

	listen<T>(_context: unknown, event: string): Event<T> {
		switch (event) {
			case 'onDidRequestNewThread': return this.service.onDidRequestNewThread as Event<T>;
			case 'onDidToggleVoice': return this.service.onDidToggleVoice as Event<T>;
		}
		throw new Error(`Event not found: ${event}`);
	}

	call<T>(_context: unknown, command: string, argument?: unknown): Promise<T> {
		const record = (typeof argument === 'object' && argument !== null ? argument : {}) as Record<string, unknown>;
		switch (command) {
			case 'isEnabled':
				return this.service.isEnabled() as Promise<T>;
			case 'setEnabled':
				if (!Number.isInteger(record.windowId) || typeof record.enabled !== 'boolean') {
					throw new Error('Invalid Latent floating window setEnabled request');
				}
				return this.service.setEnabled(record.windowId as number, record.enabled) as Promise<T>;
			case 'setState':
				if (!Number.isInteger(record.windowId) || !isFloatingWindowState(record.state)) {
					throw new Error('Invalid Latent floating window state');
				}
				return this.service.setState(record.windowId as number, record.state) as Promise<T>;
		}
		throw new Error(`Call not found: ${command}`);
	}
}

export class LatentFloatingWindowChannelClient implements ILatentFloatingWindowService {
	declare readonly _serviceBrand: undefined;
	readonly onDidRequestNewThread: Event<IFloatingNewThreadEvent>;
	readonly onDidToggleVoice: Event<IFloatingVoiceEvent>;

	constructor(private readonly channel: IChannel) {
		this.onDidRequestNewThread = channel.listen<IFloatingNewThreadEvent>('onDidRequestNewThread');
		this.onDidToggleVoice = channel.listen<IFloatingVoiceEvent>('onDidToggleVoice');
	}

	isEnabled(): Promise<boolean> {
		return this.channel.call('isEnabled');
	}

	setEnabled(windowId: number, enabled: boolean): Promise<void> {
		return this.channel.call('setEnabled', { windowId, enabled });
	}

	setState(windowId: number, state: IFloatingWindowState): Promise<void> {
		return this.channel.call('setState', { windowId, state });
	}
}
