/* eslint-disable header/header */
import { IGatewayConfig, IGatewayHealth } from '../../../platform/latentRuntime/common/runtimeProtocol.js';

export interface IInboundMessage {
	readonly gatewayId: string;
	readonly chatId: string;
	readonly sender: string;
	readonly senderName?: string;
	readonly text: string;
	readonly messageId?: string;
}

/**
 * Contract every Gateway adapter implements; mirrors the operational subset of
 * Hermes' `BasePlatformAdapter` (connect, disconnect, send, typing, health).
 */
export interface IGatewayAdapter {
	readonly config: IGatewayConfig;
	connect(): Promise<void>;
	disconnect(): Promise<void>;
	send(chatId: string, text: string): Promise<void>;
	sendTyping?(chatId: string): Promise<void>;
	health(): IGatewayHealth;
	onMessage(handler: (message: IInboundMessage) => Promise<void>): void;
}

export interface IGatewayAdapterContext {
	readonly secret: (key: string) => string | undefined;
	readonly log: (message: string) => void;
}

export type GatewayAdapterFactory = (config: IGatewayConfig, context: IGatewayAdapterContext) => IGatewayAdapter;
