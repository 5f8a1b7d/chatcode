/* eslint-disable header/header */
/** Optional host-startup allow-list. Absent keeps the upstream provider set unchanged. */
export function isAgentHostProviderAllowed(provider: string, env: NodeJS.ProcessEnv = process.env): boolean {
	const configured = env.VSCODE_AGENT_HOST_ALLOWED_PROVIDERS;
	return configured === undefined || configured.split(',').map(value => value.trim()).includes(provider);
}
