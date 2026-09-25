/* eslint-disable header/header */
import { randomUUID } from 'crypto';
import { ApprovalDecision, IBotAttachment, IBotConfig, IBotInput, IModelBinding, IRuntimeSessionRef, IRuntimeSessionTurn } from '../../../platform/latentRuntime/common/runtimeProtocol.js';
import { RuntimeDatabase } from '../runtimeDatabase.js';
import { authorizeToolCall } from './authorization.js';
import { ApprovalService } from './approvals.js';
import { IToolContext, ToolRegistry, wireToolName } from './tools.js';
import { closePendingTools, compressContext, compressionFailed, compressionThreshold, ICompressionHost, ICompressionOptions, IContextMessage, IConversationContext, modelCompressionOptions, observeUsage, pricedContext, shouldCompress } from '../memory/contextCompression.js';
import { compressionPreview, IdleContextMaintenance, manualCompress, microCompact, parseCompressCommand, proactivePrune } from '../memory/contextMaintenance.js';
import { memoryCheckpoint } from '../memory/memoryLifecycle.js';
import { RecallIndex } from '../memory/recallIndex.js';

type IWireContent = string | null | readonly ({ readonly type: 'text'; readonly text: string } | { readonly type: 'image_url'; readonly image_url: { readonly url: string } } | { readonly type: 'file'; readonly file: { readonly filename: string; readonly file_data: string } })[];
type IWireMessage = IContextMessage;

export function wireUserContent(text: string, attachments: readonly IBotAttachment[] = []): IWireContent {
	if (!attachments.length) { return text; }
	return [
		{ type: 'text', text: text.trim() || 'Please inspect the attached content.' },
		...attachments.map(attachment => attachment.mimeType.startsWith('image/')
			? { type: 'image_url' as const, image_url: { url: attachment.dataUrl } }
			: { type: 'file' as const, file: { filename: attachment.name, file_data: attachment.dataUrl } }),
	];
}

export interface IBotRunResult {
	readonly session: IRuntimeSessionRef;
	readonly text: string;
}

export interface IBotRunnerHost {
	readonly runHarness?: (bot: IBotConfig, input: IBotInput, origin: IRuntimeSessionRef['origin']) => Promise<IBotRunResult>;
	readonly approvals: ApprovalService;
	readonly tools: ToolRegistry;
	readonly bot: (id: string) => IBotConfig | undefined;
	readonly modelBinding: (id: string) => IModelBinding | undefined;
	readonly toolContext: (bot: IBotConfig, session: IRuntimeSessionRef) => IToolContext;
	readonly onTurn: (session: IRuntimeSessionRef, turn: IRuntimeSessionTurn) => Promise<void>;
	readonly approvalTimeoutMs: number;
	readonly reviewMemory?: (complete: (prompt: string, transcript: string) => Promise<string>, transcript: string, signal: AbortSignal, bot: IBotConfig) => Promise<void>;
	readonly systemContext?: (bot: IBotConfig, sessionId: string, refresh?: boolean) => Promise<string>;
	readonly soul?: (bot: IBotConfig) => Promise<string>;
	readonly contextDatabase?: (bot: IBotConfig) => Promise<RuntimeDatabase>;
	readonly compressionOptions?: (bot: IBotConfig) => Promise<ICompressionOptions>;
	readonly askUser?: (bot: IBotConfig, session: IRuntimeSessionRef, requestId: string, input: { readonly question?: string; readonly choices?: readonly string[]; readonly multiSelect?: boolean; readonly questions?: readonly { readonly id?: string; readonly question?: string; readonly choices?: readonly string[]; readonly multiSelect?: boolean }[] }, signal: AbortSignal) => Promise<string>;
	readonly log: (message: string) => void;
}

/** Sessions persisted in the runtime database. */
export class SessionStore {
	private creationQueue: Promise<unknown> = Promise.resolve();
	private readonly appendQueues = new Map<string, Promise<unknown>>();
	constructor(private readonly database: RuntimeDatabase) { }

	create(botId: string, title: string, origin: IRuntimeSessionRef['origin']): Promise<IRuntimeSessionRef> {
		const pending = this.creationQueue.then(() => this.createSession(botId, title, origin));
		this.creationQueue = pending.catch(() => undefined);
		return pending;
	}

