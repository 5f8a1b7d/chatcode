/** Protocol predicates shared by the binding computation and the adapters; free of the `vscode` module so tests can load them. */
export function supportedTextProtocol(protocol: string | undefined): boolean {
	return protocol === 'openai' || protocol === 'azure' || protocol === 'anthropic' || protocol === 'google';
}

export function supportedRealtimeProtocol(protocol: string | undefined): boolean {
	return protocol === 'openai-realtime';
}
