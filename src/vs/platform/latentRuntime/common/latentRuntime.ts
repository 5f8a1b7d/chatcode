/* eslint-disable header/header */
import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { IRuntimeState, RuntimeNotification } from './runtimeProtocol.js';

export const LATENT_RUNTIME_CHANNEL = 'latentRuntime';

export const ILatentRuntimeService = createDecorator<ILatentRuntimeService>('latentRuntimeService');

/**
 * Main-process supervisor of the Managed Runtime process. The workbench
 * reaches the runtime only through this service (spec 01 P1-FR-101).
 */
export interface ILatentRuntimeService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeState: Event<IRuntimeState>;
	readonly onDidNotify: Event<RuntimeNotification>;
	getState(): Promise<IRuntimeState>;
	/** Starts (or attaches to) the runtime process and returns once the socket is authenticated. */
	start(): Promise<IRuntimeState>;
	/** Stops the runtime unless background mode keeps it alive. */
	stop(): Promise<void>;
	setBackgroundEnabled(enabled: boolean): Promise<IRuntimeState>;
	/** Invokes a runtime RPC method; the workbench service wraps this with typed helpers. */
	call<T>(method: string, params?: unknown): Promise<T>;
	/** Location of the runtime's user-data folder (memory files live here). */
	getRuntimeHome(): Promise<string>;
}
