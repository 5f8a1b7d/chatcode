/* eslint-disable header/header */
import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

export const LatentSettings = {
	ThreadEditMode: 'latent.threads.editMode',
	DraftRetentionDays: 'latent.drafts.retentionDays',
	SessionsShowLegacyEntry: 'latent.sessions.showLegacyEntry',
	SelectionCommentEnabled: 'latent.selection.comment.enabled',
	RuntimeEnabled: 'latent.runtime.enabled',
	RuntimeBackgroundEnabled: 'latent.runtime.background.enabled',
	RuntimeApprovalTimeoutSeconds: 'latent.runtime.approvalTimeoutSeconds',
	FloatingWindowEnabled: 'latent.floatingWindow.enabled',
} as const;

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'latent',
	title: localize('latent.configuration.title', "Latent"),
	order: 200,
	properties: {
		[LatentSettings.ThreadEditMode]: {
			type: 'string',
			enum: ['branch', 'upstream'],
			enumDescriptions: [
				localize('latent.threads.editMode.branch', "Editing a message creates a new branch and keeps the original history."),
				localize('latent.threads.editMode.upstream', "Use the upstream behaviour: editing a message truncates the conversation at that point."),
			],
			default: 'branch',
			description: localize('latent.threads.editMode', "Controls what happens when a sent message is edited."),
		},
		[LatentSettings.DraftRetentionDays]: {
			type: 'number',
			minimum: 0,
			default: 7,
			description: localize('latent.drafts.retentionDays', "Days to keep the unsent draft of a closed tab."),
		},
		[LatentSettings.SessionsShowLegacyEntry]: {
			type: 'boolean',
			default: false,
			description: localize('latent.sessions.showLegacyEntry', "Show the upstream sessions entry in addition to the Sessions search view."),
		},
		[LatentSettings.SelectionCommentEnabled]: {
			type: 'boolean',
			default: false,
			description: localize('latent.selection.comment.enabled', "Show the Comment action for editor selections."),
		},
		[LatentSettings.RuntimeEnabled]: {
			type: 'boolean',
			default: true,
			description: localize('latent.runtime.enabled', "Start the Latent managed runtime that hosts gateways, bots, memory, and scheduled jobs."),
		},
		[LatentSettings.RuntimeBackgroundEnabled]: {
			type: 'boolean',
			default: false,
			description: localize('latent.runtime.background.enabled', "Keep the managed runtime running after the last window is closed and after the application quits."),
		},
		[LatentSettings.RuntimeApprovalTimeoutSeconds]: {
			type: 'number',
			minimum: 5,
			default: 120,
			description: localize('latent.runtime.approvalTimeoutSeconds', "Seconds before a pending bot tool approval is treated as denied."),
		},
		[LatentSettings.FloatingWindowEnabled]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('latent.floatingWindow.enabled', "Show the system-level floating window. This is the only place where it can be disabled."),
		},
	},
});
