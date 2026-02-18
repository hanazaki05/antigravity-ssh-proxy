import * as vscode from 'vscode';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import { generateSetupScript, generateRollbackScript } from './remoteSetup';
import { StatusManager } from './statusManager';
import { DiagnosticPanel } from './diagnostics/diagnosticPanel';
import { TrafficPanel } from './traffic/trafficPanel';

const execAsync = promisify(exec);

let outputChannel: vscode.OutputChannel;
let statusManager: StatusManager;
let diagnosticPanel: DiagnosticPanel;
let trafficPanel: TrafficPanel;
const EXTENSION_ID = 'dinobot22.antigravity-ssh-proxy';

function log(message: string): void {
	const timestamp = new Date().toISOString();
	const location = isRunningLocally() ? '[LOCAL]' : '[REMOTE]';
	outputChannel?.appendLine(`${timestamp} ${location} ${message}`);
}

function isRunningLocally(): boolean {
	return !vscode.env.remoteName;
}

async function checkPortAvailable(host: string, port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = new net.Socket();
		socket.setTimeout(1000);
		socket.on('connect', () => { socket.destroy(); resolve(true); });
		socket.on('timeout', () => { socket.destroy(); resolve(false); });
		socket.on('error', () => { socket.destroy(); resolve(false); });
		socket.connect(port, host);
	});
}

/**
 * Check if mgraftcp is currently running (i.e., Language Server is using proxy)
 */
async function isMgraftcpRunning(): Promise<boolean> {
	try {
		const { stdout } = await execAsync('pgrep -f mgraftcp');
		return stdout.trim().length > 0;
	} catch {
		// pgrep returns non-zero if no process found
		return false;
	}
}

/**
 * Show reload window prompt with optional auto-reload after timeout
 */
function promptReloadWindow(message: string): void {
	vscode.window.showInformationMessage(
		message,
		'Reload Now',
		'Later'
	).then(selection => {
		if (selection === 'Reload Now') {
			vscode.commands.executeCommand('workbench.action.reloadWindow');
		}
	});
}

const ANTIGRAVITY_FILENAME = 'config.antigravity';
const INCLUDE_LINE = `Include ${ANTIGRAVITY_FILENAME}`;
const DEFAULT_ENABLE_LOCAL_FORWARDING = false;
const DEFAULT_LOCAL_PROXY_PORT = 7890;
const DEFAULT_REMOTE_PROXY_HOST = '127.0.0.1';
const DEFAULT_REMOTE_PROXY_PORT = 34380;
const DEFAULT_PROXY_TYPE = 'socks5';
const DEFAULT_FORWARDING_REMOTE_HOSTS: string[] = [];

function getConfiguredForwardingHosts(config: vscode.WorkspaceConfiguration): string[] {
	const raw = config.get<unknown>('forwardingRemoteHosts', DEFAULT_FORWARDING_REMOTE_HOSTS);
	if (!Array.isArray(raw)) {
		return [];
	}

	const cleaned = raw
		.filter((item): item is string => typeof item === 'string')
		.map(item => item.trim().replace(/[\r\n]/g, ''))
		.filter(item => item.length > 0);

	return Array.from(new Set(cleaned));
}

function getForwardingScopeLabel(hosts: string[]): string {
	return hosts.length > 0 ? hosts.join(', ') : 'all remotes (*)';
}

/**
 * Get path to SSH config directory based on platform
 */
function getSSHDir(): string {
	return path.join(os.homedir(), '.ssh');
}

/**
 * Get path to the main SSH config file
 */
function getSSHConfigPath(): string {
	return path.join(getSSHDir(), 'config');
}

/**
 * Get path to our custom SSH config file
 */
function getAntigravityConfigPath(): string {
	return path.join(getSSHDir(), ANTIGRAVITY_FILENAME);
}

/**
 * Update the SSH config files using the Include approach
 */
