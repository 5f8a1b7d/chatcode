const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const media = path.resolve(__dirname, '../media');
const source = path.join(media, 'provider-catalog.yaml');
const target = path.join(media, 'provider-catalog.json');
const catalog = yaml.load(fs.readFileSync(source, 'utf8'));
if (!catalog || catalog.schemaVersion !== 1 || !Array.isArray(catalog.providers) || !Array.isArray(catalog.tokenPlans)) {
	throw new Error('Invalid provider catalog');
}
const identities = new Set();
const categoryIds = new Set(catalog.categories.map(category => category.id));
for (const provider of catalog.providers) {
	if (!categoryIds.has(provider.category)) {
		throw new Error(`Unknown category ${provider.category}`);
	}
	const identity = `${provider.service}:${provider.id}`;
	if (identities.has(identity)) {
		throw new Error(`Duplicate provider ${identity}`);
	}
	identities.add(identity);
	const modelIds = new Set();
	for (const model of provider.models ?? []) {
		if (modelIds.has(model.id)) {
			throw new Error(`Duplicate model ${identity}/${model.id}`);
		}
		modelIds.add(model.id);
	}
}
for (const plan of catalog.tokenPlans) {
	for (const [service, targetProvider] of Object.entries(plan.modalities ?? {})) {
		if (!identities.has(`${service === 'webSearch' ? 'web-search' : service}:${targetProvider.providerId}`)) {
			throw new Error(`Unknown token plan target: ${plan.id}/${service}/${targetProvider.providerId}`);
		}
	}
}
const generated = JSON.stringify(catalog) + '\n';
if (process.argv.includes('--check')) {
	if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== generated) {
		throw new Error('provider-catalog.json is out of date; run npm run catalog:compile');
	}
} else {
	fs.writeFileSync(target, generated);
}
