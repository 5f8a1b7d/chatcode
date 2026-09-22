/* eslint-disable header/header */
import { randomUUID } from 'crypto';
import { ApprovalDecision, IBotAttachment, IBotConfig, IBotInput, IModelBinding, IRuntimeSessionRef, IRuntimeSessionTurn } from '../../../platform/latentRuntime/common/runtimeProtocol.js';
import { RuntimeDatabase } from '../runtimeDatabase.js';
import { authorizeToolCall } from './authorization.js';
import { ApprovalService } from './approvals.js';
import { IToolContext, ToolRegistry, wireToolName } from './tools.js';

type IWireContent = string | null | readonly ({ readonly type: 'text'; readonly text: string } | { readonly type: 'image_url'; readonly image_url: { readonly url: string } } | { readonly type: 'file'; readonly file: { readonly filename: string; readonly file_data: string } })[];
interface IWireMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: IWireContent; tool_call_id?: string; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }

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
	readonly approvals: ApprovalService;
	readonly tools: ToolRegistry;
	readonly bot: (id: string) => IBotConfig | undefined;
	readonly modelBinding: (id: string) => IModelBinding | undefined;
	readonly toolContext: (bot: IBotConfig, session: IRuntimeSessionRef) => IToolContext;
	readonly onTurn: (session: IRuntimeSessionRef, turn: IRuntimeSessionTurn) => Promise<void>;
	readonly approvalTimeoutMs: number;
	readonly reviewMemory?: (complete: (prompt: string, transcript: string) => Promise<string>, transcript: string, signal: AbortSignal) => Promise<void>;
	readonly systemContext?: (bot: IBotConfig, sessionId: string) => Promise<string>;
	readonly askUser?: (bot: IBotConfig, session: IRuntimeSessionRef, requestId: string, input: { readonly question?: string; readonly choices?: readonly string[]; readonly multiSelect?: boolean; readonly questions?: readonly { readonly id?: string; readonly question?: string; readonly choices?: readonly string[]; readonly multiSelect?: boolean }[] }, signal: AbortSignal) => Promise<string>;
	readonly log: (message: string) => void;
}

/** Sessions persisted in the runtime database. */
export class SessionStore {
	constructor(private readonly database: RuntimeDatabase) { }

	async create(botId: string, title: string, origin: IRuntimeSessionRef['origin']): Promise<IRuntimeSessionRef> {
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

	constructor(private readonly sessions: Pick<SessionStore, 'get' | 'create' | 'append' | 'turns'>, private readonly host: IBotRunnerHost) { }

	isRunning(botId: string): boolean {
		return this.running.has(botId);
	}

	interrupt(requestId: string): boolean {
		const controller = this.activeRequests.get(requestId);
		controller?.abort();
		return !!controller;
	}

	async run(bot: IBotConfig, input: IBotInput, origin: IRuntimeSessionRef['origin']): Promise<IBotRunResult> {
		if (bot.execution.kind !== 'provider') {
			throw new Error('Harness execution is not available in the managed runtime yet; bind the bot to a provider model.');
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
			const session = existing ?? await this.sessions.create(bot.id, input.title ?? displayText, origin);
			signal.throwIfAborted();
			if (this.activeSessions.has(session.sessionId)) { throw new Error('This conversation already has a running request.'); }
			this.memoryReviews.get(session.sessionId)?.abort();
			this.activeSessions.add(session.sessionId);
			this.running.set(bot.id, (this.running.get(bot.id) ?? 0) + 1);
			try {
				const userTurn = await this.sessions.append(session.sessionId, 'user', displayText);
				await this.host.onTurn(session, userTurn);
				const history = await this.sessions.turns(session.sessionId);
				const systemContext = await this.host.systemContext?.(bot, session.sessionId) ?? '';
				const messages: IWireMessage[] = [
					{ role: 'system', content: `${bot.systemPrompt}\n\nYou are ${bot.name}. Tools outside your authorization scope require the user's approval; if a call is denied, explain and continue.${this.handoffNote(bot)}\n\n${systemContext}` },
					...history.filter(turn => turn.role !== 'tool').map((turn): IWireMessage => ({ role: turn.role === 'assistant' ? 'assistant' : 'user', content: turn.seq === userTurn.seq ? wireUserContent(input.text, input.attachments) : turn.text })),
				];
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
				const tools = this.host.tools.all().map(tool => ({ type: 'function' as const, function: { name: wireToolName(tool.definition.name), description: tool.definition.description, parameters: tool.definition.parameters } }));
				let finalText = '';
				for (let iteration = 0; iteration < 12; iteration++) {
					const reply = await this.complete(binding, messages, tools, signal);
					signal.throwIfAborted();
					if (reply.toolCalls.length === 0) {
						finalText = reply.text;
						break;
					}
					messages.push({ role: 'assistant', content: reply.text || null, tool_calls: reply.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) });
					for (const call of reply.toolCalls) {
						const result = await this.executeTool(bot, session, call, context, input, signal);
						signal.throwIfAborted();
						const toolTurn = await this.sessions.append(session.sessionId, 'tool', `${this.host.tools.byWireName(call.name)?.definition.name ?? call.name}(${JSON.stringify(call.args).slice(0, 200)}) → ${result.slice(0, 20_000)}`);
						await this.host.onTurn(session, toolTurn);
						messages.push({ role: 'tool', tool_call_id: call.id, content: result.slice(0, 50_000) });
					}
				}
				signal.throwIfAborted();
				const assistantTurn = await this.sessions.append(session.sessionId, 'assistant', finalText || '(no response)');
				await this.host.onTurn(session, assistantTurn);
				// Hermes reviews after delivery, every ten user turns, excluding scheduled jobs.
				if (finalText && origin !== 'job' && bot.toolAuthorizationScope.autoApprove && bot.toolAuthorizationScope.allowTools.some(tool => tool === 'memory' || tool === 'memory_write' || tool === '*') && history.filter(turn => turn.role === 'user').length % 10 === 0 && this.host.reviewMemory) {
					const controller = new AbortController();
					this.memoryReviews.set(session.sessionId, controller);
					const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]);
					const transcript = [...history, assistantTurn].map(turn => `${turn.role}: ${turn.text}`).join('\n\n').slice(-60_000);
					void this.host.reviewMemory(async (prompt, evidence) => (await this.complete(binding, [{ role: 'system', content: prompt }, { role: 'user', content: evidence }], [], signal)).text, transcript, signal)
						.catch(error => { if (!signal.aborted) { this.host.log(`Memory review failed: ${String(error)}`); } })
						.finally(() => { if (this.memoryReviews.get(session.sessionId) === controller) { this.memoryReviews.delete(session.sessionId); } });
				}
				return { session: { ...session, updatedAt: assistantTurn.timestamp }, text: finalText };
			} finally {
				this.activeSessions.delete(session.sessionId);
				const remaining = (this.running.get(bot.id) ?? 1) - 1;
				if (remaining) { this.running.set(bot.id, remaining); } else { this.running.delete(bot.id); }
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

	private async complete(binding: IModelBinding, messages: IWireMessage[], tools: object[], signal?: AbortSignal): Promise<{ text: string; toolCalls: { id: string; name: string; args: Record<string, unknown> }[] }> {
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
		const response = await fetch(endpoint, { method: 'POST', headers, signal, body: JSON.stringify({ model: binding.modelId, messages, ...(tools.length ? { tools } : {}), stream: false }) });
		if (!response.ok) {
			throw new Error(`Model request failed: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
		}
		const payload = await response.json() as { choices?: { message?: { content?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] } }[] };
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
		return { text: message?.content ?? '', toolCalls };
	}
}