async function updateSSHConfigFile(
	remotePort: number,
	localPort: number,
	enable: boolean,
	forwardingRemoteHosts: string[] = []
): Promise<void> {
	const mainConfigPath = getSSHConfigPath();
	const antiConfigPath = getAntigravityConfigPath();

	try {
		// Ensure .ssh directory exists
		await fs.mkdir(getSSHDir(), { recursive: true });

		if (enable) {
			const hostSelector = forwardingRemoteHosts.length > 0 ? forwardingRemoteHosts.join(' ') : '*';
			const forwardingScope = getForwardingScopeLabel(forwardingRemoteHosts);

			// 1. Create/Update the config.antigravity file
			const antiContent = [
				'# Antigravity SSH Proxy Configuration',
				`# Generated at: ${new Date().toISOString()}`,
				`# Forwarding scope: ${forwardingScope}`,
				`Host ${hostSelector}`,
				`    RemoteForward ${remotePort} 127.0.0.1:${localPort}`,
				'    ExitOnForwardFailure no',
				'    VisualHostKey no',
				'',
			].join('\n');
			await fs.writeFile(antiConfigPath, antiContent, 'utf-8');
			log(`Updated ${antiConfigPath}`);

			// 2. Ensure Include line exists in main config
			let mainContent = '';
			try {
				mainContent = await fs.readFile(mainConfigPath, 'utf-8');
			} catch (e) { /* ignore if doesn't exist */ }

			if (!mainContent.includes(INCLUDE_LINE)) {
				// Prepend to the top for maximum compatibility
				mainContent = `${INCLUDE_LINE}\n${mainContent}`;
				await fs.writeFile(mainConfigPath, mainContent, 'utf-8');
				log(`Added Include line to ${mainConfigPath}`);
			}
		} else {
			// 1. Remove Include line from main config
			try {
				let mainContent = await fs.readFile(mainConfigPath, 'utf-8');
				if (mainContent.includes(INCLUDE_LINE)) {
					// Simply remove the Include line (we're the only one who writes it)
					mainContent = mainContent.replace(`${INCLUDE_LINE}\n`, '');
					mainContent = mainContent.replace(INCLUDE_LINE, ''); // fallback if no trailing newline
					await fs.writeFile(mainConfigPath, mainContent, 'utf-8');
					log(`Removed Include line from ${mainConfigPath}`);
				}
			} catch (e) { /* ignore */ }

			// 2. Delete the config.antigravity file
			try {
				await fs.unlink(antiConfigPath);
				log(`Deleted ${antiConfigPath}`);
			} catch (e) { /* ignore if already gone */ }
		}

		log(`SSH config updated (enable=${enable}, scope=${getForwardingScopeLabel(forwardingRemoteHosts)})`);
	} catch (error) {
		log(`SSH config update error: ${error}`);
		throw error;
	}
}

/**
 * Check if the forwarding is enabled by looking at the Include line and the sub-config
 */
async function getSSHConfigStatus(): Promise<{ enabled: boolean; port?: number }> {
	try {
		const mainContent = await fs.readFile(getSSHConfigPath(), 'utf-8');
		if (mainContent.includes(INCLUDE_LINE)) {
			const antiContent = await fs.readFile(getAntigravityConfigPath(), 'utf-8');
			const match = antiContent.match(/RemoteForward\s+(\d+)\s+(?:localhost|127\.0\.0\.1):/);
			if (match) {
				return { enabled: true, port: parseInt(match[1]) };
			}
		}
	} catch {
		// Files don't exist
	}
	return { enabled: false };
}

