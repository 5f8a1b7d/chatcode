(function () {
	'use strict';
	const vscode = acquireVsCodeApi();
	const app = document.getElementById('app');
	let catalog;
	let saved;
	let category = 'token-plan';
	let selected = '';
	let planTab = 'llm';
	let discovered = {};
	let capabilities = {};
	const capabilityLabels = { text: 'Text generation', imageUnderstanding: 'Image understanding', asr: 'Speech recognition (ASR)', tts: 'Speech synthesis (TTS)', realtimeVoice: 'Realtime voice' };

	const element = (tag, className, label) => {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (label !== undefined) node.textContent = label;
		return node;
	};
	const button = (label, className, click) => {
		const node = element('button', className, label);
		node.type = 'button';
		node.addEventListener('click', click);
		return node;
	};
	const field = (parent, label, value, type = 'text', placeholder = '') => {
		const wrapper = element('label', 'field');
		wrapper.append(element('span', 'field-label', label));
		const input = element('input', 'input');
		input.type = type;
		input.value = value || '';
		input.placeholder = placeholder;
		wrapper.append(input);
		parent.append(wrapper);
		return input;
	};
	const select = (parent, label, values, current) => {
		const wrapper = element('label', 'field');
		wrapper.append(element('span', 'field-label', label));
		const input = element('select', 'input');
		for (const option of values) {
			const row = element('option', '', option.name || option.id);
			row.value = option.id;
			input.append(row);
		}
		if (current) input.value = current;
		wrapper.append(input);
		parent.append(wrapper);
		return input;
	};
	const providerIdentity = provider => `${provider.service}:${provider.id}`;
	const providersInCategory = () => catalog.providers.filter(provider => provider.category === category);
	const plansInGroup = group => catalog.tokenPlans.filter(plan => plan.category === group.id);
	const showStatus = (message, error = false) => {
		const status = document.getElementById('status');
		if (status) {
			status.textContent = message;
			status.className = error ? 'status error' : 'status';
		}
	};

	function render() {
		if (!catalog || !saved) return;
		app.replaceChildren();
		const shell = element('div', 'shell');
		const nav = element('nav', 'nav');
		const heading = element('div', 'nav-heading', 'PROVIDERS');
		nav.append(heading);
		for (const entry of [...catalog.categories].sort((a, b) => a.order - b.order)) {
			const count = entry.id === 'token-plan' ? catalog.tokenPlans.length : catalog.providers.filter(provider => provider.category === entry.id).length;
			const item = button(entry.label, `nav-item ${entry.id === category ? 'active' : ''}`, () => {
				category = entry.id;
				selected = '';
				render();
			});
			item.append(element('span', 'count', String(count)));
			nav.append(item);
		}
		const capabilitiesItem = button('Capabilities', `nav-item ${category === 'capabilities' ? 'active' : ''}`, () => { category = 'capabilities'; selected = ''; render(); });
		capabilitiesItem.append(element('span', 'count', String(Object.values(capabilities).filter(list => list.length).length)));
		nav.append(capabilitiesItem);
		const list = element('aside', 'list');
		list.append(element('div', 'list-title', category === 'token-plan' ? 'Plans' : category === 'capabilities' ? 'Capabilities' : 'Catalog'));
		if (category === 'capabilities') {
			for (const [capability, label] of Object.entries(capabilityLabels)) {
				const item = button(label, `list-item ${selected === capability ? 'active' : ''}`, () => { selected = capability; render(); });
				if ((capabilities[capability] || []).some(entry => entry.isDefault)) item.append(element('span', 'dot'));
				list.append(item);
			}
		} else if (category === 'token-plan') {
			for (const group of [...catalog.providerGroups].sort((a, b) => a.order - b.order)) {
				const plans = plansInGroup(group);
				if (!plans.length) continue;
				list.append(element('div', 'list-group', group.label));
				for (const plan of plans) {
					const item = button(plan.name, `list-item ${selected === plan.id ? 'active' : ''}`, () => { selected = plan.id; planTab = Object.keys(plan.modalities)[0] || 'llm'; render(); });
					if (saved.plans[plan.id]) item.append(element('span', 'dot'));
					list.append(item);
				}
			}
		} else {
			for (const provider of providersInCategory()) {
				const key = providerIdentity(provider);
				const item = button(provider.name, `list-item ${selected === key ? 'active' : ''}`, () => { selected = key; render(); });
				if (saved.providers[key]?.enabled) item.append(element('span', 'dot'));
				list.append(item);
			}
			list.append(button('+ Add provider', 'list-add', () => { selected = '__new__'; render(); }));
		}
		const detail = element('main', 'detail');
		const status = element('div', 'status');
		status.id = 'status';
		if (category === 'capabilities') {
			renderCapability(detail, capabilityLabels[selected] ? selected : Object.keys(capabilityLabels)[0]);
		} else if (category === 'token-plan') {
			const plan = catalog.tokenPlans.find(plan => plan.id === selected) || catalog.tokenPlans[0];
			if (plan) renderPlan(detail, plan);
		} else {
			if (selected === '__new__') renderCustomForm(detail);
			else {
				const provider = providersInCategory().find(provider => providerIdentity(provider) === selected) || providersInCategory()[0];
				if (provider) renderProvider(detail, provider);
			}
		}
		detail.append(status);
		shell.append(nav, list, detail);
		app.append(shell);
	}

	function renderCapability(detail, capability) {
		detail.append(element('div', 'eyebrow', 'CAPABILITY'), element('h1', '', capabilityLabels[capability]));
		const entries = capabilities[capability] || [];
		if (!entries.length) {
			detail.append(element('p', 'subtle', 'No enabled provider serves this capability. Enable a provider under its category, or add a custom provider.'));
			const hint = element('section', 'card');
			const target = capability === 'text' || capability === 'imageUnderstanding' ? 'llm' : capability === 'realtimeVoice' ? 'realtime' : capability;
			hint.append(button(`Open ${target.toUpperCase()} providers`, 'button primary', () => { category = target; selected = ''; render(); }));
			detail.append(hint);
			return;
		}
		detail.append(element('p', 'subtle', 'The default binding is used whenever a feature asks for this capability without naming a provider.'));
		const card = element('section', 'card');
		card.append(element('h2', '', `Bindings · ${entries.length}`));
		const rows = element('div', 'model-rows');
		for (const entry of entries) {
			const row = element('div', 'model-row');
			row.append(element('span', 'model-name', `${entry.providerName} · ${entry.modelName}`), element('span', 'model-id', entry.modelId));
			if (entry.isDefault) row.append(element('span', 'model-badge', 'Default'));
			if (entry.requiresApiKey && !entry.hasSecret) row.append(element('span', 'model-badge', 'Credential missing'));
			row.append(button(entry.isDefault ? 'Clear default' : `Set as default for ${capabilityLabels[capability]}`, 'button secondary', () => {
				vscode.postMessage(entry.isDefault ? { type: 'setCapabilityDefault', capability } : { type: 'setCapabilityDefault', capability, providerId: entry.providerId, modelId: entry.modelId, source: entry.source, sourceId: entry.sourceId });
				showStatus('Saving default…');
			}));
			rows.append(row);
		}
		card.append(rows);
		detail.append(card);
	}

	function renderPlan(detail, plan) {
		const title = element('div', 'title-row');
		const text = element('div');
		text.append(element('div', 'eyebrow', 'TOKEN PLAN'), element('h1', '', plan.name));
		title.append(text);
		if (plan.websiteUrl) {
			const link = element('a', 'link', 'Provider site ↗');
			link.href = plan.websiteUrl;
			link.rel = 'noreferrer';
			link.target = '_blank';
			title.append(link);
		}
		detail.append(title, element('p', 'subtle', 'One credential can connect the services listed below. Each service keeps its own endpoint and models.'));
		const card = element('section', 'card');
		card.append(element('h2', '', 'Credential'));
		const key = field(card, 'API Key', '', 'password', saved.hasSecrets[`plan:${plan.id}`] ? 'Saved securely · enter to replace' : plan.apiKeyPlaceholder || 'Enter API key');
		const actions = element('div', 'actions');
		const enabled = saved.plans[plan.id] === true;
		actions.append(button(enabled ? 'Disable plan' : 'Enable plan', enabled ? 'button secondary' : 'button primary', () => {
			vscode.postMessage({ type: enabled ? 'disablePlan' : 'enablePlan', id: plan.id, secret: key.value });
			key.value = '';
			showStatus('Saving plan…');
		}));
		if (enabled) actions.append(button('Update key', 'button secondary', () => {
			if (!key.value.trim()) return showStatus('Enter a new key.', true);
			vscode.postMessage({ type: 'enablePlan', id: plan.id, secret: key.value });
			key.value = '';
			showStatus('Updating key…');
		}));
		card.append(actions);
		detail.append(card);
		const modalities = Object.entries(plan.modalities);
		const tabs = element('div', 'tabs');
		for (const [service] of modalities) tabs.append(button(service === 'webSearch' ? 'Web Search' : service.toUpperCase(), `tab ${planTab === service ? 'active' : ''}`, () => { planTab = service; render(); }));
		detail.append(element('h2', 'section-title', 'Included services'), tabs);
		const target = plan.modalities[planTab] || modalities[0]?.[1];
		if (target) {
			const panel = element('section', 'card');
			panel.append(element('div', 'eyebrow', planTab === 'webSearch' ? 'WEB SEARCH' : planTab.toUpperCase()));
			panel.append(element('h2', '', target.providerId));
			panel.append(element('div', 'meta', target.baseUrl));
			if (target.apiFormat) panel.append(element('div', 'meta', `Protocol: ${target.apiFormat}`));
			const models = target.defaultModels || (target.defaultModelId ? [target.defaultModelId] : []);
			if (models.length) {
				panel.append(element('div', 'field-label', `${models.length} models`));
				const rows = element('div', 'model-rows');
				for (const model of models) rows.append(element('div', 'model-row', model));
				panel.append(rows);
			}
			detail.append(panel);
		}
	}

	function renderProvider(detail, provider) {
		const identity = providerIdentity(provider);
		const config = saved.providers[identity] || {};
		detail.append(element('div', 'eyebrow', provider.service.toUpperCase()), element('h1', '', provider.name));
		const description = [provider.type ? `Protocol: ${provider.type}` : '', provider.requiresApiKey ? 'Credential required' : 'No credential required'].filter(Boolean).join(' · ');
		detail.append(element('p', 'subtle', description));
		const card = element('section', 'card');
		card.append(element('h2', '', 'Configuration'));
		const url = field(card, 'Base URL', config.baseUrl || provider.defaultBaseUrl || '', 'url', provider.baseUrlPlaceholder || 'https://…');
		if (provider.alternateBaseUrls?.length) {
			const chips = element('div', 'chips');
			for (const choice of provider.alternateBaseUrls) chips.append(button(choice.label, 'chip', () => { url.value = choice.url; }));
			card.append(chips);
		}
		const secret = provider.requiresApiKey ? field(card, provider.credentialLabel || 'API Key', '', 'password', saved.hasSecrets[identity] ? 'Saved securely · enter to replace' : 'Enter credential') : undefined;
		const extraSecretInputs = (provider.secretFields || []).map(entry => [entry.id, field(card, entry.label, '', 'password', saved.hasSecrets[`${identity}.${entry.id}`] ? 'Saved securely · enter to replace' : 'Enter credential')]);
		const modelNames = [...(provider.models || []), ...(config.customModelIds || []).map(id => ({ id, name: id })), ...(discovered[identity] || []).map(id => ({ id, name: id }))];
		const model = modelNames.length ? select(card, 'Model', modelNames, config.modelId || provider.defaultModelId || modelNames[0]?.id) : undefined;
		const customModel = ['llm', 'image', 'video', 'tts', 'asr', 'realtime'].includes(provider.service) ? field(card, 'Add Model ID', '', 'text', 'Optional custom model') : undefined;
		const extraInputs = [];
		for (const schema of catalog.serviceFieldSchemas?.[provider.service] || []) {
			const source = provider[schema.source];
			if (schema.type === 'select' && Array.isArray(source) && source.length) {
				const options = source.map(option => typeof option === 'object' ? { id: String(option.id), name: option.name || option.id } : { id: String(option), name: String(option) });
				extraInputs.push([schema.id, select(card, schema.label, options, config.fields?.[schema.id] || options[0].id)]);
			} else if (schema.type === 'number' && source && typeof source === 'object' && 'default' in source) {
				const control = field(card, schema.label, config.fields?.[schema.id] || String(source.default), 'number');
				if (source.min !== undefined) control.min = String(source.min);
				if (source.max !== undefined) control.max = String(source.max);
				extraInputs.push([schema.id, control]);
			} else if (schema.type === 'checkboxes' && Array.isArray(source) && source.length) {
				card.append(element('div', 'field-label', schema.label));
				for (const choice of source) {
					const row = element('label', 'switch-row');
					const control = element('input');
					control.type = 'checkbox';
					control.checked = config.fields?.[`source_${choice.id}`] !== 'false';
					row.append(control, element('span', '', choice.name || choice.id));
					card.append(row);
					extraInputs.push([`source_${choice.id}`, { get value() { return String(control.checked); } }]);
				}
			}
		}
		const check = element('label', 'switch-row');
		const enabled = element('input');
		enabled.type = 'checkbox';
		enabled.checked = config.enabled === true;
		check.append(enabled, element('span', '', 'Enabled'));
		card.append(check);
		const actions = element('div', 'actions');
		actions.append(button('Save', 'button primary', () => {
			const customIds = [...(config.customModelIds || [])];
			if (customModel?.value.trim() && !customIds.includes(customModel.value.trim())) customIds.push(customModel.value.trim());
			const fields = Object.fromEntries(extraInputs.map(([id, input]) => [id, input.value]));
			const extraSecrets = Object.fromEntries(extraSecretInputs.map(([id, input]) => [id, input.value]));
			vscode.postMessage({ type: 'saveProvider', service: provider.service, id: provider.id, secret: secret?.value, extraSecrets, config: { enabled: enabled.checked, baseUrl: url.value, modelId: model?.value || customModel?.value, customModelIds: customIds, fields } });
			if (secret) secret.value = '';
			for (const [, input] of extraSecretInputs) input.value = '';
			showStatus('Saving provider…');
		}));
		if (provider.service === 'llm' && provider.supportsModelDiscovery !== false && provider.type !== 'bedrock') actions.append(button('Discover models', 'button secondary', () => { vscode.postMessage({ type: 'probeModels', service: provider.service, id: provider.id }); showStatus('Fetching models…'); }));
		if (saved.hasSecrets[identity] || extraSecretInputs.some(([id]) => saved.hasSecrets[`${identity}.${id}`])) actions.append(button('Remove credentials', 'button danger', () => { vscode.postMessage({ type: 'deleteSecret', service: provider.service, id: provider.id }); showStatus('Removing credentials…'); }));
		if (provider.id.startsWith('custom-')) actions.append(button('Delete provider', 'button danger', () => {
			if (!window.confirm(`Delete ${provider.name}?`)) return;
			selected = '';
			vscode.postMessage({ type: 'removeCustom', service: provider.service, id: provider.id });
			showStatus('Deleting provider…');
		}));
		card.append(actions);
		detail.append(card);
		if (modelNames.length) {
			const modelCard = element('section', 'card');
			modelCard.append(element('h2', '', `Models · ${modelNames.length}`));
			const rows = element('div', 'model-rows');
			for (const entry of modelNames) {
				const row = element('div', 'model-row');
				row.append(element('span', 'model-name', entry.name || entry.id), element('span', 'model-id', entry.id));
				if (entry.contextWindow) row.append(element('span', 'model-badge', `${Math.round(entry.contextWindow / 1000)}k context`));
				if (entry.capabilities?.tools) row.append(element('span', 'model-badge', 'Tools'));
				if (entry.capabilities?.vision) row.append(element('span', 'model-badge', 'Vision'));
				rows.append(row);
			}
			modelCard.append(rows);
			detail.append(modelCard);
		}
		for (const [label, values] of [['Voices', provider.voices], ['Languages', provider.supportedLanguages], ['Formats', provider.supportedFormats], ['Features', provider.features]]) {
			if (!values?.length) continue;
			const item = element('section', 'card compact');
			item.append(element('h2', '', label));
			const tags = element('div', 'chips');
			for (const value of values) tags.append(element('span', 'chip static', typeof value === 'string' ? value : value.name || value.id));
			item.append(tags);
			detail.append(item);
		}
	}

	function renderCustomForm(detail) {
		detail.append(element('div', 'eyebrow', category.toUpperCase()), element('h1', '', 'Add custom provider'));
		const card = element('section', 'card');
		const name = field(card, 'Name', '', 'text', 'My provider');
		const protocol = category === 'llm'
			? select(card, 'Protocol', [{ id: 'openai', name: 'OpenAI Compatible' }, { id: 'anthropic', name: 'Anthropic' }, { id: 'google', name: 'Google Gemini' }, { id: 'azure', name: 'Azure OpenAI' }], 'openai')
			: category === 'realtime' ? select(card, 'Protocol', [{ id: 'openai-realtime', name: 'OpenAI Realtime Compatible' }], 'openai-realtime') : undefined;
		const url = field(card, 'Base URL', '', 'url', 'https://…');
		const model = ['llm', 'image', 'video', 'tts', 'asr', 'realtime'].includes(category) ? field(card, 'Model ID', '', 'text', 'Optional') : undefined;
		const secret = field(card, 'API Key', '', 'password', 'Saved securely');
		const check = element('label', 'switch-row');
		const needsKey = element('input');
		needsKey.type = 'checkbox';
		needsKey.checked = true;
		check.append(needsKey, element('span', '', 'Requires API key'));
		card.append(check);
		card.append(button('Add provider', 'button primary', () => {
			if (!name.value.trim()) return showStatus('Enter a name.', true);
			vscode.postMessage({ type: 'addCustom', category, name: name.value, protocol: protocol?.value, baseUrl: url.value, modelId: model?.value, requiresApiKey: needsKey.checked, secret: secret.value });
			secret.value = '';
			showStatus('Adding provider…');
		}));
		detail.append(card);
	}

	window.addEventListener('message', event => {
		const message = event.data;
		if (message.type === 'init') {
			catalog = message.catalog; saved = message.state; capabilities = message.capabilities || {};
			if (message.focusCapability) { category = 'capabilities'; selected = message.focusCapability; }
			render(); showStatus('Saved');
		}
		else if (message.type === 'added') selected = message.key;
		else if (message.type === 'models') { discovered[message.key] = message.models; render(); showStatus(`${message.models.length} models found`); }
		else if (message.type === 'error') showStatus(message.message, true);
	});
	vscode.postMessage({ type: 'ready' });
})();
