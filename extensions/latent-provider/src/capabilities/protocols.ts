/** Protocol predicates shared by the binding computation and the adapters; free of the `vscode` module so tests can load them. */
export function supportedTextProtocol(protocol: string | undefined): boolean {
	return protocol === 'openai' || protocol === 'azure' || protocol === 'anthropic' || protocol === 'google';
}

export function supportedRealtimeProtocol(protocol: string | undefined): boolean {
	return ['openai-realtime', 'gemini-live', 'moshi', 'personaplex', 'nemotron-voicechat'].includes(protocol ?? '');
}