export function activate(context: vscode.ExtensionContext) {
	// In remote windows, avoid running the UI-host copy when the extension is dual-host.
	// Otherwise two hosts can race and overwrite each other's status-bar item state/order.
	const currentHostKind = vscode.extensions.getExtension(EXTENSION_ID)?.extensionKind;
	const isRemoteWindow = Boolean(vscode.env.remoteName);
	if (isRemoteWindow && currentHostKind === vscode.ExtensionKind.UI) {
		return;
	}

	// 创建专用的 Output Channel
	outputChannel = vscode.window.createOutputChannel('Antigravity SSH Proxy');
	context.subscriptions.push(outputChannel);

	log(`Activating... isLocal=${isRunningLocally()}`);

	// 初始化状态管理器
	statusManager = new StatusManager(isRunningLocally(), context);
	context.subscriptions.push(statusManager);

	// 初始化诊断面板
	diagnosticPanel = new DiagnosticPanel(context);
	context.subscriptions.push({ dispose: () => diagnosticPanel.dispose() });

	// 初始化流量面板
	trafficPanel = new TrafficPanel(context);
	context.subscriptions.push({ dispose: () => trafficPanel.dispose() });

	// 注册显示输出窗口的命令
	context.subscriptions.push(
		vscode.commands.registerCommand('antigravity-ssh-proxy.showOutput', () => {
			outputChannel.show();
		})
	);

	// 注册显示状态面板的命令
	context.subscriptions.push(
		vscode.commands.registerCommand('antigravity-ssh-proxy.showStatusPanel', () => {
			statusManager.showStatusPanel();
		})
	);

	// 注册刷新状态的命令
	context.subscriptions.push(
		vscode.commands.registerCommand('antigravity-ssh-proxy.refreshStatus', async () => {
			await statusManager.refreshStatus();
		})
	);

	// 注册诊断命令
	context.subscriptions.push(
		vscode.commands.registerCommand('antigravity-ssh-proxy.diagnose', async () => {
			await diagnosticPanel.show();
		})
	);

	// 注册流量监控命令
	context.subscriptions.push(
		vscode.commands.registerCommand('antigravity-ssh-proxy.showTrafficPanel', () => {
			trafficPanel.show();
		})
	);

	// 启动自动刷新状态
	statusManager.startAutoRefresh();

	if (isRunningLocally()) {
		activateLocal(context).catch(err => log(`activateLocal error: ${err}`));
	} else {
		activateRemote(context).catch(err => log(`activateRemote error: ${err}`));
	}
}

