import { BasePromptElementProps, PromptElement } from '@vscode/prompt-tsx';
import { IRunCommandExecutionService } from '../../../../platform/commands/common/runCommandExecutionService';
import { Tag } from '../base/tag';

interface RuntimeMemoryProps extends BasePromptElementProps { readonly sessionResource?: string }

/** Loads the runtime's persisted, frozen memory prefix for each ordinary agent conversation. */
export class RuntimeMemoryPrompt extends PromptElement<RuntimeMemoryProps> {
	constructor(props: RuntimeMemoryProps, @IRunCommandExecutionService private readonly commands: IRunCommandExecutionService) { super(props); }

	async render() {
		if (!this.props.sessionResource) { return undefined; }
		try {
			await this.commands.executeCommand('latent.runtime.api.ensureStarted');
			const context: string = await this.commands.executeCommand('latent.runtime.api.memoryPrompt', this.props.sessionResource);
			return <Tag name='persistent_memory'>{context}</Tag>;
		} catch {
			// Other products and disabled runtimes do not contribute this optional memory provider.
			return undefined;
		}
	}
}
