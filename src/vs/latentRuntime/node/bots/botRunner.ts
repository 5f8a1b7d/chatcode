/* eslint-disable header/header */
import { randomUUID } from 'crypto';
import { ApprovalDecision, IBotConfig, IBotInput, IModelBinding, IRuntimeSessionRef, IRuntimeSessionTurn } from '../../../platform/latentRuntime/common/runtimeProtocol.js';
import { RuntimeDatabase } from '../runtimeDatabase.js';
import { authorizeToolCall } from './authorization.js';
import { ApprovalService } from './approvals.js';
import { builtinTools, IToolContext } from './tools.js';

interface IWireMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_call_id?: string; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }

export interface IBotRunResult {
	readonly session: IRuntimeSessionRef;
	readonly text: string;
}

export interface IBotRunnerHost {
	readonly approvals: ApprovalService;
	readonly modelBinding: (id: string) => IModelBinding | undefined;
	readonly toolContext: (bot: IBotConfig, session: IRuntimeSessionRef) => IToolContext;
	readonly onTurn: (session: IRuntimeSessionRef, turn: IRuntimeSessionTurn) => Promise<void>;
	readonly approvalTimeoutMs: number;
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
	private readonly running = new Set<string>();

	constructor(private readonly sessions: SessionStore, private readonly host: IBotRunnerHost) { }

	isRunning(botId: string): boolean {
		return this.running.has(botId);
	}

	async run(bot: IBotConfig, input: IBotInput, origin: IRuntimeSessionRef['origin']): Promise<IBotRunResult> {
		if (bot.execution.kind !== 'provider') {
			throw new Error('Harness execution is not available in the managed runtime yet; bind the bot to a provider model.');
		}
		const binding = this.host.modelBinding(bot.execution.modelBindingId);
		if (!binding) {
			throw new Error(`Bot ${bot.name} has no usable model binding (${bot.execution.modelBindingId}).`);
		}
		const session = (input.sessionId && await this.sessions.get(input.sessionId)) || await this.sessions.create(bot.id, input.text, origin);
		this.running.add(bot.id);
		try {
			const userTurn = await this.sessions.append(session.sessionId, 'user', input.text);
			await this.host.onTurn(session, userTurn);
			const history = await this.sessions.turns(session.sessionId);
			const messages: IWireMessage[] = [
				{ role: 'system', content: `${bot.systemPrompt}\n\nYou are ${bot.name}. Tools outside your authorization scope require the user's approval; if a call is denied, explain and continue.` },
				...history.filter(turn => turn.role !== 'tool').map((turn): IWireMessage => ({ role: turn.role === 'assistant' ? 'assistant' : 'user', content: turn.text })),
			];
			const context = this.host.toolContext(bot, session);
			const tools = Object.values(builtinTools).map(tool => ({ type: 'function' as const, function: { name: tool.definition.name, description: tool.definition.description, parameters: tool.definition.parameters } }));
			let finalText = '';
			for (let iteration = 0; iteration < 12; iteration++) {
				const reply = await this.complete(binding, messages, tools);
				if (reply.toolCalls.length === 0) {
					finalText = reply.text;
					break;
				}
				messages.push({ role: 'assistant', content: reply.text || null, tool_calls: reply.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) });
				for (const call of reply.toolCalls) {
					const result = await this.executeTool(bot, session, call, context, input);
					const toolTurn = await this.sessions.append(session.sessionId, 'tool', `${call.name}(${JSON.stringify(call.args).slice(0, 200)}) → ${result.slice(0, 500)}`);
					await this.host.onTurn(session, toolTurn);
					messages.push({ role: 'tool', tool_call_id: call.id, content: result.slice(0, 50_000) });
				}
			}
			const assistantTurn = await this.sessions.append(session.sessionId, 'assistant', finalText || '(no response)');
			await this.host.onTurn(session, assistantTurn);
			return { session: { ...session, updatedAt: assistantTurn.timestamp }, text: finalText };
		} finally {
			this.running.delete(bot.id);
		}
	}

	private async executeTool(bot: IBotConfig, session: IRuntimeSessionRef, call: { id: string; name: string; args: Record<string, unknown> }, context: IToolContext, input: IBotInput): Promise<string> {
		const tool = builtinTools[call.name];
		if (!tool) {
			return `Error: unknown tool ${call.name}`;
		}
		const decision = authorizeToolCall(bot.toolAuthorizationScope, call.name, call.args);
		if (!decision.allowed || !bot.toolAuthorizationScope.autoApprove) {
			const verdict: ApprovalDecision | 'timeout' = await this.host.approvals.request({
				botId: bot.id,
				sessionId: session.sessionId,
				tool: call.name,
				summary: `${call.name} ${JSON.stringify(call.args).slice(0, 200)}${decision.reason ? ` — ${decision.reason}` : ''}`,
				gatewayId: input.gatewayId,
				chatId: input.chatId,
			});
			if (verdict === 'deny' || verdict === 'timeout') {
				return `Denied: ${call.name} was not approved (${verdict === 'timeout' ? 'no answer within the approval window' : 'denied by the user'})${decision.reason ? `; ${decision.reason}` : ''}.`;
			}
		}
		try {
			return await tool.run(call.args, context);
		} catch (error) {
			return `Error: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	private async complete(binding: IModelBinding, messages: IWireMessage[], tools: object[]): Promise<{ text: string; toolCalls: { id: string; name: string; args: Record<string, unknown> }[] }> {
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
		const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ model: binding.modelId, messages, tools, stream: false }) });
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
