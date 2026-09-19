/* eslint-disable header/header */
import { IAction } from '../../../../../base/common/actions.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../base/common/observable.js';
import { localize } from '../../../../../nls.js';
import { IChatExecuteActionContext, OpenModelPickerAction, OpenModePickerAction } from '../../../chat/browser/actions/chatExecuteActions.js';
import { ToggleChatSpeechToTextAction } from '../../../chat/browser/actions/chatSpeechToTextActions.js';
import { ConfigureToolsAction } from '../../../chat/browser/actions/chatToolActions.js';
import { IChatWidget } from '../../../chat/browser/chat.js';
import { ChatSpeechToTextState, IChatSpeechToTextService } from '../../../chat/browser/speechToText/chatSpeechToTextService.js';
import { IComposerPlugin, IComposerPluginState } from '../../common/composer/composerContracts.js';
import type { ICompactComposerPluginActivationContext } from './compactComposer.js';

const ATTACH_CONTEXT_ACTION_ID = 'workbench.action.chat.attachContext';
const VOICE_ACTION_IDS: ReadonlySet<string> = new Set(['agentsVoice.startVoiceInChat', 'agentsVoice.pttStopInChat', ToggleChatSpeechToTextAction.ID]);

type NativeComposerPlugin = IComposerPlugin<ICompactComposerPluginActivationContext>;

/**
 * Composer plugins that mirror the native controls of a chat widget's input: attach context,
 * mode and model pickers, tool configuration, and voice input. They only use the input's
 * public surface, so the upstream input does not know about composer renderers.
 */
export class NativeComposerPlugins extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());

	readonly plugins: readonly NativeComposerPlugin[];

	constructor(
		private readonly widget: IChatWidget,
		@IChatSpeechToTextService private readonly speechToTextService: IChatSpeechToTextService,
	) {
		super();
		const input = widget.input;
		this._register(input.onDidChangeToolbarActions(() => this._onDidChange.fire()));
		this._register(speechToTextService.onDidChangeState(() => this._onDidChange.fire()));
		this._register(autorun(reader => {
			input.selectedLanguageModel.read(reader);
			input.currentModeObs.read(reader).label.read(reader);
			this._onDidChange.fire();
		}));

		this.plugins = [
			this.actionPlugin('chat.quickAdd', 'header', 0, ATTACH_CONTEXT_ACTION_ID, () => ({ label: localize('chat.quickAdd', "Quick Add"), icon: 'add' })),
			this.actionPlugin('chat.addFiles', 'leading', 0, ATTACH_CONTEXT_ACTION_ID, () => ({ label: localize('chat.addFiles', "Add Files"), icon: 'add' })),
			this.plugin('chat.modePicker', 'leading', 10, () => ({
				label: input.currentModeObs.get().label.get(),
				icon: 'mode',
				presentation: 'iconLabel',
				dropdown: true,
				disabled: !this.findAction(id => id === OpenModePickerAction.ID),
			}), context => input.openModePicker(context?.anchor)),
			this.plugin('chat.modelPicker', 'trailing', 10, () => ({
				label: input.selectedLanguageModel.get()?.metadata.name ?? localize('chat.modelPicker.modelsLabel', "Models"),
				icon: 'model',
				presentation: 'iconLabel',
				dropdown: true,
				disabled: !this.findAction(id => id === OpenModelPickerAction.ID),
			}), context => input.openModelPicker(context?.anchor)),
			this.actionPlugin('chat.toolConfiguration', 'trailing', 20, ConfigureToolsAction.ID, action => ({
				label: action?.label ?? localize('chat.configureTools', "Configure Tools"),
				icon: 'tools',
			})),
			this.plugin('chat.voiceInput', 'trailing', 30, () => {
				const action = this.findAction(id => VOICE_ACTION_IDS.has(id));
				return {
					label: action?.label ?? localize('chat.voiceInput', "Voice Input"),
					icon: 'voice',
					disabled: !action?.enabled,
					active: action?.id === 'agentsVoice.pttStopInChat' || this.speechToTextService.state !== ChatSpeechToTextState.Idle,
				};
			}, () => this.runAction(this.findAction(id => VOICE_ACTION_IDS.has(id)))),
		];
	}

	private plugin(id: string, placement: NativeComposerPlugin['placement'], order: number, getState: () => IComposerPluginState, activate: NativeComposerPlugin['activate']): NativeComposerPlugin {
		return { id, placement, order, onDidChange: this._onDidChange.event, getState, activate };
	}

	/** A plugin that runs a native toolbar action and is disabled while the action is. */
	private actionPlugin(id: string, placement: NativeComposerPlugin['placement'], order: number, actionId: string, getState: (action: IAction | undefined) => Omit<IComposerPluginState, 'disabled'>): NativeComposerPlugin {
		return this.plugin(id, placement, order, () => {
			const action = this.findAction(candidate => candidate === actionId);
			return { ...getState(action), disabled: !action?.enabled };
		}, () => this.runAction(this.findAction(candidate => candidate === actionId)));
	}

	private findAction(matches: (id: string) => boolean): IAction | undefined {
		return this.widget.input.getToolbarActions().find(action => matches(action.id));
	}

	private async runAction(action: IAction | undefined): Promise<void> {
		await action?.run({ widget: this.widget } satisfies IChatExecuteActionContext);
	}
}
