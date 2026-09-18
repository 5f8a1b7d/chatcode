import { isPrivateNetworkHost } from '../utils';

const developmentSuperuserToken = 'studybuddy-development-superuser-v1';

export function developmentAuthorization(serviceUrl: string, environment: NodeJS.ProcessEnv = process.env): string | undefined {
	if (environment.VSCODE_DEV !== '1' || environment.NODE_ENV !== 'development') return undefined;
	try {
		if (isPrivateNetworkHost(new URL(serviceUrl).hostname)) return `Bearer ${developmentSuperuserToken}`;
	} catch {
		// The client reports malformed service URLs when a request starts.
	}
	return undefined;
}
