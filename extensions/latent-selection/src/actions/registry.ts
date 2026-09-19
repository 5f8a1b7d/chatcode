import * as vscode from 'vscode';
import type { IAddToNoteHandler, ISelectionActionDescriptor, ISelectionSnapshot } from '../api';

const registerCommand = '_latent.selection.registerActions';
const updateCommand = '_latent.selection.update';

/** Descriptor shape the workbench accepts (spec 02 §4, `latentSelectionActions`). */
interface IWorkbenchDescriptor {
	id: string;
	label: string;
	icon?: string;
	order: number;
	when?: string;
	showsResult?: boolean;
	command: string;
}

export interface IRunEvent {
	readonly actionId: string;
	readonly selection: ISelectionSnapshot;
}

/**
 * Keeps every action registered in this extension host and publishes the
 * descriptors to the workbench, which evaluates `when` per selection.
 */
export class SelectionActionRegistry implements vscode.Disposable {
	private readonly actions = new Map<string, ISelectionActionDescriptor>();
	private readonly noteHandlers = new Map<string, IAddToNoteHandler>();
	private readonly runEmitter = new vscode.EventEmitter<IRunEvent>();
	readonly onDidRunAction = this.runEmitter.event;
	private publishTimer: NodeJS.Timeout | undefined;

	constructor(private readonly handle: string, private readonly runCommand: string) { }

	register(descriptor: ISelectionActionDescriptor): vscode.Disposable {
		this.actions.set(descriptor.id, descriptor);
		this.schedulePublish();
		return new vscode.Disposable(() => {
			if (this.actions.get(descriptor.id) === descriptor) {
				this.actions.delete(descriptor.id);
				this.schedulePublish();
			}
		});
	}

	registerAddToNoteHandler(handler: IAddToNoteHandler): vscode.Disposable {
		this.noteHandlers.set(handler.id, handler);
		this.schedulePublish();
		return new vscode.Disposable(() => {
			this.noteHandlers.delete(handler.id);
			this.schedulePublish();
		});
	}

	hasNoteHandlers(): boolean {
		return this.noteHandlers.size > 0;
	}

	get(id: string): ISelectionActionDescriptor | undefined {
		return this.actions.get(id);
	}

	/** Runs the Add to Note handlers; the extension itself persists nothing (P2-FR-002). */
	async runAddToNote(selection: ISelectionSnapshot): Promise<void> {
		for (const handler of this.noteHandlers.values()) {
			await handler.handle(selection);
		}
	}

	async run(event: { actionId: string; action: string; selection: ISelectionSnapshot }): Promise<void> {
		const descriptor = this.actions.get(event.action);
		if (!descriptor) {
			throw new Error(`Unknown selection action ${event.action}`);
		}
		this.runEmitter.fire({ actionId: event.action, selection: event.selection });
		const source = new vscode.CancellationTokenSource();
		const report = (update: { phase: 'running' | 'succeeded' | 'failed'; text?: string; details?: string }) => {
			void vscode.commands.executeCommand(updateCommand, { selectionId: event.selection.selectionId, actionId: event.actionId, action: event.action, ...update });
		};
		try {
			await descriptor.run({ selection: event.selection, bar: { report }, token: source.token });
		} catch (error) {
			report({ phase: 'failed', text: error instanceof Error ? error.message : String(error) });
			throw error;
		} finally {
			source.dispose();
		}
	}

	descriptors(): IWorkbenchDescriptor[] {
		const list: IWorkbenchDescriptor[] = [...this.actions.values()].map(descriptor => ({
			id: descriptor.id,
			label: descriptor.title,
			icon: descriptor.icon,
			order: descriptor.order,
			when: descriptor.when,
			showsResult: descriptor.showsResult,
			command: this.runCommand,
		}));
		return list;
	}

	private schedulePublish(): void {
		if (this.publishTimer) {
			clearTimeout(this.publishTimer);
		}
		this.publishTimer = setTimeout(() => void this.publish(), 50);
	}

	async publish(): Promise<void> {
		try {
			await vscode.commands.executeCommand(registerCommand, this.handle, this.descriptors());
		} catch {
			// Stock VS Code has no Latent selection bar; actions stay reachable through commands.
		}
	}

	dispose(): void {
		if (this.publishTimer) {
			clearTimeout(this.publishTimer);
		}
		void vscode.commands.executeCommand(registerCommand, this.handle, []).then(undefined, () => undefined);
		this.runEmitter.dispose();
	}
}
