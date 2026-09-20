/* eslint-disable header/header */
import { spawn } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { timeout } from '../../../base/common/async.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../../base/common/lifecycle.js';
import { FileAccess } from '../../../base/common/network.js';
import { equals } from '../../../base/common/objects.js';
import { isWindows } from '../../../base/common/platform.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { ILifecycleMainService } from '../../lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '../../log/common/log.js';
import { IProductService } from '../../product/common/productService.js';
import { IStateService } from '../../state/node/state.js';
import { ILatentRuntimeService } from '../common/latentRuntime.js';
import { IRuntimeState, RuntimeMethods, RuntimeNotification } from '../common/runtimeProtocol.js';
import { installBackgroundRegistration, removeBackgroundRegistration } from '../node/backgroundRegistration.js';
import { RuntimeClient } from '../node/runtimeClient.js';

const backgroundKey = 'latent.runtime.backgroundEnabled';
const RUNTIME_ENTRYPOINT = 'vs/latentRuntime/node/runtimeMain';

/**
 * Supervises the Managed Runtime process (spec 01 §2.8): starts it detached so
 * it can outlive the application, connects over the local socket, and
 * installs the user-level service registration for background mode.
 */
export class LatentRuntimeMainService extends Disposable implements ILatentRuntimeService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeState = this._register(new Emitter<IRuntimeState>());
	readonly onDidChangeState: Event<IRuntimeState> = this._onDidChangeState.event;
	private readonly _onDidNotify = this._register(new Emitter<RuntimeNotification>());
	readonly onDidNotify: Event<RuntimeNotification> = this._onDidNotify.event;

	private readonly client = this._register(new MutableDisposable<RuntimeClient>());
	private state: IRuntimeState;
	private starting: Promise<IRuntimeState> | undefined;

	constructor(
		@IEnvironmentMainService private readonly environmentMainService: IEnvironmentMainService,
		@IStateService private readonly stateService: IStateService,
		@IProductService private readonly productService: IProductService,
		@ILifecycleMainService lifecycleMainService: ILifecycleMainService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.state = { connected: false, backgroundEnabled: this.stateService.getItem<boolean>(backgroundKey, false), version: RUNTIME_ENTRYPOINT, gateways: [], nextJobRuns: [], pendingApprovals: 0 };
		this._register(lifecycleMainService.onWillShutdown(event => {
			if (!this.state.backgroundEnabled && this.client.value?.isConnected) {
				event.join('latentRuntime', this.client.value.call(RuntimeMethods.Shutdown).then(() => undefined, () => undefined));
			}
		}));
	}

	private get home(): string {
		return join(this.environmentMainService.userDataPath, 'latent', 'runtime');
	}

	/** Short, stable path: Unix domain socket paths are limited to about 100 characters. */
	private get socketPath(): string {
		const digest = createHash('sha256').update(this.home).digest('hex').slice(0, 16);
		if (isWindows) {
			return `\\\\.\\pipe\\latent-runtime-${digest}`;
		}
		return join(process.env['XDG_RUNTIME_DIR'] || tmpdir(), `latent-runtime-${digest}.sock`);
	}

	async getRuntimeHome(): Promise<string> {
		return this.home;
	}

	async getState(): Promise<IRuntimeState> {
		if (this.client.value?.isConnected) {
			try {
				// Background registration is owned here, not by the runtime process.
				const state = await this.client.value.call<IRuntimeState>(RuntimeMethods.GetState);
				this.setState({ ...state, connected: true, backgroundEnabled: this.state.backgroundEnabled });
			} catch {
				// fall through to the cached state
			}
		}
		return this.state;
	}

	start(): Promise<IRuntimeState> {
		if (this.client.value?.isConnected) {
			return this.getState();
		}
		this.starting ??= this.doStart().finally(() => this.starting = undefined);
		return this.starting;
	}

	private async doStart(): Promise<IRuntimeState> {
		await fs.mkdir(this.home, { recursive: true });
		const token = await this.ensureToken();
		let client = await this.tryConnect(token);
		if (!client) {
			this.spawnRuntime();
			for (let attempt = 0; attempt < 40 && !client; attempt++) {
				await timeout(250);
				client = await this.tryConnect(token);
			}
		}
		if (!client) {
			throw new Error('The Latent runtime did not start.');
		}
		this.client.value = client;
		this._register(client.onDidNotify(notification => {
			if (notification.kind === 'state') {
				this.setState(notification.state);
			}
			this._onDidNotify.fire(notification);
		}));
		this._register(client.onDidClose(() => this.setState({ ...this.state, connected: false })));
		const state = await client.call<IRuntimeState>(RuntimeMethods.GetState);
		this.setState({ ...state, connected: true, backgroundEnabled: this.state.backgroundEnabled });
		return this.state;
	}

	private async tryConnect(token: string): Promise<RuntimeClient | undefined> {
		try {
			return await RuntimeClient.connect(this.socketPath, token, 1500);
		} catch {
			return undefined;
		}
	}

	private async ensureToken(): Promise<string> {
		const path = join(this.home, 'runtime.token');
		try {
			const existing = (await fs.readFile(path, 'utf8')).trim();
			if (existing.length >= 32) {
				return existing;
			}
		} catch {
			// create below
		}
		const token = randomBytes(32).toString('hex');
		await fs.writeFile(path, token, { encoding: 'utf8', mode: 0o600 });
		return token;
	}

	private launchSpec(): { executable: string; args: string[]; env: Record<string, string> } {
		return {
			executable: process.execPath,
			args: [FileAccess.asFileUri('bootstrap-fork').fsPath, '--home', this.home, '--socket', this.socketPath],
			env: {
				ELECTRON_RUN_AS_NODE: '1',
				VSCODE_ESM_ENTRYPOINT: RUNTIME_ENTRYPOINT,
				VSCODE_HANDLES_UNCAUGHT_ERRORS: 'true',
				LATENT_RUNTIME_PRODUCT: this.productService.nameShort,
			},
		};
	}

	private spawnRuntime(): void {
		const spec = this.launchSpec();
		const logPath = join(this.home, 'runtime.log');
		try {
			const child = spawn(spec.executable, spec.args, {
				cwd: this.home,
				detached: true,
				stdio: 'ignore',
				env: { ...process.env, ...spec.env, LATENT_RUNTIME_LOG: logPath },
				windowsHide: true,
			});
			child.unref();
			this.logService.info(`[LatentRuntime] Spawned runtime pid ${child.pid}.`);
		} catch (error) {
			this.logService.error('[LatentRuntime] Unable to spawn the runtime.', error);
			throw error;
		}
	}

	async stop(): Promise<void> {
		if (this.client.value?.isConnected && !this.state.backgroundEnabled) {
			await this.client.value.call(RuntimeMethods.Shutdown).catch(() => undefined);
		}
		this.client.clear();
		this.setState({ ...this.state, connected: false });
	}

	async setBackgroundEnabled(enabled: boolean): Promise<IRuntimeState> {
		const label = `${this.productService.applicationName}.latent-runtime`;
		if (enabled) {
			const spec = this.launchSpec();
			await installBackgroundRegistration({ label, executable: spec.executable, args: spec.args, env: { ...spec.env, LATENT_RUNTIME_LOG: join(this.home, 'runtime.log') }, workingDirectory: this.home, logPath: join(this.home, 'runtime.log') });
		} else {
			await removeBackgroundRegistration(label, this.home);
		}
		this.stateService.setItem(backgroundKey, enabled);
		this.setState({ ...this.state, backgroundEnabled: enabled });
		return this.state;
	}

	async call<T>(method: string, params?: unknown): Promise<T> {
		if (!this.client.value?.isConnected) {
			await this.start();
		}
		return this.client.value!.call<T>(method, params);
	}

	/**
	 * Reading the state must not look like a change: listeners that refresh on
	 * `onDidChangeState` and read the state while refreshing would otherwise loop.
	 */
	private setState(state: IRuntimeState): void {
		if (equals(this.state, state)) {
			return;
		}
		this.state = state;
		this._onDidChangeState.fire(state);
	}
}
