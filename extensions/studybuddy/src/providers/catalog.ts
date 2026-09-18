import * as vscode from 'vscode';
export { providerKey } from './identity';

export type ServiceId = 'llm' | 'image' | 'video' | 'tts' | 'asr' | 'pdf' | 'media-parse' | 'web-search';

export interface CatalogModel {
	id: string;
	name: string;
	contextWindow?: number;
	outputWindow?: number;
	capabilities?: { streaming?: boolean; tools?: boolean; vision?: boolean; thinking?: object };
}

export interface CatalogProvider {
	id: string;
	service: ServiceId;
	category: string;
	name: string;
	type?: string;
	defaultBaseUrl?: string;
	baseUrlPlaceholder?: string;
	alternateBaseUrls?: Array<{ label: string; url: string }>;
	requiresApiKey: boolean;
	credentialLabel?: string;
	secretFields?: Array<{ id: string; label: string }>;
	supportsModelDiscovery?: boolean;
	models?: CatalogModel[];
	defaultModelId?: string;
	voices?: Array<{ id: string; name: string; language?: string }>;
	supportedLanguages?: string[];
	supportedFormats?: string[];
	features?: string[];
	endpointPath?: string;
	[key: string]: object | string | number | boolean | undefined | string[] | CatalogModel[] | Array<{ label: string; url: string }> | Array<{ id: string; name: string; language?: string }>;
}

export interface TokenPlanTarget {
	providerId: string;
	baseUrl: string;
	apiFormat?: string;
	modelsUrl?: string;
	defaultModels?: string[];
	defaultModelId?: string;
}

export interface TokenPlan {
	id: string;
	name: string;
	category: string;
	websiteUrl?: string;
	apiKeyPlaceholder?: string;
	modalities: Record<string, TokenPlanTarget>;
}

export interface ProviderCatalog {
	schemaVersion: 1;
	categories: Array<{ id: string; label: string; order: number }>;
	providerGroups: Array<{ id: string; label: string; order: number }>;
	serviceFieldSchemas?: Record<string, Array<{ id: string; label: string; type: 'select' | 'number' | 'checkboxes'; source: string }>>;
	providers: CatalogProvider[];
	tokenPlans: TokenPlan[];
}

export async function loadProviderCatalog(extensionUri: vscode.Uri): Promise<ProviderCatalog> {
	const uri = vscode.Uri.joinPath(extensionUri, 'media', 'provider-catalog.json');
	const bytes = await vscode.workspace.fs.readFile(uri);
	const catalog: ProviderCatalog = JSON.parse(new TextDecoder().decode(bytes));
	if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.categories) || !Array.isArray(catalog.providers) || !Array.isArray(catalog.tokenPlans)) {
		throw new Error('Invalid provider catalog');
	}
	return catalog;
}
