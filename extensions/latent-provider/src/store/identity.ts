export function providerKey(service: string, id: string): string {
	return `${service}:${id}`;
}
