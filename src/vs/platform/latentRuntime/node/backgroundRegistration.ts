/* eslint-disable header/header */
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface IBackgroundLaunchSpec {
	readonly label: string;
	readonly executable: string;
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string>>;
	readonly workingDirectory: string;
	readonly logPath: string;
}

function run(command: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => execFile(command, args, error => error ? reject(error) : resolve()));
}

function escapeXml(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Registers the runtime as a user-level service so it survives the application quitting (P1-FR-081). */
export async function installBackgroundRegistration(spec: IBackgroundLaunchSpec, platform: NodeJS.Platform = process.platform): Promise<string> {
	if (platform === 'darwin') {
		const path = join(homedir(), 'Library', 'LaunchAgents', `${spec.label}.plist`);
		const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
	<key>Label</key><string>${escapeXml(spec.label)}</string>
	<key>ProgramArguments</key><array>${[spec.executable, ...spec.args].map(arg => `<string>${escapeXml(arg)}</string>`).join('')}</array>
	<key>EnvironmentVariables</key><dict>${Object.entries(spec.env).map(([key, value]) => `<key>${escapeXml(key)}</key><string>${escapeXml(value)}</string>`).join('')}</dict>
	<key>WorkingDirectory</key><string>${escapeXml(spec.workingDirectory)}</string>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
	<key>StandardOutPath</key><string>${escapeXml(spec.logPath)}</string>
	<key>StandardErrorPath</key><string>${escapeXml(spec.logPath)}</string>
</dict></plist>
`;
		await fs.mkdir(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
		await fs.writeFile(path, plist, 'utf8');
		try {
			await run('launchctl', ['unload', path]);
		} catch {
			// not loaded yet
		}
		await run('launchctl', ['load', '-w', path]);
		return path;
	}
	if (platform === 'linux') {
		const directory = join(homedir(), '.config', 'systemd', 'user');
		const path = join(directory, `${spec.label}.service`);
		const unit = `[Unit]
Description=Latent managed runtime

[Service]
ExecStart=${[spec.executable, ...spec.args].map(arg => JSON.stringify(arg)).join(' ')}
WorkingDirectory=${spec.workingDirectory}
${Object.entries(spec.env).map(([key, value]) => `Environment=${JSON.stringify(`${key}=${value}`)}`).join('\n')}
Restart=on-failure
StandardOutput=append:${spec.logPath}
StandardError=append:${spec.logPath}

[Install]
WantedBy=default.target
`;
		await fs.mkdir(directory, { recursive: true });
		await fs.writeFile(path, unit, 'utf8');
		await run('systemctl', ['--user', 'daemon-reload']);
		await run('systemctl', ['--user', 'enable', '--now', `${spec.label}.service`]);
		return path;
	}
	if (platform === 'win32') {
		const command = `"${spec.executable}" ${spec.args.map(arg => `"${arg}"`).join(' ')}`;
		const scriptPath = join(spec.workingDirectory, `${spec.label}.cmd`);
		await fs.writeFile(scriptPath, `@echo off\r\n${Object.entries(spec.env).map(([key, value]) => `set "${key}=${value}"`).join('\r\n')}\r\ncd /d "${spec.workingDirectory}"\r\n${command} >> "${spec.logPath}" 2>&1\r\n`, 'utf8');
		await run('schtasks', ['/Create', '/F', '/SC', 'ONLOGON', '/TN', spec.label, '/TR', `"${scriptPath}"`]);
		await run('schtasks', ['/Run', '/TN', spec.label]);
		return scriptPath;
	}
	throw new Error(`Background registration is not supported on ${platform}.`);
}

export async function removeBackgroundRegistration(label: string, workingDirectory: string, platform: NodeJS.Platform = process.platform): Promise<void> {
	if (platform === 'darwin') {
		const path = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
		try {
			await run('launchctl', ['unload', '-w', path]);
		} catch {
			// not loaded
		}
		await fs.rm(path, { force: true });
		return;
	}
	if (platform === 'linux') {
		try {
			await run('systemctl', ['--user', 'disable', '--now', `${label}.service`]);
		} catch {
			// not enabled
		}
		await fs.rm(join(homedir(), '.config', 'systemd', 'user', `${label}.service`), { force: true });
		await run('systemctl', ['--user', 'daemon-reload']).catch(() => undefined);
		return;
	}
	if (platform === 'win32') {
		try {
			await run('schtasks', ['/Delete', '/F', '/TN', label]);
		} catch {
			// not registered
		}
		await fs.rm(join(workingDirectory, `${label}.cmd`), { force: true });
	}
}
