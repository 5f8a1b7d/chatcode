/** Minimal server-sent-events decoder shared by the streaming adapters. */
export class SseDecoder {
	private buffer = '';

	accept(text: string): string[] {
		const combined = this.buffer + text;
		const hasTrailingCarriageReturn = combined.endsWith('\r');
		const completeText = hasTrailingCarriageReturn ? combined.slice(0, -1) : combined;
		this.buffer = completeText.replaceAll('\r\n', '\n').replaceAll('\r', '\n') + (hasTrailingCarriageReturn ? '\r' : '');
		const result: string[] = [];
		let boundary = this.buffer.indexOf('\n\n');
		while (boundary >= 0) {
			const block = this.buffer.slice(0, boundary);
			this.buffer = this.buffer.slice(boundary + 2);
			const data = block
				.split('\n')
				.filter(line => line.startsWith('data:'))
				.map(line => line.slice(5).trimStart())
				.join('\n');
			if (data) {
				result.push(data);
			}
			boundary = this.buffer.indexOf('\n\n');
		}
		return result;
	}

	finish(): void {
		if (this.buffer.trim()) {
			throw new Error('The provider returned an incomplete stream event.');
		}
	}
}
