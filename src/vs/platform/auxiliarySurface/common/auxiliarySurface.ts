import { Event } from '../../../base/common/event.js';

/** Trusted workbench supplied content for a sandboxed auxiliary window. */
export interface IAuxiliarySurfaceRenderer {
	readonly html: string;
	readonly width: number;
	readonly height: number;
}

export interface IAuxiliarySurfaceRequest {
	readonly targetWindowId: number;
	readonly requestId: string;
	readonly action: string;
	readonly payload: string;
}

export interface IAuxiliarySurfaceResponse {
	readonly value?: string;
	readonly error?: string;
}

export interface IAuxiliarySurfaceService {
	readonly onDidRequestRendererAction: Event<IAuxiliarySurfaceRequest>;
	setRenderer(windowId: number, renderer: IAuxiliarySurfaceRenderer): Promise<void>;
	resolveRendererAction(windowId: number, requestId: string, response: IAuxiliarySurfaceResponse): Promise<void>;
}

export function isAuxiliarySurfaceRenderer(value: unknown): value is IAuxiliarySurfaceRenderer {
	const renderer = value as IAuxiliarySurfaceRenderer | undefined;
	return !!renderer && typeof renderer.html === 'string' && renderer.html.length <= 2_000_000
		&& Number.isInteger(renderer.width) && renderer.width >= 100 && renderer.width <= 1200
		&& Number.isInteger(renderer.height) && renderer.height >= 40 && renderer.height <= 1000;
}

export function isAuxiliarySurfaceResponse(value: unknown): value is IAuxiliarySurfaceResponse {
	const response = value as IAuxiliarySurfaceResponse | undefined;
	return !!response && (response.value === undefined || typeof response.value === 'string' && response.value.length <= 1_000_000)
		&& (response.error === undefined || typeof response.error === 'string' && response.error.length <= 10_000);
}