async function activateLocal(context: vscode.ExtensionContext) {
	// 设置配置变更回调（用于面板中修改配置时触发）
	statusManager.setConfigChangeCallback(async () => {
		const cfg = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
		const lp = cfg.get<number>('localProxyPort', DEFAULT_LOCAL_PROXY_PORT);
		const rp = cfg.get<number>('remoteProxyPort', DEFAULT_REMOTE_PROXY_PORT);
		const enabled = cfg.get<boolean>('enableLocalForwarding', DEFAULT_ENABLE_LOCAL_FORWARDING);
		const forwardingRemoteHosts = getConfiguredForwardingHosts(cfg);
		await updateSSHConfigFile(rp, lp, enabled, forwardingRemoteHosts);
		statusManager.updateSSHConfigStatus(enabled, rp);
	});

	const config = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
	const enable = config.get<boolean>('enableLocalForwarding', DEFAULT_ENABLE_LOCAL_FORWARDING);
	const localPort = config.get<number>('localProxyPort', DEFAULT_LOCAL_PROXY_PORT);
	const remotePort = config.get<number>('remoteProxyPort', DEFAULT_REMOTE_PROXY_PORT);
	const forwardingRemoteHosts = getConfiguredForwardingHosts(config);

	log(
		`Config: enable=${enable}, localPort=${localPort}, remotePort=${remotePort}, forwardingScope=${getForwardingScopeLabel(forwardingRemoteHosts)}`
	);

	// Auto-setup on activation
	if (enable) {
		await updateSSHConfigFile(remotePort, localPort, true, forwardingRemoteHosts);
		statusManager.updateSSHConfigStatus(true, remotePort);
		if (!await checkPortAvailable('127.0.0.1', localPort)) {
			vscode.window.showWarningMessage(
				`Local proxy at 127.0.0.1:${localPort} is not running. ` +
				`Also check if port ${remotePort} is occupied on the remote server before reconnecting.`
			);
		}
	} else {
		// Keep local cleanup idempotent so stale forwarding doesn't survive after switching to remote-local proxy mode.
		await updateSSHConfigFile(0, 0, false);
		statusManager.updateSSHConfigStatus(false);
	}

	// 初始刷新状态
	await statusManager.refreshStatus();

	// 同步初始 SSH 配置状态
	const initialStatus = await getSSHConfigStatus();
	statusManager.updateSSHConfigStatus(initialStatus.enabled, initialStatus.port);

	// Watch config changes (from VS Code settings)
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(async (e: vscode.ConfigurationChangeEvent) => {
			if (e.affectsConfiguration('antigravity-ssh-proxy')) {
				const cfg = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
				const lp = cfg.get<number>('localProxyPort', DEFAULT_LOCAL_PROXY_PORT);
				const rp = cfg.get<number>('remoteProxyPort', DEFAULT_REMOTE_PROXY_PORT);
				const enabled = cfg.get<boolean>('enableLocalForwarding', DEFAULT_ENABLE_LOCAL_FORWARDING);
				const scopedRemotes = getConfiguredForwardingHosts(cfg);
				await updateSSHConfigFile(rp, lp, enabled, scopedRemotes);
				statusManager.updateSSHConfigStatus(enabled, rp);
				await statusManager.refreshStatus();
			}
		})
	);

	// Commands
	context.subscriptions.push(
		vscode.commands.registerCommand('antigravity-ssh-proxy.enableForwarding', async () => {
			const cfg = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
			const lp = cfg.get<number>('localProxyPort', DEFAULT_LOCAL_PROXY_PORT);
			const rp = cfg.get<number>('remoteProxyPort', DEFAULT_REMOTE_PROXY_PORT);
			const scopedRemotes = getConfiguredForwardingHosts(cfg);
			await updateSSHConfigFile(rp, lp, true, scopedRemotes);
			statusManager.updateSSHConfigStatus(true, rp);
			await statusManager.refreshStatus();
			vscode.window.showInformationMessage(
				`SSH port forwarding enabled (${getForwardingScopeLabel(scopedRemotes)})`
			);
		}),

		vscode.commands.registerCommand('antigravity-ssh-proxy.disableForwarding', async () => {
			await updateSSHConfigFile(0, 0, false);
			statusManager.updateSSHConfigStatus(false);
			await statusManager.refreshStatus();
			vscode.window.showInformationMessage('SSH port forwarding disabled');
		}),

		vscode.commands.registerCommand('antigravity-ssh-proxy.tunnelStatus', async () => {
			const status = await getSSHConfigStatus();
			statusManager.updateSSHConfigStatus(status.enabled, status.port);
			vscode.window.showInformationMessage(
				status.enabled
					? `Forwarding configured on port: ${status.port}`
					: 'SSH port forwarding is not configured'
			);
		})
	);
}

/**
 * Ensure mgraftcp binary has execute permission
 */
async function ensureMgraftcpExecutable(extensionPath: string): Promise<void> {
	const arch = os.arch();
	let binaryName: string;

	switch (arch) {
		case 'x64':
		case 'amd64':
			binaryName = 'mgraftcp-fakedns-linux-amd64';
			break;
		case 'arm64':
		case 'aarch64':
			binaryName = 'mgraftcp-fakedns-linux-arm64';
			break;
		default:
			log(`Unsupported architecture: ${arch}`);
			return;
	}

	const mgraftcpPath = path.join(extensionPath, 'resources', 'bin', binaryName);

	try {
		await execAsync(`chmod +x "${mgraftcpPath}"`);
		log(`Set execute permission for ${mgraftcpPath}`);
	} catch (error) {
		log(`Failed to set execute permission for mgraftcp: ${error}`);
	}
}

