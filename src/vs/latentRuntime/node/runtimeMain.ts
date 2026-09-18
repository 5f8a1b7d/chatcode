/* eslint-disable header/header */
import { appendFileSync, promises as fs } from 'fs';
import { join } from 'path';
import { RuntimeServer } from './runtimeServer.js';

/**
 * Entry point of the Managed Runtime process (spec 01 §2.8). Started by the
 * main-process supervisor or by the user-level service registration with
 * `--home <dir> --socket <path>`; the token is read from `<home>/runtime.token`.
 */
function argument(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
	const home = argument('--home');
	const socket = argument('--socket');
	if (!home || !socket) {
		throw new Error('Usage: runtimeMain --home <dir> --socket <path>');
	}
	await fs.mkdir(home, { recursive: true });
	const logFile = process.env['LATENT_RUNTIME_LOG'] ?? join(home, 'runtime.log');
	const log = (message: string) => {
		try {
			appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);
		} catch {
			// logging must never crash the runtime
		}
	};
	const token = (await fs.readFile(join(home, 'runtime.token'), 'utf8')).trim();
	const pidFile = join(home, 'runtime.pid');
	await fs.writeFile(pidFile, String(process.pid), 'utf8');
	const server = new RuntimeServer(home, token, log);
	const stop = () => void server.shutdown();
	process.on('SIGINT', stop);
	process.on('SIGTERM', stop);
	process.on('uncaughtException', error => log(`uncaught: ${error.stack ?? error.message}`));
	process.on('unhandledRejection', reason => log(`unhandled: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`));
	await server.start(socket);
}

main().catch(error => {
	process.stderr.write(`Latent runtime failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
	process.exit(1);
});
