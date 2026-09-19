/* eslint-disable header/header */
import type * as React from 'react';
import { IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { basename } from '../../../../../base/common/resources.js';
import { localize } from '../../../../../nls.js';
import { formatAttachmentNumberName, formatAttachmentNumberReference } from '../../common/attachmentNumbers.js';
import type { ComposerPluginIcon, IComposerPluginActivationContext, IComposerPluginSnapshot, IComposerSnapshot } from '../../common/composer/composerContracts.js';
import { ComposerModel } from '../../common/composer/composerModel.js';
import { loadReactRuntime } from '../reactRuntime.js';

type ClassValue = string | false | null | undefined;

let ReactRuntime: typeof React;

/** Tailwind-compatible class composition used by the local shadcn primitives. */
function cn(...values: ClassValue[]): string {
	return values.filter(Boolean).join(' ');
}

interface IButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
	readonly variant?: 'ghost' | 'primary';
	readonly size?: 'icon' | 'compact';
}

/** Local shadcn-style button primitive. */
function Button({ className, variant = 'ghost', size = 'icon', ...props }: IButtonProps): React.ReactElement {
	return ReactRuntime.createElement('button', {
		...props,
		'data-slot': 'button',
		className: cn(
			'inline-flex shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50',
			variant === 'primary' ? 'bg-primary text-primary-foreground hover:bg-primary-hover' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
			size === 'compact' ? 'h-8 gap-2 px-3' : 'size-8',
			className,
		),
	});
}

interface ITextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
	readonly textareaRef?: React.Ref<HTMLTextAreaElement>;
}

/** Local shadcn-style textarea primitive. */
function Textarea({ className, textareaRef, ...props }: ITextareaProps): React.ReactElement {
	return ReactRuntime.createElement('textarea', {
		...props,
		ref: textareaRef,
		'data-slot': 'textarea',
		className: cn('min-h-10 w-full resize-none bg-transparent text-foreground placeholder:text-muted-foreground focus-visible:outline-none disabled:cursor-not-allowed', className),
	});
}

const iconClassNames: Readonly<Record<ComposerPluginIcon, string>> = {
	add: 'codicon codicon-add-compact',
	mode: 'codicon codicon-agent-compact',
	model: 'codicon codicon-sparkle',
	tools: 'codicon codicon-settings-compact',
	voice: 'codicon codicon-mic',
	newThread: 'codicon codicon-comment-discussion',
	threads: 'codicon codicon-list-flat',
	fix: 'codicon codicon-lightbulb',
};

export interface ICompactComposerPluginActivationContext extends IComposerPluginActivationContext {
	readonly anchor?: HTMLElement;
}

interface IPluginButtonProps {
	readonly model: ComposerModel<ICompactComposerPluginActivationContext>;
	readonly plugin: IComposerPluginSnapshot;
}

function PluginButton({ model, plugin }: IPluginButtonProps): React.ReactElement {
	const state = plugin.state;
	const showsLabel = state.presentation === 'iconLabel';
	const iconClassName = iconClassNames[state.icon] ?? 'codicon codicon-extensions';
	return ReactRuntime.createElement(Button, {
		'aria-haspopup': state.dropdown ? 'menu' : undefined,
		'aria-label': state.label,
		'aria-pressed': state.active,
		className: state.active ? 'bg-accent text-foreground' : undefined,
		disabled: state.disabled,
		onClick: event => void model.activatePlugin(plugin.id, { source: 'toolbar', anchor: event.currentTarget }),
		size: showsLabel ? 'compact' : 'icon',
		title: state.label,
		type: 'button',
	},
		ReactRuntime.createElement('span', { 'aria-hidden': true, className: iconClassName }),
		showsLabel ? ReactRuntime.createElement('span', { className: 'max-w-40 truncate text-label' }, state.label) : null,
		showsLabel && state.dropdown ? ReactRuntime.createElement('span', { 'aria-hidden': true, className: 'codicon codicon-chevron-down-compact' }) : null,
	);
}

function useComposerSnapshot(model: ComposerModel<ICompactComposerPluginActivationContext>): IComposerSnapshot {
	const subscribe = ReactRuntime.useCallback((listener: () => void) => {
		const disposable = model.onDidChange(listener);
		return () => disposable.dispose();
	}, [model]);
	return ReactRuntime.useSyncExternalStore(subscribe, model.getSnapshot, model.getSnapshot);
}