async function activateRemote(context: vscode.ExtensionContext) {
	const config = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
	// Remote only cares about remoteProxyHost, remoteProxyPort, and proxyType
	const remoteHost = config.get<string>('remoteProxyHost', DEFAULT_REMOTE_PROXY_HOST);
	const remotePort = config.get<number>('remoteProxyPort', DEFAULT_REMOTE_PROXY_PORT);
	const proxyType = config.get<string>('proxyType', DEFAULT_PROXY_TYPE);

	if (process.platform !== 'linux') {
		log(`Skipping setup: unsupported platform '${process.platform}' (only Linux is supported)`);
		return;
	}

	// Use extensionUri.fsPath for correct remote path resolution
	const extensionPath = context.extensionUri.fsPath;

	// Ensure mgraftcp binary has execute permission before setup
	await ensureMgraftcpExecutable(extensionPath);

	// 设置配置变更回调（用于面板中修改配置时触发）
	statusManager.setConfigChangeCallback(async () => {
		const cfg = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
		const host = cfg.get<string>('remoteProxyHost', DEFAULT_REMOTE_PROXY_HOST);
		const port = cfg.get<number>('remoteProxyPort', DEFAULT_REMOTE_PROXY_PORT);
		const type = cfg.get<string>('proxyType', DEFAULT_PROXY_TYPE);
		log(`Config changed from panel, re-running setup: ${host}:${port} (${type})`);
		const success = await runSetupScriptSilently(host, port, type, extensionPath);
		statusManager.updateLanguageServerStatus(success);
	});

	log(`Remote Proxy: ${remoteHost}:${remotePort} (${proxyType})`);

	// 初始刷新状态
	await statusManager.refreshStatus();

	// Auto-run setup script
	log(`Extension path: ${extensionPath}`);
	log('Auto-running setup script...');
	const setupSuccess = await runSetupScriptSilently(remoteHost, remotePort, proxyType, extensionPath);
	statusManager.updateLanguageServerStatus(setupSuccess);

	// Watch config changes (from VS Code settings)
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(async (e: vscode.ConfigurationChangeEvent) => {
			if (e.affectsConfiguration('antigravity-ssh-proxy.remoteProxyHost') ||
				e.affectsConfiguration('antigravity-ssh-proxy.remoteProxyPort') ||
				e.affectsConfiguration('antigravity-ssh-proxy.proxyType')) {
				const cfg = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
				const host = cfg.get<string>('remoteProxyHost', DEFAULT_REMOTE_PROXY_HOST);
				const port = cfg.get<number>('remoteProxyPort', DEFAULT_REMOTE_PROXY_PORT);
				const type = cfg.get<string>('proxyType', DEFAULT_PROXY_TYPE);
				log(`Config changed, re-running setup: ${host}:${port} (${type})`);
				const success = await runSetupScriptSilently(host, port, type, extensionPath);
				statusManager.updateLanguageServerStatus(success);
				await statusManager.refreshStatus();
			}
		})
	);

	// Remote commands
	context.subscriptions.push(
		vscode.commands.registerCommand('antigravity-ssh-proxy.setup', () => {
			const cfg = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
			const host = cfg.get<string>('remoteProxyHost', DEFAULT_REMOTE_PROXY_HOST);
			const port = cfg.get<number>('remoteProxyPort', DEFAULT_REMOTE_PROXY_PORT);
			const type = cfg.get<string>('proxyType', DEFAULT_PROXY_TYPE);
			const terminal = vscode.window.createTerminal('Antigravity Setup');
			terminal.show();
			const script = generateSetupScript(host, port, type, extensionPath);
			terminal.sendText(`cat > /tmp/ag_setup.sh << 'EOF'\n${script}\nEOF`);
			terminal.sendText('bash /tmp/ag_setup.sh');
		}),

		vscode.commands.registerCommand('antigravity-ssh-proxy.rollback', () => {
			const terminal = vscode.window.createTerminal('Antigravity Rollback');
			terminal.show();
			terminal.sendText(generateRollbackScript());
			statusManager.updateLanguageServerStatus(false);
		}),

		vscode.commands.registerCommand('antigravity-ssh-proxy.checkProxy', async () => {
			const cfg = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
			const host = cfg.get<string>('remoteProxyHost', DEFAULT_REMOTE_PROXY_HOST);
			const port = cfg.get<number>('remoteProxyPort', DEFAULT_REMOTE_PROXY_PORT);
			const ok = await checkPortAvailable(host, port);
			await statusManager.refreshStatus();
			vscode.window.showInformationMessage(ok ? `Proxy OK (${host}:${port})` : `Proxy NOT reachable (${host}:${port})`);
		})
	);

	// Show startup status notification if enabled
	const showStatusOnStartup = config.get<boolean>('showStatusOnStartup', true);
	if (showStatusOnStartup) {
		// Delay slightly to let setup complete
		setTimeout(async () => {
			await showStartupStatus(remoteHost, remotePort, proxyType, extensionPath);
		}, 2000);
	}
}

