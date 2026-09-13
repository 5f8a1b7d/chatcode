import type * as React from 'react';
import type { Root } from 'react-dom/client';
import { importAMDNodeModule } from '../../../../../../amdX.js';
import { IDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { basename } from '../../../../../../base/common/resources.js';
import { localize } from '../../../../../../nls.js';
import type { ComposerPluginIcon, IComposerPluginActivationContext, IComposerPluginSnapshot, IComposerSnapshot } from '../../../common/composer/composerContracts.js';
import { ComposerModel } from '../../../common/composer/composerModel.js';

type ClassValue = string | false | null | undefined;

let ReactRuntime: typeof React;

interface IReactDOMRuntime {
	createRoot(container: Element | DocumentFragment): Root;
}

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

function CompactComposer({ model }: { readonly model: ComposerModel<ICompactComposerPluginActivationContext> }): React.ReactElement {
	const snapshot = useComposerSnapshot(model);
	const textareaRef = ReactRuntime.useRef<HTMLTextAreaElement>(null);
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
		const label = basename(attachment.resource) || attachment.resource.toString();
		return ReactRuntime.createElement('span', {
			className: 'inline-flex min-w-0 items-center gap-1 rounded-full bg-accent px-2 py-1 text-label',
			key: attachment.id,
			title: attachment.resource.toString(),
		},
		ReactRuntime.createElement('span', {
			'aria-hidden': true,
			className: attachment.kind === 'image' ? 'codicon codicon-file-media' : 'codicon codicon-file',
		}),
		ReactRuntime.createElement('span', { className: 'max-w-40 truncate' }, label),
		ReactRuntime.createElement('button', {
			'aria-label': localize('floatingComposer.removeAttachment', "Remove {0}", label),
			className: 'inline-flex items-center justify-center text-muted-foreground hover:text-foreground',
			onClick: () => model.removeAttachment(attachment.id),
			type: 'button',
		}, ReactRuntime.createElement('span', { 'aria-hidden': true, className: 'codicon codicon-close' })),
		);
	})) : null,
	ReactRuntime.createElement(Textarea, {
		'aria-label': localize('floatingComposer.input', "Chat Prompt"),
		autoFocus: true,
		disabled: snapshot.disabled,
		onChange: event => model.setText(event.currentTarget.value),
		onKeyDown,
		placeholder: localize('floatingComposer.placeholder', "Ask anything"),
		textareaRef,
		rows: 1,
		value: snapshot.draft.text,
	}),
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
	snapshot.error ? ReactRuntime.createElement('span', { className: 'sr-only', role: 'alert' }, snapshot.error) : null,
	);
}

/** Mounts the React adapter and returns a VS Code lifecycle handle. */
export async function renderCompactComposer(container: HTMLElement, model: ComposerModel<ICompactComposerPluginActivationContext>): Promise<IDisposable> {
	ReactRuntime = await importAMDNodeModule<typeof React>('react', 'umd/react.production.min.js');
	const reactDOM = await importAMDNodeModule<IReactDOMRuntime>('react-dom', 'umd/react-dom.production.min.js', undefined, { react: ReactRuntime });
	const root = reactDOM.createRoot(container);
	root.render(ReactRuntime.createElement(CompactComposer, { model }));
	return toDisposable(() => root.unmount());
}
