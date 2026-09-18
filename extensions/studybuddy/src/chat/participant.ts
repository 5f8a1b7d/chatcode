import * as vscode from 'vscode';

export const studyBuddyParticipantId = 'latentnote.studyBuddy.chat';

/** Fork-owned workbench command that opens an Agent Host session and sends the first request. */
const openAgentSessionCommand = 'latentnote.studyBuddy.openAgentSession';

/** Routes @studybuddy requests to the selected Agent Host harness. */
export function registerStudyBuddyParticipant(context: vscode.ExtensionContext): void {
	const participant = vscode.chat.createChatParticipant(studyBuddyParticipantId, (request, _chatContext, stream, token) => handleRequest(request, stream, token));
	participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'study-buddy.svg');
	context.subscriptions.push(participant);
}

async function handleRequest(
	request: vscode.ChatRequest,
	stream: vscode.ChatResponseStream,
	token: vscode.CancellationToken,
): Promise<vscode.ChatResult | void> {
	return sendToStudyBuddyAgent(request, stream, token);
}

async function sendToStudyBuddyAgent(request: vscode.ChatRequest, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatResult | void> {
	const commands = new Set(await vscode.commands.getCommands(true));
	const agents = [
		{ label: 'Codex', type: 'agent-host-codex', command: 'workbench.action.chat.openNewChatSessionInPlace.agent-host-codex' },
		{ label: 'Claude Code', type: 'agent-host-claude', command: 'workbench.action.chat.openNewChatSessionInPlace.agent-host-claude' },
	].filter(agent => commands.has(agent.command));
	if (!agents.length) {
		return { errorDetails: { message: vscode.l10n.t('No Agent Host is available. Enable a Codex or Claude Code session first.') } };
	}
	const selected = agents.length === 1 ? agents[0] : await vscode.window.showQuickPick(agents, {
		placeHolder: vscode.l10n.t('Choose a harness for Study Buddy'),
	});
	if (!selected || token.isCancellationRequested) {
		return;
	}
	const references = request.references
		.filter(reference => !reference.id.startsWith('vscode.instructions.'))
		.map(reference => {
			const value = reference.value;
			const uri = value instanceof vscode.Uri ? value : value instanceof vscode.Location ? value.uri : undefined;
			return uri ? { kind: 'file', id: `${reference.id}:${uri.toString()}`, name: uri.path.split('/').at(-1) || uri.toString(), value: uri } : undefined;
		})
		.filter((reference): reference is NonNullable<typeof reference> => reference !== undefined);
	const referencedFolder = references.map(reference => vscode.workspace.getWorkspaceFolder(reference.value)).find(folder => folder !== undefined);
	const activeFolder = vscode.window.activeTextEditor && vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri);
	const workingDirectory = referencedFolder?.uri ?? activeFolder?.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
	try {
		const session = await vscode.commands.executeCommand<vscode.Uri | undefined>(openAgentSessionCommand, {
			type: selected.type,
			prompt: agentPrompt(request),
			attachedContext: references,
			workingDirectory,
			customAgentName: 'Study Buddy',
		});
		if (!session) {
			return { errorDetails: { message: vscode.l10n.t('Could not start the Study Buddy agent in {0}.', selected.label) } };
		}
		stream.markdown(vscode.l10n.t('Opened a Study Buddy session in {0}. Continue there after the harness is authenticated to use learning and workspace tools.', selected.label));
		stream.reference(session);
	} catch (error) {
			return { errorDetails: { message: error instanceof Error ? error.message : vscode.l10n.t('Could not start Study Buddy.') } };
		}
}

function agentPrompt(request: vscode.ChatRequest): string {
	let prompt: string;
	switch (request.command) {
		case 'explain': prompt = `Explain this material step by step:\n\n${request.prompt}`; break;
		case 'translate': prompt = `Translate this material faithfully and preserve formulas:\n\n${request.prompt}`; break;
		case 'summarize': prompt = `Summarize this material and its key relationships:\n\n${request.prompt}`; break;
		default: prompt = request.prompt;
	}
	const context = request.references
		.filter(reference => !reference.id.startsWith('vscode.instructions.') && typeof reference.value === 'string')
		.map(reference => `${reference.id}: ${reference.value}`);
	return [prompt, ...context].join('\n\n');
}