/**
 * Show detailed warning when the remote proxy endpoint is unreachable
 */
async function showProxyNotReachableWarning(proxyHost: string, proxyPort: number): Promise<void> {
	const detailMessage = 
		`Remote proxy is not reachable.\n\n` +
		`The configured proxy endpoint ${proxyHost}:${proxyPort} did not accept connections.\n\n` +
		`To fix this:\n` +
		`1. Ensure your proxy service is running on the remote server\n` +
		`2. Verify remoteProxyHost/remoteProxyPort/proxyType settings\n` +
		`3. Re-run "Setup Remote Environment" and reload the window if prompted\n\n` +
		`Default remote-local SOCKS endpoint is 127.0.0.1:34380 (socks5).`;

	log('Showing remote proxy unreachable warning dialog');
	
	const selection = await vscode.window.showWarningMessage(
		detailMessage,
		{ modal: true },
		'Open Status Panel',
		'Run Diagnostics',
		'Dismiss'
	);

	if (selection === 'Open Status Panel') {
		vscode.commands.executeCommand('antigravity-ssh-proxy.showStatusPanel');
	} else if (selection === 'Run Diagnostics') {
		vscode.commands.executeCommand('antigravity-ssh-proxy.diagnose');
	}
}

/**
 * Show startup status notification with detailed diagnostics in output channel
 */