	private async createSession(botId: string, title: string, origin: IRuntimeSessionRef['origin']): Promise<IRuntimeSessionRef> {
		if (title === 'Bot Chat') {
			const existing = await this.database.get<{ id: string }>('SELECT id FROM sessions WHERE bot_id = ? AND title = ? ORDER BY updated_at DESC LIMIT 1', [botId, title]);
			if (existing) { return (await this.get(existing.id))!; }
		}
		const now = Date.now();
		const session: IRuntimeSessionRef = { sessionId: randomUUID(), botId, title: title.slice(0, 80), createdAt: now, updatedAt: now, origin };
		await this.database.run('INSERT INTO sessions (id, bot_id, title, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [session.sessionId, botId, session.title, origin, now, now]);
		return session;
	}

	async get(sessionId: string): Promise<IRuntimeSessionRef | undefined> {
		const row = await this.database.get<{ id: string; bot_id: string; title: string; origin: string; created_at: number; updated_at: number }>('SELECT * FROM sessions WHERE id = ?', [sessionId]);
		return row ? { sessionId: row.id, botId: row.bot_id, title: row.title, origin: row.origin as IRuntimeSessionRef['origin'], createdAt: row.created_at, updatedAt: row.updated_at } : undefined;
	}

	async list(): Promise<IRuntimeSessionRef[]> {
		const rows = await this.database.all<{ id: string; bot_id: string; title: string; origin: string; created_at: number; updated_at: number }>('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 500');
		return rows.map(row => ({ sessionId: row.id, botId: row.bot_id, title: row.title, origin: row.origin as IRuntimeSessionRef['origin'], createdAt: row.created_at, updatedAt: row.updated_at }));
	}

	async turns(sessionId: string): Promise<IRuntimeSessionTurn[]> {
		const rows = await this.database.all<{ seq: number; role: string; text: string; ts: number }>('SELECT seq, role, text, ts FROM turns WHERE session_id = ? ORDER BY seq', [sessionId]);
		return rows.map(row => ({ seq: row.seq, role: row.role as IRuntimeSessionTurn['role'], text: row.text, timestamp: row.ts }));
	}

	async append(sessionId: string, role: IRuntimeSessionTurn['role'], text: string): Promise<IRuntimeSessionTurn> {
		const pending = (this.appendQueues.get(sessionId) ?? Promise.resolve()).catch(() => undefined).then(() => this.appendTurn(sessionId, role, text));
		this.appendQueues.set(sessionId, pending);
		try { return await pending; } finally { if (this.appendQueues.get(sessionId) === pending) { this.appendQueues.delete(sessionId); } }
	}

	private async appendTurn(sessionId: string, role: IRuntimeSessionTurn['role'], text: string): Promise<IRuntimeSessionTurn> {
		const row = await this.database.get<{ next: number }>('SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM turns WHERE session_id = ?', [sessionId]);
		const turn: IRuntimeSessionTurn = { seq: row?.next ?? 0, role, text, timestamp: Date.now() };
		await this.database.run('INSERT INTO turns (session_id, seq, role, text, ts) VALUES (?, ?, ?, ?, ?)', [sessionId, turn.seq, role, text, turn.timestamp]);
		await this.database.run('UPDATE sessions SET updated_at = ? WHERE id = ?', [turn.timestamp, sessionId]);
		return turn;
	}
}

/** The agent loop of a Bot: model call, scoped tool execution with approvals, persisted turns (P1-FR-083). */
export class BotRunner {
	private readonly running = new Map<string, number>();
	private readonly activeSessions = new Set<string>();
	private readonly activeRequests = new Map<string, AbortController>();
	private readonly memoryReviews = new Map<string, AbortController>();
	private readonly maintenance = new IdleContextMaintenance();

	constructor(private readonly sessions: Pick<SessionStore, 'get' | 'create' | 'append' | 'turns'>, private readonly host: IBotRunnerHost) { }

	isRunning(botId: string): boolean {
		return this.running.has(botId);
	}

	interrupt(requestId: string): boolean {
		const controller = this.activeRequests.get(requestId);
		controller?.abort();
		return !!controller;
	}

	stop(): void {
		this.maintenance.stop();
		for (const controller of this.activeRequests.values()) { controller.abort(); }
		for (const controller of this.memoryReviews.values()) { controller.abort(); }
	}

