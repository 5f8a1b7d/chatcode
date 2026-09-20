/* eslint-disable header/header */
/** Port of Hermes tools/threat_patterns.py (strict memory scope). See specs/hermes-runtime-migration.md. */
const patterns = [
	{
		"pattern": "ignore\\s+(?:\\w+\\s+){0,8}(previous|all|above|prior)\\s+(?:\\w+\\s+){0,8}instructions",
		"id": "prompt_injection"
	},
	{
		"pattern": "system\\s+prompt\\s+override",
		"id": "sys_prompt_override"
	},
	{
		"pattern": "disregard\\s+(?:\\w+\\s+){0,8}(your|all|any)\\s+(?:\\w+\\s+){0,8}(instructions|rules|guidelines)",
		"id": "disregard_rules"
	},
	{
		"pattern": "act\\s+as\\s+(if|though)\\s+(?:\\w+\\s+){0,8}you\\s+(?:\\w+\\s+){0,8}(have\\s+no|don\\'t\\s+have)\\s+(?:\\w+\\s+){0,8}(restrictions|limits|rules)",
		"id": "bypass_restrictions"
	},
	{
		"pattern": "<!--[^>]{0,512}(?:ignore|override|system|secret|hidden)[^>]{0,512}-->",
		"id": "html_comment_injection"
	},
	{
		"pattern": "<\\s*div\\s+style\\s*=\\s*[\"\\'][^>]{0,2048}display\\s*:\\s*none",
		"id": "hidden_div"
	},
	{
		"pattern": "translate\\s+[^\\n]{0,512}\\s+into\\s+\\w+(?:[\\s-]+\\w+){0,2}\\s+and\\s+(execute|run|eval)\\b",
		"id": "translate_execute"
	},
	{
		"pattern": "do\\s+not\\s+(?:\\w+\\s+){0,8}tell\\s+(?:\\w+\\s+){0,8}the\\s+user",
		"id": "deception_hide"
	},
	{
		"pattern": "you\\s+are\\s+(?:\\w+\\s+){0,8}now\\s+(?:a|an|the)\\s+",
		"id": "role_hijack"
	},
	{
		"pattern": "pretend\\s+(?:\\w+\\s+){0,8}(you\\s+are|to\\s+be)\\s+",
		"id": "role_pretend"
	},
	{
		"pattern": "output\\s+(?:\\w+\\s+){0,8}(system|initial)\\s+prompt",
		"id": "leak_system_prompt"
	},
	{
		"pattern": "(respond|answer|reply)\\s+without\\s+(?:\\w+\\s+){0,8}(restrictions|limitations|filters|safety)",
		"id": "remove_filters"
	},
	{
		"pattern": "you\\s+have\\s+been\\s+(?:\\w+\\s+){0,8}(updated|upgraded|patched)\\s+to",
		"id": "fake_update"
	},
	{
		"pattern": "\\bname\\s+yourself\\s+\\w+",
		"id": "identity_override"
	},
	{
		"pattern": "register\\s+(as\\s+)?a?\\s*node",
		"id": "c2_node_registration"
	},
	{
		"pattern": "(heartbeat|beacon|check[\\s\\-]?in)\\s+(to|with)\\s+",
		"id": "c2_heartbeat"
	},
	{
		"pattern": "pull\\s+(down\\s+)?(?:new\\s+)?task(?:ing|s)?\\b",
		"id": "c2_task_pull"
	},
	{
		"pattern": "connect\\s+to\\s+the\\s+network\\b",
		"id": "c2_network_connect"
	},
	{
		"pattern": "you\\s+must\\s+(?:\\w+\\s+){0,3}(register|connect|report|beacon)\\b",
		"id": "forced_action"
	},
	{
		"pattern": "only\\s+use\\s+one[\\s\\-]?liners?\\b",
		"id": "anti_forensic_oneliner"
	},
	{
		"pattern": "never\\s+(?:\\w+\\s+){0,8}(?:create|write)\\s+(?:\\w+\\s+){0,8}(?:script|file)\\s+(?:\\w+\\s+){0,8}disk",
		"id": "anti_forensic_disk"
	},
	{
		"pattern": "unset\\s+\\w*(?:CLAUDE|CODEX|HERMES|AGENT|OPENAI|ANTHROPIC)\\w*",
		"id": "env_var_unset_agent"
	},
	{
		"pattern": "\\b(?:cobalt\\s*strike|sliver|havoc|mythic|metasploit|brainworm)\\b",
		"id": "known_c2_framework"
	},
	{
		"pattern": "\\bc2\\s+(?:server|channel|infrastructure|beacon)\\b",
		"id": "c2_explicit"
	},
	{
		"pattern": "\\bcommand\\s+and\\s+control\\b",
		"id": "c2_explicit_long"
	},
	{
		"pattern": "curl\\s+[^\\n]{0,2048}\\$\\{?\\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)S?\\b",
		"id": "exfil_curl"
	},
	{
		"pattern": "wget\\s+[^\\n]{0,2048}\\$\\{?\\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)S?\\b",
		"id": "exfil_wget"
	},
	{
		"pattern": "cat\\s+[^\\n]{0,2048}(\\.env|credentials|\\.netrc|\\.pgpass|\\.npmrc|\\.pypirc)",
		"id": "read_secrets"
	},
	{
		"pattern": "(send|post|upload|transmit)\\s+[^\\n]{0,2048}\\s+(to|at)\\s+https?://",
		"id": "send_to_url"
	},
	{
		"pattern": "(include|output|print|share)\\s+(?:\\w+\\s+){0,8}(conversation|chat\\s+history|previous\\s+messages|full\\s+context|entire\\s+context)",
		"id": "context_exfil"
	},
	{
		"pattern": "authorized_keys",
		"id": "ssh_backdoor"
	},
	{
		"pattern": "(?:\\b(?:echo|cat|cp|mv|dd|tee|install|printf|rsync|scp|ln|append|add|write|sed|chmod|chown|truncate|rm|touch|curl|wget|git)\\b|\\bopen\\s*\\(|>>?)[^\\n]{0,512}(?:\\$HOME/\\.ssh|~/\\.ssh)",
		"id": "ssh_access"
	},
	{
		"pattern": "\\$HOME/\\.hermes/\\.env|\\~/\\.hermes/\\.env",
		"id": "hermes_env"
	},
	{
		"pattern": "(update|modify|edit|write|change|append|add\\s+to)\\s+[^\\n]{0,2048}(?:AGENTS\\.md|CLAUDE\\.md|\\.cursorrules|\\.clinerules)",
		"id": "agent_config_mod"
	},
	{
		"pattern": "(update|modify|edit|write|change|append|add\\s+to)\\s+[^\\n]{0,2048}\\.hermes/(config\\.yaml|SOUL\\.md)",
		"id": "hermes_config_mod"
	},
	{
		"pattern": "(?:api[_-]?key|token|secret|password)\\s*[=:]\\s*[\"\\'][A-Za-z0-9+/=_-]{20,}",
		"id": "hardcoded_secret"
	}
].map(({ pattern, id }) => ({ regex: new RegExp(pattern, 'i'), id }));

export function memoryThreat(content: string): string | undefined {
	const text = content.slice(0, 65_536);
	if (/[\u200b-\u200d\u2060\u2062-\u2064\ufeff\u202a-\u202e\u2066-\u2069]/.test(text)) { return 'invisible_unicode'; }
	return patterns.find(({ regex }) => regex.test(text.normalize('NFKC')))?.id;
}