async function showStartupStatus(
	proxyHost: string,
	proxyPort: number,
	proxyType: string,
	extensionPath: string
): Promise<void> {
	try {
		log('');
		log('========== Startup Status Check ==========');
		log(`Proxy endpoint: ${proxyHost}:${proxyPort}`);
		log('');

		// Test 1: Port connectivity
		log(`[Test 1] Checking port connectivity...`);
		log(`  Command: nc -zv ${proxyHost} ${proxyPort}`);
		const proxyReachable = await checkPortAvailable(proxyHost, proxyPort);
		log(`  Result: ${proxyReachable ? '✓ Port is reachable' : '✗ Port is NOT reachable'}`);
		log('');

		// Test 2: mgraftcp process
		log(`[Test 2] Checking if mgraftcp is running...`);
		log(`  Command: pgrep -f mgraftcp`);
		const proxyActive = await isMgraftcpRunning();
		log(`  Result: ${proxyActive ? '✓ mgraftcp is running (proxy active)' : '✗ mgraftcp is NOT running'}`);
		log('');

		// Test 3: External connectivity (only if port is reachable)
		if (proxyReachable) {
			const config = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
			const currentProxyType = config.get<string>('proxyType', proxyType || DEFAULT_PROXY_TYPE);
			
			// Test HTTP proxy
			log(`[Test 3] Testing HTTP proxy connectivity...`);
			const httpCmd = `curl -x http://${proxyHost}:${proxyPort} https://www.google.com -s -o /dev/null -w "%{http_code}" --connect-timeout 10`;
			log(`  Command: ${httpCmd}`);
			let httpOk = false;
			try {
				const { stdout } = await execAsync(httpCmd, { timeout: 15000 });
				const httpCode = stdout.trim();
				httpOk = httpCode === '200' || httpCode === '301' || httpCode === '302';
				const marker = currentProxyType === 'http' ? ' ← Current' : '';
				log(`  Result: HTTP ${httpCode} ${httpOk ? '✓ OK' : '✗ Failed'}${marker}`);
			} catch (error) {
				const marker = currentProxyType === 'http' ? ' ← Current (⚠️ NOT WORKING)' : '';
				log(`  Result: ✗ Failed${marker}`);
			}
			log('');

			// Test SOCKS5 proxy
			log(`[Test 4] Testing SOCKS5 proxy connectivity...`);
			const socks5Cmd = `curl -x socks5://${proxyHost}:${proxyPort} https://www.google.com -s -o /dev/null -w "%{http_code}" --connect-timeout 10`;
			log(`  Command: ${socks5Cmd}`);
			let socks5Ok = false;
			try {
				const { stdout } = await execAsync(socks5Cmd, { timeout: 15000 });
				const httpCode = stdout.trim();
				socks5Ok = httpCode === '200' || httpCode === '301' || httpCode === '302';
				const marker = currentProxyType === 'socks5' ? ' ← Current' : '';
				log(`  Result: HTTP ${httpCode} ${socks5Ok ? '✓ OK' : '✗ Failed'}${marker}`);
			} catch (error) {
				const marker = currentProxyType === 'socks5' ? ' ← Current (⚠️ NOT WORKING)' : '';
				log(`  Result: ✗ Failed${marker}`);
			}
			log('');

			// Test SOCKS5H proxy (SOCKS5 with remote DNS resolution)
			log(`[Test 5] Testing SOCKS5H proxy connectivity (remote DNS)...`);
			const socks5hCmd = `curl -x socks5h://${proxyHost}:${proxyPort} https://www.google.com -s -o /dev/null -w "%{http_code}" --connect-timeout 10`;
			log(`  Command: ${socks5hCmd}`);
			try {
				const { stdout } = await execAsync(socks5hCmd, { timeout: 15000 });
				const httpCode = stdout.trim();
				const socks5hOk = httpCode === '200' || httpCode === '301' || httpCode === '302';
				log(`  Result: HTTP ${httpCode} ${socks5hOk ? '✓ OK' : '✗ Failed'}`);
			} catch (error) {
				log(`  Result: ✗ Failed`);
			}
			log('');
		}

		log('==========================================');
		log('');

		let message: string;
		let actions: string[] = [];
		let shouldNotify = true;

		if (proxyReachable && proxyActive) {
			// Everything is working
			message = `✅ Proxy active (${proxyHost}:${proxyPort})`;
		} else if (proxyReachable && !proxyActive) {
			// Trigger one extra idempotent setup pass so MCP/runtime stubs are restored
			// even when remote cleanup happened between reconnects.
			log('Startup status: proxy reachable but LS not attached; running self-heal setup pass');
			const healed = await runSetupScriptSilently(proxyHost, proxyPort, proxyType, extensionPath, {
				suppressReloadPrompt: true
			});
			if (healed) {
				// Give wrapper/mgraftcp a moment to attach before re-checking.
				await new Promise((resolve) => setTimeout(resolve, 800));
				const proxyActiveAfterHeal = await isMgraftcpRunning();
				log(
					`Startup self-heal recheck: ${
						proxyActiveAfterHeal
							? '✓ mgraftcp is running (proxy active)'
							: '✗ mgraftcp is still NOT running'
					}`
				);
				if (proxyActiveAfterHeal) {
					message = `✅ Proxy active (${proxyHost}:${proxyPort})`;
					shouldNotify = true;
				} else {
					// This state is common during startup races or while LS is restarting.
					// Showing a modal/info popup every reconnection is noisy, so keep it in logs only.
					message = `⚠️ Proxy reachable, waiting for language server to attach`;
					shouldNotify = false;
				}
			} else {
				message = `⚠️ Proxy reachable, waiting for language server to attach`;
				shouldNotify = false;
			}
		} else if (!proxyReachable) {
			log('Proxy not reachable - remote proxy service may be down or misconfigured');
			await showProxyNotReachableWarning(proxyHost, proxyPort);
			return;
		} else {
			message = `⚠️ Proxy status unknown`;
			actions = ['Run Diagnostics', 'Dismiss'];
		}

		log(`Startup status: ${message}`);

		if (!shouldNotify) {
			return;
		}

		if (actions.length > 0) {
			const selection = await vscode.window.showInformationMessage(message, ...actions);
			if (selection === 'Reload Now') {
				vscode.commands.executeCommand('workbench.action.reloadWindow');
			} else if (selection === 'Run Diagnostics') {
				vscode.commands.executeCommand('antigravity-ssh-proxy.diagnose');
			}
		} else {
			// Just show a brief notification for success
			vscode.window.showInformationMessage(message);
		}
	} catch (error) {
		log(`Startup status check failed: ${error}`);
	}
}

