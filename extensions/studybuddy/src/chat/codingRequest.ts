export function isCodingFileName(name: string): boolean {
	return /\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|swift|rb|php|cs|cpp|cc|c|h|json|yaml|yml|toml|sh|sql|vue|svelte)$/i.test(name);
}

/** Routes direct code changes while leaving document edits and explanations in Study Buddy. */
export function isCodingRequest(prompt: string, hasCodeFileContext = false): boolean {
	const text = prompt.trim();
	const directEdit = /^(?:(?:please|can you|could you)\s+)?(?:change|modify|edit|update|fix|convert|refactor|implement|create|add|remove|delete|rename)\b/i.test(text)
		|| /^(?:请|帮我)?(?:把|将|修改|编辑|更新|修复|转换|重构|实现|创建|添加|删除|重命名)/.test(text);
	const codeContext = hasCodeFileContext || /\b(?:code|function|class|module|repo|repository|project|typescript|javascript|python|api|component|script|test)\b|代码|函数|类|模块|项目|脚本|测试|接口/i.test(text)
		|| /\b\S+\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|swift|rb|php|cs|cpp|cc|c|h|json|yaml|yml|toml|sh|sql|vue|svelte)\b/i.test(text);
	return directEdit && codeContext;
}
