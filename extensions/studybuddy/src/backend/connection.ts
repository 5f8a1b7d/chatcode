import * as vscode from 'vscode';
import { accessTokenSecret } from '../learning/explanationController';
import { developmentAuthorization } from '../learning/developmentAuthorization';
import { isPrivateNetworkHost } from '../utils';
import { StudyBuddyClient, StudyBuddyServiceError } from './client';

/** Creates an authenticated connection to the configured Study Buddy service. */
export async function createAuthorizedStudyBuddyClient(context: vscode.ExtensionContext): Promise<StudyBuddyClient> {
	const configured = vscode.workspace.getConfiguration('latentnote.studyBuddy').get<string>('serviceUrl', 'http://127.0.0.1:8787');
	let serviceUrl: URL;
	try {
		serviceUrl = new URL(configured);
	} catch {
		throw new StudyBuddyServiceError(vscode.l10n.t('Study Buddy service URL must be a valid HTTP or HTTPS URL.'));
	}
	if (!['http:', 'https:'].includes(serviceUrl.protocol) || (serviceUrl.protocol === 'http:' && !isPrivateNetworkHost(serviceUrl.hostname))) {
		throw new StudyBuddyServiceError(vscode.l10n.t('Study Buddy requires HTTPS for non-private service URLs.'));
	}
	const stored = await context.secrets.get(accessTokenSecret);
	const authorization = stored
		? stored.toLowerCase().startsWith('bearer ') ? stored : `Bearer ${stored}`
		: developmentAuthorization(configured);
	if (!authorization) {
		throw new StudyBuddyServiceError(vscode.l10n.t('Set the Study Buddy access token before using Study Buddy tools.'));
	}
	return new StudyBuddyClient(serviceUrl.toString(), authorization);
}
