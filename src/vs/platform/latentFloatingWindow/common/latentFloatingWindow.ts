/* eslint-disable header/header */
import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const LATENT_FLOATING_WINDOW_CHANNEL = 'latentFloatingWindow';

/** Fixed compact size of the Floating Window (P2-FR-060); a constant, not a setting. */
export const FLOATING_WINDOW_WIDTH = 360;
export const FLOATING_WINDOW_HEIGHT = 132;

export type FloatingVoiceState = 'off' | 'connecting' | 'listening' | 'speaking' | 'error';

export interface IFloatingWindowState {
	readonly threadTitle?: string;
	readonly voice: FloatingVoiceState;
	readonly statusText?: string;
	readonly transcript?: readonly { readonly role: 'user' | 'assistant'; readonly text: string }[];
}

export interface IFloatingNewThreadEvent {
	readonly targetWindowId: number;
	readonly text: string;
}

export interface IFloatingVoiceEvent {
	readonly targetWindowId: number;
}

export const ILatentFloatingWindowService = createDecorator<ILatentFloatingWindowService>('latentFloatingWindowService');

export interface ILatentFloatingWindowService {
	readonly _serviceBrand: undefined;
	readonly onDidRequestNewThread: Event<IFloatingNewThreadEvent>;
	readonly onDidToggleVoice: Event<IFloatingVoiceEvent>;
	/** Only the main application's settings may disable the window (P2-FR-064). */
	setEnabled(windowId: number, enabled: boolean): Promise<void>;
	setState(windowId: number, state: IFloatingWindowState): Promise<void>;
	isEnabled(): Promise<boolean>;
}

export function isFloatingWindowState(value: unknown): value is IFloatingWindowState {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const candidate = value as Partial<IFloatingWindowState>;
	return ['off', 'connecting', 'listening', 'speaking', 'error'].includes(candidate.voice as string)
		&& (candidate.threadTitle === undefined || typeof candidate.threadTitle === 'string')
		&& (candidate.statusText === undefined || typeof candidate.statusText === 'string')
		&& (candidate.transcript === undefined || (Array.isArray(candidate.transcript) && candidate.transcript.every(item => (item.role === 'user' || item.role === 'assistant') && typeof item.text === 'string')));
}