	async run(bot: IBotConfig, input: IBotInput, origin: IRuntimeSessionRef['origin']): Promise<IBotRunResult> {
		if (bot.execution.kind !== 'provider') {
			if (this.host.runHarness) { return this.host.runHarness(bot, input, origin); }
			throw new Error('No harness client is attached.');
		}
		const binding = this.host.modelBinding(bot.execution.modelBindingId);
		if (!binding) {
			throw new Error(`Bot ${bot.name} has no usable model binding (${bot.execution.modelBindingId}).`);
		}
		const requestId = input.requestId ?? randomUUID();
		if (this.activeRequests.has(requestId)) { throw new Error('This request is already running.'); }
		const controller = new AbortController();
		const signal = controller.signal;
		this.activeRequests.set(requestId, controller);
		try {
			const existing = input.sessionId ? await this.sessions.get(input.sessionId) : undefined;
			if (input.sessionId && (!existing || existing.botId !== bot.id)) { throw new Error('The session does not belong to this bot.'); }
			const displayText = input.text.trim() || (input.attachments?.length ? `Attached: ${input.attachments.map(item => item.name).join(', ')}` : 'New conversation');
			let session = existing ?? await this.sessions.create(bot.id, input.title ?? displayText, origin);
			this.maintenance.cancel(session.sessionId);
			const reset = /^\/(new|reset)\s*$/i.test(input.text);
			if (reset && session.title !== 'Bot Chat') { return { session: existing ? await this.sessions.create(bot.id, bot.name, origin) : session, text: 'Started a new conversation. Profile memories are unchanged.' }; }
			const compact = /^\/(compact|compress)(?:\s+(.*))?$/i.exec(input.text);
			const command = parseCompressCommand(compact?.[2]);
			if (command.aggressive) { throw new Error("--aggressive is not supported; use '/compress here [N]' to preserve recent exchanges."); }
			const manualCompression = !!compact || reset;
			signal.throwIfAborted();
			if (this.activeSessions.has(session.sessionId)) { throw new Error('This conversation already has a running request.'); }
			this.memoryReviews.get(session.sessionId)?.abort();
			this.activeSessions.add(session.sessionId);
			const leasedSessions = [session.sessionId];
			this.running.set(bot.id, (this.running.get(bot.id) ?? 0) + 1);
			let state: IConversationContext | undefined;
			let database: RuntimeDatabase | undefined;
			const save = async () => { if (database && state) { await database.run('INSERT OR REPLACE INTO session_context (session_id, data) VALUES (?, ?)', [session.sessionId, JSON.stringify(state)]); } };
			try {
				database = await this.host.contextDatabase?.(bot);
				const userTurn = manualCompression ? undefined : await this.sessions.append(session.sessionId, 'user', displayText);
				if (userTurn) { await this.host.onTurn(session, userTurn); }
				const history = await this.sessions.turns(session.sessionId);
				const freshSystem = async (refresh = false) => `${await this.host.soul?.(bot) ?? bot.systemPrompt}\n\nYou are ${bot.name}. Tools outside your authorization scope require the user's approval; if a call is denied, explain and continue.${this.handoffNote(bot)}\n\n${await this.host.systemContext?.(bot, session.sessionId, refresh) ?? ''}`;
				const freshTools = () => this.host.tools.all().map(tool => ({ type: 'function' as const, function: { name: wireToolName(tool.definition.name), description: tool.definition.description, parameters: tool.definition.parameters } }));
				const stored = await database?.get<{ data: string }>('SELECT data FROM session_context WHERE session_id = ?', [session.sessionId]);
				const modelKey = `${binding.providerId}/${binding.modelId}/${binding.baseUrl}`;
				state = stored ? JSON.parse(stored.data) as IConversationContext : { version: 1, messages: [{ role: 'system', content: await freshSystem() }], tools: freshTools(), model: modelKey, through: -1, compressions: 0 };
				if (state.model !== modelKey) { state.model = modelKey; state.anchor = undefined; state.observed = false; state.awaitingUsage = false; state.retryAt = undefined; }
				closePendingTools(state.messages);
				for (const turn of history.filter(turn => turn.seq > state!.through)) {
					state.messages.push({ role: turn.role === 'user' ? 'user' : 'assistant', content: turn.seq === userTurn?.seq ? wireUserContent(input.text, input.attachments) : turn.role === 'tool' ? `[Historical tool result]\n${turn.text}` : turn.text });
					state.through = turn.seq;
				}
				if (manualCompression && command.preview) { return { session, text: compressionPreview(state, command) }; }
				await save();
				let window = binding.contextLength ?? 128_000;
				const options = modelCompressionOptions(await this.host.compressionOptions?.(bot) ?? {}, binding.providerId, binding.modelId);
				const compressionHost: ICompressionHost = {
					complete: (prompt, transcript, maxTokens, summarySignal) => this.summarize(binding, prompt, transcript, maxTokens, summarySignal, options),
					checkpoint: async messages => {
						if (!database) { if (options.checkpoint_required) { throw new Error('A durable context checkpoint is required.'); } return; }
						await new RecallIndex(database).index(memoryCheckpoint(`${session.sessionId}#compacted`, messages.filter(message => message.role !== 'system').map(message => ({ role: message.role as 'user' | 'assistant' | 'tool', text: JSON.stringify(message) }))));
					},
					refresh: async () => ({ system: await freshSystem(true), tools: freshTools() }),
				};
				const compress = async (force = false): Promise<boolean> => {
					if (!state || !force && !shouldCompress(state, window, binding.maxOutputTokens, options)) { return false; }
					try {
						const candidate = manualCompression ? await manualCompress(state, session.sessionId, window, compressionHost, signal, options, command) : await compressContext(state, session.sessionId, window, compressionHost, signal, options);
						if (!candidate) { state.retryAt = Date.now() + 300_000; await save(); return false; }
						signal.throwIfAborted();
						state = candidate;
						if (options.in_place === false && session.title !== 'Bot Chat') {
							const previous = session;
							session = await this.sessions.create(bot.id, previous.title, origin);
							this.activeSessions.add(session.sessionId); leasedSessions.push(session.sessionId);
							state.through = -1;
							const turn = await this.sessions.append(session.sessionId, 'assistant', `Context continued from ${previous.sessionId}. Original history remains searchable.`);
							await this.host.onTurn(session, turn); state.through = turn.seq;
						}
						if (options.progress_notices) { this.host.log(`Context compacted: ${session.sessionId} (${state.messages.length} working messages).`); }
						await save();
						return true;
					} catch (error) {
						signal.throwIfAborted();
						compressionFailed(state, error); await save();
						this.host.log(`Context compression failed; transcript retained: ${String(error)}`);
						if (force) { throw error; }
						return false;
					}
				};
				if (manualCompression) { const applied = await compress(true); return { session, text: applied ? 'Context compacted in this conversation. Original history remains available through session_search.' : 'No compressible history yet. The conversation and its memories are unchanged.' }; }
				const baseContext = this.host.toolContext(bot, session);
				const context: IToolContext = {
					...baseContext, signal,
					askUser: input => this.host.askUser ? this.host.askUser(bot, session, requestId, input, signal) : Promise.resolve('The user-question interface is unavailable.'),
					runBot: async (botId, childInput) => {
						signal.throwIfAborted();
						const childId = randomUUID();
						const abortChild = () => this.interrupt(childId);
						signal.addEventListener('abort', abortChild, { once: true });
						try { return await baseContext.runBot(botId, { ...childInput, requestId: childId }); }
						finally { signal.removeEventListener('abort', abortChild); }
					},
				};
				let finalText = '';
				let overflowAttempts = 0;
				for (let iteration = 0; iteration < 12; iteration++) {
					if (options.enabled !== false) {
						state = await proactivePrune(state, session.sessionId, window, compressionHost, signal, options) ?? state;
						state = await microCompact(state, session.sessionId, window, compressionHost, signal, options) ?? state;
						await save();
					}
					await compress();
					let reply: Awaited<ReturnType<BotRunner['complete']>>;
					while (true) {
						try { reply = await this.complete(binding, state.messages, state.tools, signal); break; }
						catch (error) {
							// Proven overflow bypasses the post-compression latch, but is bounded per turn.
							if (!/context[_ -]length|maximum context|too many tokens|prompt is too long/i.test(String(error)) || overflowAttempts++ >= (options.max_attempts ?? 3)) { throw error; }
							const reported = /maximum context length is ([\d,]+)/i.exec(String(error));
							if (reported) { const limit = Number(reported[1].replace(/,/g, '')); if (limit > 0) { window = Math.min(window, limit); } }
							if (!await compress(true)) { throw error; }
						}
					}
					signal.throwIfAborted();
					const messages = state.messages;
					if (reply.toolCalls.length === 0) {
						finalText = reply.text;
						messages.push({ role: 'assistant', content: finalText });
						observeUsage(state, reply.totalTokens);
						break;
					}
					messages.push({ role: 'assistant', content: reply.text || null, tool_calls: reply.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) });
					observeUsage(state, reply.totalTokens);
					await save();
					for (const call of reply.toolCalls) {
						const result = await this.executeTool(bot, session, call, context, input, signal);
						signal.throwIfAborted();
						const toolTurn = await this.sessions.append(session.sessionId, 'tool', `${this.host.tools.byWireName(call.name)?.definition.name ?? call.name}(${JSON.stringify(call.args)}) → ${result}`);
						await this.host.onTurn(session, toolTurn);
						messages.push({ role: 'tool', tool_call_id: call.id, content: result.slice(0, 50_000) });
						state.through = toolTurn.seq;
						await save();
					}
				}
				signal.throwIfAborted();
				const assistantTurn = await this.sessions.append(session.sessionId, 'assistant', finalText || '(no response)');
				await this.host.onTurn(session, assistantTurn);
				state.through = assistantTurn.seq;
				state.completedTurns = (state.completedTurns ?? 0) + 1; state.lastActivity = Date.now();
				await save();
				const hygiene = state.messages.length >= (options.hygiene_hard_message_limit ?? 5000);
				if (database && options.enabled !== false && (hygiene || (options.idle_compact_after_seconds ?? 0) > 0)) {
					const saved = JSON.stringify(state); const idleSession = session.sessionId;
					this.maintenance.schedule(idleSession, hygiene ? 1 : (options.idle_compact_after_seconds ?? 0) * 1000, async idleSignal => {
						if (!database || this.activeSessions.has(idleSession)) { return; }
						const snapshot: IConversationContext = JSON.parse(saved);
						if (Date.now() < (snapshot.retryAt ?? 0) || !hygiene && pricedContext(snapshot) <= compressionThreshold(window, binding.maxOutputTokens, options) * (options.target_ratio ?? 0.2)) { return; }
						try {
							const idleOptions = hygiene ? { ...options, context_timeout_seconds: options.hygiene_timeout_seconds ?? 30, context_total_ceiling_seconds: options.hygiene_total_ceiling_seconds ?? 600 } : options;
							const candidate = await compressContext(snapshot, idleSession, window, { ...compressionHost, complete: (prompt, evidence, tokens, abort) => this.summarize(binding, prompt, evidence, tokens, abort, idleOptions) }, idleSignal, idleOptions);
							idleSignal.throwIfAborted();
							if (candidate) { await database.run('UPDATE session_context SET data = ? WHERE session_id = ? AND data = ?', [JSON.stringify(candidate), idleSession, saved]); }
						} catch (error) {
							idleSignal.throwIfAborted(); compressionFailed(snapshot, error);
							snapshot.retryAt = Math.max(snapshot.retryAt ?? 0, Date.now() + (options.hygiene_failure_cooldown_seconds ?? 300) * 1000);
							await database.run('UPDATE session_context SET data = ? WHERE session_id = ? AND data = ?', [JSON.stringify(snapshot), idleSession, saved]); throw error;
						}
					}, error => this.host.log(`Idle context maintenance failed: ${String(error)}`));
				}
				// Hermes reviews after delivery, every ten user turns, excluding scheduled jobs.
				if (finalText && origin !== 'job' && bot.toolAuthorizationScope.autoApprove && bot.toolAuthorizationScope.allowTools.some(tool => tool === 'memory' || tool === 'memory_write' || tool === '*') && history.filter(turn => turn.role === 'user').length % 10 === 0 && this.host.reviewMemory) {
					const controller = new AbortController();
					this.memoryReviews.set(session.sessionId, controller);
					const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]);
					const transcript = [...history, assistantTurn].map(turn => `${turn.role}: ${turn.text}`).join('\n\n').slice(-60_000);
					void this.host.reviewMemory(async (prompt, evidence) => (await this.complete(binding, [{ role: 'system', content: prompt }, { role: 'user', content: evidence }], [], signal)).text, transcript, signal, bot)
						.catch(error => { if (!signal.aborted) { this.host.log(`Memory review failed: ${String(error)}`); } })
						.finally(() => { if (this.memoryReviews.get(session.sessionId) === controller) { this.memoryReviews.delete(session.sessionId); } });
				}
				return { session: { ...session, updatedAt: assistantTurn.timestamp }, text: finalText };
			} finally {
				try { if (state && !command.preview) { closePendingTools(state.messages); await save(); } }
				finally {
					for (const id of leasedSessions) { this.activeSessions.delete(id); }
					const remaining = (this.running.get(bot.id) ?? 1) - 1;
					if (remaining) { this.running.set(bot.id, remaining); } else { this.running.delete(bot.id); }
				}
			}
		} finally {
			this.activeRequests.delete(requestId);
		}
	}

	/** Tells the model which Bots it can hand work to; hand-off targets are not part of the stored prompt. */
	private handoffNote(bot: IBotConfig): string {
		const targets = (bot.handoffTargets ?? []).flatMap(id => {
			const target = this.host.bot(id);
			return target ? [`\`${id}\` (${target.name})`] : [];
		});
		return targets.length ? `\n\nYou work together with other Bots. Hand work to ${targets.join(', ')} with the \`handoff\` tool; the hand-off and its answer are recorded in your session.` : '';
	}

	private async executeTool(bot: IBotConfig, session: IRuntimeSessionRef, call: { id: string; name: string; args: Record<string, unknown> }, context: IToolContext, input: IBotInput, signal: AbortSignal): Promise<string> {
		signal.throwIfAborted();
		const tool = this.host.tools.byWireName(call.name);
		if (!tool) {
			return `Error: unknown tool ${call.name}`;
		}
		const name = tool.definition.name;
		const decision = authorizeToolCall(bot.toolAuthorizationScope, name, call.args);
		const floor = tool.approvalFloor?.(call.args);
		if (name !== 'ask_user' && (!decision.allowed || !bot.toolAuthorizationScope.autoApprove || floor)) {
			const reason = decision.reason ?? floor;
			const verdict: ApprovalDecision | 'timeout' = await this.host.approvals.request({
				botId: bot.id,
				requestId: input.requestId,
				sessionId: session.sessionId,
				tool: name,
				summary: `${name} ${JSON.stringify(call.args).slice(0, 200)}${reason ? ` — ${reason}` : ''}`,
				gatewayId: input.gatewayId,
				chatId: input.chatId,
			}, signal);
			signal.throwIfAborted();
			if (verdict === 'deny' || verdict === 'timeout') {
				return `Denied: ${name} was not approved (${verdict === 'timeout' ? 'no answer within the approval window' : 'denied by the user'})${reason ? `; ${reason}` : ''}.`;
			}
		}
		signal.throwIfAborted();
		try {
			return await tool.run(call.args, context);
		} catch (error) {
			return `Error: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	async summarize(binding: IModelBinding, prompt: string, transcript: string, maxTokens: number, signal: AbortSignal, options: ICompressionOptions = {}): Promise<{ text: string; truncated: boolean }> {
		// Prompt guidance, not a wire output cap: reasoning models need room to think before summarizing.
		const ids = [...new Set([options.summary_model_binding_id, '$main', ...options.fallback_model_binding_ids ?? []].filter((id): id is string => !!id))];
		let failure: unknown;
		for (const id of ids) {
			signal.throwIfAborted();
			const route = id === '$main' ? binding : this.host.modelBinding(id);
			if (!route) { failure = new Error(`Summary model binding not found: ${id}`); continue; }
			try {
				const result = await this.complete(route, [{ role: 'system', content: `${prompt}\nAim for about ${maxTokens} tokens of narrative summary, plus the detailed session log.` }, { role: 'user', content: transcript }], [], signal, 0, true, options);
				if (!result.text.trim() || result.truncated) { throw new Error(result.truncated ? 'Context summary was truncated' : 'Empty context summary'); }
				return result;
			} catch (error) { signal.throwIfAborted(); failure = error; }
		}
		throw failure ?? new Error('No summary route available');
	}

	private async complete(binding: IModelBinding, messages: IWireMessage[], tools: object[], signal?: AbortSignal, maxTokens = binding.maxOutputTokens, summaryStream = false, options: ICompressionOptions = {}): Promise<{ text: string; totalTokens?: number; truncated: boolean; toolCalls: { id: string; name: string; args: Record<string, unknown> }[] }> {
		if (binding.protocol !== 'openai' && binding.protocol !== 'azure') {
			throw new Error(`The managed runtime supports OpenAI-compatible bindings; ${binding.protocol} is not supported yet.`);
		}
		const base = binding.baseUrl.replace(/\/$/, '');
		const endpoint = binding.protocol === 'azure'
			? `${base.replace(/\/openai$/, '')}/openai/deployments/${encodeURIComponent(binding.modelId)}/chat/completions?api-version=2024-10-21`
			: `${base}/chat/completions`;
		const headers: Record<string, string> = { 'content-type': 'application/json' };
		if (binding.apiKey) {
			headers[binding.protocol === 'azure' ? 'api-key' : 'authorization'] = binding.protocol === 'azure' ? binding.apiKey : `Bearer ${binding.apiKey}`;
		}
		const idleController = new AbortController();
		let idle: ReturnType<typeof setTimeout> | undefined;
		const idleSeconds = options.context_timeout_seconds ?? 300;
		const progress = () => { if (idle) { clearTimeout(idle); } idle = setTimeout(() => idleController.abort(new Error('Summary inactivity timeout')), idleSeconds * 1000); };
		const requestSignal = summaryStream ? AbortSignal.any([...(signal ? [signal] : []), idleController.signal, AbortSignal.timeout(Math.max(idleSeconds, options.context_total_ceiling_seconds ?? 600) * 1000)]) : signal;
		if (summaryStream) { progress(); }
		try {
			const response = await fetch(endpoint, { method: 'POST', headers, signal: requestSignal, body: JSON.stringify({ model: binding.modelId, messages, ...(tools.length ? { tools } : {}), ...(maxTokens ? { max_tokens: maxTokens } : {}), stream: summaryStream }) });
			if (!response.ok) {
				throw new Error(`Model request failed: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
			}
			if (summaryStream && response.headers.get('content-type')?.includes('text/event-stream')) {
				if (!response.body) { throw new Error('Empty summary response body.'); }
				let text = ''; let buffer = ''; let truncated = false; let completed = false;
				const decoder = new TextDecoder();
				const consume = (line: string) => {
					if (!line.startsWith('data:')) { return; }
					const data = line.slice(5).trim(); if (!data) { return; } if (data === '[DONE]') { completed = true; return; }
					const chunk = JSON.parse(data) as { choices?: { delta?: { content?: string }; finish_reason?: string }[]; error?: { message?: string } };
					if (chunk.error) { throw new Error(chunk.error.message ?? 'Summary streaming failed.'); }
					text += chunk.choices?.[0]?.delta?.content ?? '';
					truncated ||= chunk.choices?.[0]?.finish_reason === 'length';
					completed ||= !!chunk.choices?.[0]?.finish_reason;
				};
				const reader = response.body.getReader();
				try {
					while (true) {
						const chunk = await reader.read(); if (chunk.done) { break; }
						progress(); buffer += decoder.decode(chunk.value, { stream: true });
						const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? '';
						for (const line of lines) { consume(line); }
						if (text.length + buffer.length > 2_000_000) { throw new Error('Summary response exceeded its safety limit.'); }
					}
					consume(buffer + decoder.decode());
				} finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
				requestSignal?.throwIfAborted();
				if (!completed) { throw new Error('Summary stream ended before completion; original context preserved.'); }
				return { text, truncated, toolCalls: [] };
			}
			const payload = await response.json() as { usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number }; choices?: { finish_reason?: string; message?: { content?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] } }[] };
			const message = payload.choices?.[0]?.message;
			const toolCalls = (message?.tool_calls ?? []).flatMap(call => {
				if (!call.function?.name) {
					return [];
				}
				let args: Record<string, unknown> = {};
				try {
					args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
				} catch {
					args = {};
				}
				return [{ id: call.id ?? randomUUID(), name: call.function.name, args }];
			});
			return { text: message?.content ?? '', toolCalls, totalTokens: payload.usage?.total_tokens ?? (payload.usage?.prompt_tokens ? payload.usage.prompt_tokens + (payload.usage.completion_tokens ?? 0) : undefined), truncated: payload.choices?.[0]?.finish_reason === 'length' };
		} finally { if (idle) { clearTimeout(idle); } }
	}
}