/**
 * Run setup script silently in background (idempotent)
 * @returns true if setup was successful or already configured
 */
async function runSetupScriptSilently(
	proxyHost: string,
	proxyPort: number,
	proxyType: string,
	extensionPath: string,
	options?: { suppressReloadPrompt?: boolean }
): Promise<boolean> {
	const scriptPath = path.join(extensionPath, 'scripts', 'setup-proxy.sh');

	try {
		// Ensure script is executable
		await execAsync(`chmod +x "${scriptPath}"`);

		// Read extension version from package.json
		const packageJsonPath = path.join(extensionPath, 'package.json');
		let extensionVersion = 'unknown';
		try {
			const packageJsonContent = await fs.readFile(packageJsonPath, 'utf-8');
			const packageJson = JSON.parse(packageJsonContent);
			extensionVersion = packageJson.version || 'unknown';
		} catch (e) {
			log(`Failed to read package.json: ${e}`);
		}

		// Execute script directly with environment variables for proxy config
		const env = {
			...process.env,
			PROXY_HOST: proxyHost,
			PROXY_PORT: String(proxyPort),
			PROXY_TYPE: proxyType,
			EXTENSION_PATH: extensionPath,  // Current extension's exact path
			EXTENSION_VERSION: extensionVersion  // Extension version for update detection
		};

		const { stdout, stderr } = await execAsync(`bash "${scriptPath}" 2>&1`, { env });
		const output = stdout || stderr || '';

		log(`Setup output: ${output}`);

		// Check if this is a new configuration
		const isNewConfig = output.includes('Setup complete') || 
			(output.includes('configured') && !output.includes('Already configured'));

		if (isNewConfig) {
			// New wrapper/config written. Only prompt reload when proxy isn't active.
			log('Setup: New configuration applied');
			// Give process table a moment to reflect wrapper attach state.
			await new Promise((resolve) => setTimeout(resolve, 500));
			const proxyActive = await isMgraftcpRunning();
			if (!proxyActive) {
				if (!options?.suppressReloadPrompt) {
					promptReloadWindow(
						'Antigravity proxy configured. Reload window to apply changes to the language server.'
					);
				} else {
					log('Setup: Reload prompt suppressed (self-heal mode)');
				}
			} else {
				log('Setup: Proxy already active after configuration, no reload needed');
			}
			return true;
		} else if (output.includes('Already configured')) {
			log('Setup: Already configured');
			
			// Check if Language Server is actually using the proxy
			const proxyActive = await isMgraftcpRunning();
			if (!proxyActive) {
				// Wrapper is configured but LS isn't using proxy (started before wrapper was set up)
				if (!options?.suppressReloadPrompt) {
					log('Setup: Proxy configured but not active, prompting reload');
					promptReloadWindow(
						'Proxy is configured but not active. Reload window to enable proxy for the language server.'
					);
				} else {
					log('Setup: Proxy configured but not active (reload prompt suppressed in self-heal mode)');
				}
			} else {
				log('Setup: Proxy is active, no reload needed');
			}
			return true;
		}
		return false;
	} catch (error: unknown) {
		const err = error as { message?: string; stdout?: string; stderr?: string };
		log(`Setup error: ${err.message || error}`);
		if (err.stdout) { log(`stdout: ${err.stdout}`); }
		if (err.stderr) { log(`stderr: ${err.stderr}`); }
		return false;
	}
}

export async function deactivate() {
	if (statusManager) {
		statusManager.stopAutoRefresh();
	}
	if (isRunningLocally()) {
		try {
			await updateSSHConfigFile(0, 0, false);
		} catch (e) {
			log(`Cleanup during deactivation failed: ${e}`);
		}
	}
}