function CompactComposer({ model, requestNativeCompletions }: { readonly model: ComposerModel<ICompactComposerPluginActivationContext>; readonly requestNativeCompletions?: () => void }): React.ReactElement {
	const snapshot = useComposerSnapshot(model);
	const textareaRef = ReactRuntime.useRef<HTMLTextAreaElement>(null);
	const [cursor, setCursor] = ReactRuntime.useState(0);
	const [suggestionsOpen, setSuggestionsOpen] = ReactRuntime.useState(false);
	const [selectedSuggestion, setSelectedSuggestion] = ReactRuntime.useState(0);
	const reference = snapshot.draft.text.slice(0, cursor).match(/(?:^|\s)#(\d*)$/);
	const suggestions = suggestionsOpen && reference ? snapshot.draft.attachments.filter(item => item.number !== undefined && String(item.number).startsWith(reference[1])) : [];
	const chooseReference = (number: number) => {
		const attachment = suggestions.find(item => item.number === number);
		if (!attachment) {
			return;
		}
		const start = cursor - (reference?.[1].length ?? 0) - 1;
		const inserted = `${formatAttachmentNumberReference(number, attachment.mimeType)} `;
		model.setText(snapshot.draft.text.slice(0, start) + inserted + snapshot.draft.text.slice(cursor));
		setSuggestionsOpen(false);
		requestAnimationFrame(() => { textareaRef.current?.focus(); textareaRef.current?.setSelectionRange(start + inserted.length, start + inserted.length); });
	};
	const header = snapshot.plugins.filter(plugin => plugin.placement === 'header');
	const leading = snapshot.plugins.filter(plugin => plugin.placement === 'leading');
	const trailing = snapshot.plugins.filter(plugin => plugin.placement === 'trailing');

	ReactRuntime.useLayoutEffect(() => {
		const textarea = textareaRef.current;
		if (!textarea) {
			return;
		}
		textarea.style.height = 'auto';
		textarea.style.height = `${textarea.scrollHeight}px`;
	}, [snapshot.draft.text]);

	const submit = (event: React.FormEvent) => {
		event.preventDefault();
		void model.submit();
	};

	const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (suggestions.length && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) {
			event.preventDefault();
			if (event.key === 'Escape') { setSuggestionsOpen(false); }
			else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { setSelectedSuggestion((selectedSuggestion + (event.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length); }
			else { chooseReference(suggestions[Math.min(selectedSuggestion, suggestions.length - 1)].number!); }
			return;
		}
		if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			void model.submit();
		}
	};

	return ReactRuntime.createElement('form', {
		'aria-label': localize('floatingComposer.label', "Floating Chat Composer"),
		className: 'flex w-full flex-col gap-1 rounded-outer border bg-card p-2 shadow-overlay',
		'data-composer-drag-handle': true,
		onSubmit: submit,
	},
	header.length ? ReactRuntime.createElement('div', { className: 'flex min-h-8 items-center gap-1' },
		...header.map(plugin => ReactRuntime.createElement(PluginButton, { key: plugin.id, model, plugin })),
	) : null,
	snapshot.draft.attachments.length ? ReactRuntime.createElement('div', {
		className: 'flex flex-wrap items-center gap-1',
	}, ...snapshot.draft.attachments.map(attachment => {
		const label = attachment.kind === 'context' ? attachment.label : (basename(attachment.resource) || attachment.resource.toString());
		const title = attachment.kind === 'context' ? (attachment.detail ?? attachment.label) : attachment.resource.toString();
		return ReactRuntime.createElement('span', {
			className: 'inline-flex min-w-0 items-center gap-1 rounded-full bg-accent px-2 py-1 text-label',
			key: attachment.id,
			title,
		},
		attachment.number !== undefined ? ReactRuntime.createElement('span', { className: 'composer-attachment-number' }, `${attachment.number}:`) : null,
		ReactRuntime.createElement('span', {
			'aria-hidden': true,
			className: attachment.kind === 'image' ? 'codicon codicon-file-media' : attachment.kind === 'context' ? 'codicon codicon-list-selection' : 'codicon codicon-file',
		}),
		ReactRuntime.createElement('span', { className: 'max-w-40 truncate' }, label),
		!attachment.isReadOnly ? ReactRuntime.createElement('button', {
			'aria-label': localize('floatingComposer.removeAttachment', "Remove {0}", label),
			className: 'inline-flex items-center justify-center text-muted-foreground hover:text-foreground',
			onClick: () => model.removeAttachment(attachment.id),
			type: 'button',
		}, ReactRuntime.createElement('span', { 'aria-hidden': true, className: 'codicon codicon-close' })) : null,
		);
	})) : null,
	ReactRuntime.createElement(Textarea, {
		'aria-label': localize('floatingComposer.input', "Chat Prompt"),
		autoFocus: false,
		disabled: snapshot.disabled,
		onChange: event => {
			model.setText(event.currentTarget.value);
			setCursor(event.currentTarget.selectionStart);
			setSuggestionsOpen(true);
			setSelectedSuggestion(0);
			if (/(?:^|\s)@$/.test(event.currentTarget.value.slice(0, event.currentTarget.selectionStart))) {
				requestNativeCompletions?.();
			}
		},
		onKeyDown,
		placeholder: localize('floatingComposer.placeholder', "Ask anything"),
		textareaRef,
		rows: 1,
		value: snapshot.draft.text,
	}),
	suggestionsOpen && reference ? ReactRuntime.createElement('div', { className: 'composer-suggestions', role: 'listbox', 'aria-label': localize('floatingComposer.references', "Context References") },
		...suggestions.map((item, index) => ReactRuntime.createElement('button', {
			key: item.id, type: 'button', role: 'option', 'aria-selected': index === selectedSuggestion,
			onMouseDown: event => event.preventDefault(), onClick: () => chooseReference(item.number!),
		}, formatAttachmentNumberName(item.number!, item.kind === 'context' ? item.label : basename(item.resource)))),
		requestNativeCompletions ? ReactRuntime.createElement('button', { type: 'button', onClick: () => { setSuggestionsOpen(false); requestNativeCompletions(); } }, localize('floatingComposer.moreContext', "More Context…")) : null,
	) : null,
	ReactRuntime.createElement('div', { className: 'flex items-center justify-between gap-2' },
		ReactRuntime.createElement('div', { className: 'flex items-center gap-1' },
			...leading.map(plugin => ReactRuntime.createElement(PluginButton, { key: plugin.id, model, plugin })),
		),
		ReactRuntime.createElement('div', { className: 'flex items-center gap-1' },
			...trailing.map(plugin => ReactRuntime.createElement(PluginButton, { key: plugin.id, model, plugin })),
			ReactRuntime.createElement(Button, {
				'aria-label': localize('floatingComposer.submit', "Send"),
				disabled: !model.canSubmit(),
				title: localize('floatingComposer.submit', "Send"),
				type: 'submit',
				variant: 'primary',
			}, ReactRuntime.createElement('span', {
				'aria-hidden': true,
				className: snapshot.submitting ? 'codicon codicon-loading codicon-modifier-spin' : 'codicon codicon-arrow-up',
			})),
		),
	),
	snapshot.diagnostics.length ? ReactRuntime.createElement('ul', { className: 'composer-diagnostics', role: 'alert' },
		...snapshot.diagnostics.map(diagnostic => ReactRuntime.createElement('li', { key: `${diagnostic.kind}-${diagnostic.number}` }, diagnostic.message)),
	) : null,
	snapshot.error ? ReactRuntime.createElement('span', { className: 'composer-error', role: 'alert' }, snapshot.error) : null,
	);
}

/** Mounts the React adapter and returns a VS Code lifecycle handle. */
export async function renderCompactComposer(container: HTMLElement, model: ComposerModel<ICompactComposerPluginActivationContext>, requestNativeCompletions?: () => void): Promise<IDisposable> {
	const runtime = await loadReactRuntime();
	ReactRuntime = runtime.React;
	const root = runtime.createRoot(container);
	root.render(ReactRuntime.createElement(CompactComposer, { model, requestNativeCompletions }));
	return toDisposable(() => root.unmount());
}
