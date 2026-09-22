/* eslint-disable header/header */
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ApprovalDecision, IBotConfig, IBotInput, ICapabilitySource, IGatewayConfig, IMemoryWriteOp, IModelBinding, IRecallOptions, IScheduledJob } from '../../../../../platform/latentRuntime/common/runtimeProtocol.js';
import { IMemoryComparisonEntry, IRuntimePluginRecord, MemoryComparisonDecision } from '../../../../../platform/latentRuntime/common/runtimePlugin.js';
import { LatentSettings } from '../latentConfiguration.js';
import { IManagedRuntimeService } from './managedRuntimeService.js';

/**
 * Extension-facing access to the Managed Runtime (spec 01 §4). Extensions call
 * `latent.runtime.api.<name>` through `vscode.commands.executeCommand`; renderer
 * code still reaches the runtime only through `IManagedRuntimeService` (P1-FR-101).
 * Every call except `state` and `ensureStarted` fails while the runtime is stopped
 * instead of starting it implicitly.
 */
type RuntimeApiHandler = (runtime: IManagedRuntimeService, ...args: never[]) => Promise<unknown>;

const handlers: Record<string, RuntimeApiHandler> = {
	listBots: runtime => runtime.listBots(),
	upsertBot: (runtime, config: IBotConfig) => runtime.upsertBot(config),
	removeBot: (runtime, id: string) => runtime.removeBot(id),
	interruptBot: (runtime, requestId: string) => runtime.interruptBot(requestId),
	runBot: (runtime, botId: string, input: IBotInput) => runtime.runBot(botId, input),
	registerBotPresets: (runtime, owner: string, bots: IBotConfig[]) => runtime.registerBotPresets(owner, bots),
	listBotPresets: runtime => runtime.listBotPresets(),
	restoreBotPresets: (runtime, filter?: { owner?: string; botIds?: string[] }) => runtime.restoreBotPresets(filter),
	listSessions: runtime => runtime.listSessions(),
	getSessionTurns: (runtime, sessionId: string) => runtime.getSessionTurns(sessionId),
	listApprovals: runtime => runtime.listApprovals(),
	respondToApproval: (runtime, id: string, decision: ApprovalDecision) => runtime.respondToApproval(id, decision),
	listQuestions: runtime => runtime.listQuestions(),
	respondToQuestion: (runtime, id: string, answers: Readonly<Record<string, string>>) => runtime.respondToQuestion(id, answers),
	listGateways: runtime => runtime.listGateways(),
	upsertGateway: (runtime, config: IGatewayConfig, secret?: string) => runtime.upsertGateway(config, secret),
	removeGateway: (runtime, id: string) => runtime.removeGateway(id),
	deliver: (runtime, gatewayId: string, chatId: string, text: string) => runtime.deliver(gatewayId, chatId, text),
	setModelBinding: (runtime, id: string, binding: IModelBinding) => runtime.setModelBinding(id, binding),
	listModelBindings: runtime => runtime.listModelBindings(),
	listCapabilities: runtime => runtime.listCapabilities(),
	installCapability: (runtime, source: ICapabilitySource) => runtime.installCapability(source),
	removeCapability: (runtime, id: string) => runtime.removeCapability(id),
	recall: (runtime, query: string, options?: IRecallOptions) => runtime.recall(query, options),
	memoryReview: (runtime, response?: string) => runtime.memoryReview(response),
	memoryCheckpoint: (runtime, sessionId: string, messages: { role: 'user' | 'assistant' | 'tool'; text: string }[]) => runtime.memoryCheckpoint(sessionId, messages),
	memoryPrompt: (runtime, sessionId: string) => runtime.memoryPrompt(sessionId),
	sessionSearch: (runtime, options: { query?: string; sessionId?: string; from?: number; to?: number }) => runtime.sessionSearch(options),
	memorySnapshot: runtime => runtime.memorySnapshot(),
	memoryWrite: (runtime, op: IMemoryWriteOp) => runtime.memoryWrite(op),
	memoryConfirm: (runtime, id: string, accept: boolean) => runtime.memoryConfirm(id, accept),
	listMemoryAdapters: runtime => runtime.listMemoryAdapters(),
	setMemoryAdapterEnabled: (runtime, id: string, enabled: boolean, secret?: string, baseUrl?: string) => runtime.setMemoryAdapterEnabled(id, enabled, secret, baseUrl),
	compareMemoryAdapter: (runtime, id: string) => runtime.compareMemoryAdapter(id),
	resolveMemoryComparison: (runtime, id: string, entry: IMemoryComparisonEntry, decision: MemoryComparisonDecision) => runtime.resolveMemoryComparison(id, entry, decision),
	listArtifacts: (runtime, filter?: { sessionId?: string; botId?: string }) => runtime.listArtifacts(filter),
	addArtifact: (runtime, artifact: { sessionId?: string; botId: string; name: string; content?: string; contentBase64?: string; mimeType?: string }) => runtime.addArtifact(artifact),
	listJobs: runtime => runtime.listJobs(),
	upsertJob: (runtime, job: IScheduledJob) => runtime.upsertJob(job),
	removeJob: (runtime, id: string) => runtime.removeJob(id),
	runJobNow: (runtime, id: string) => runtime.runJobNow(id),
	listJobExecutions: (runtime, jobId?: string) => runtime.listJobExecutions(jobId),
	registerPlugin: (runtime, record: IRuntimePluginRecord) => runtime.registerPlugin(record),
	listPlugins: runtime => runtime.listPlugins(),
	setPluginSecret: (runtime, pluginId: string, key: string, value?: string) => runtime.setPluginSecret(pluginId, key, value),
};

CommandsRegistry.registerCommand('latent.runtime.api.state', async (accessor: ServicesAccessor) => {
	const runtime = accessor.get(IManagedRuntimeService);
	return runtime.getState().catch(() => ({ connected: false }));
});

CommandsRegistry.registerCommand('latent.runtime.api.ensureStarted', async (accessor: ServicesAccessor) => {
	const runtime = accessor.get(IManagedRuntimeService);
	if (!accessor.get(IConfigurationService).getValue<boolean>(LatentSettings.RuntimeEnabled)) {
		throw new Error('The managed runtime is disabled (latent.runtime.enabled).');
	}
	return runtime.start();
});

for (const [name, handler] of Object.entries(handlers)) {
	CommandsRegistry.registerCommand(`latent.runtime.api.${name}`, async (accessor: ServicesAccessor, ...args: never[]) => {
		const runtime = accessor.get(IManagedRuntimeService);
		const state = await runtime.getState().catch(() => undefined);
		if (!state?.connected) {
			throw new Error('The managed runtime is not running.');
		}
		return handler(runtime, ...args);
	});
}
