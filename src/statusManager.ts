import * as vscode from 'vscode';
import * as net from 'net';
import { runDiagnostics, DiagnosticCheck, DiagnosticReport, generateReportText, ProtocolTestResult } from './diagnostics/diagnosticRunner';
import { TrafficCollector, TrafficStats } from './traffic/trafficCollector';

export interface ProxyStatus {
    runningLocation: 'local' | 'remote';
    sshConfigEnabled: boolean;
    localProxyPort: number;
    remoteProxyPort: number;
    remoteProxyHost: string;
    localProxyReachable: boolean;
    remoteProxyReachable: boolean;
    lastUpdated: Date;
    languageServerConfigured?: boolean;
}

type StatusUpdateCallback = (status: ProxyStatus) => void;
type ConfigChangeCallback = () => Promise<void>;

const REFRESH_INTERVAL_SEC = 30;

// i18n translations
const i18n = {
    zh: {
        title: 'Antigravity SSH Proxy(ATP)',
        local: '本地',
        remote: '远程',
        connected: '已连接',
        partial: '部分连接',
        disconnected: '未连接',
        statusConfig: '状态与配置',
        sshForwarding: 'SSH 转发',
        localProxy: '本地代理',
        proxy: '代理状态',
        languageServer: '语言服务',
        reachable: '可达',
        unreachable: '不可达',
        on: '开启',
        off: '关闭',
        configured: '已配置',
        notConfigured: '未配置',
        enableForwarding: '启用转发',
        localPort: '本地端口',
        remotePort: '远程端口',
        proxyHost: '代理地址',
        proxyPort: '代理端口',
        proxyType: '代理类型',
        proxyTypeHttp: 'HTTP',
        proxyTypeSocks5: 'SOCKS5 (默认)',
        diagnostics: '诊断检查',
        runCheck: '运行检查',
        copyReport: '复制报告',
        running: '检测中...',
        localProxyService: '本地代理服务',
        sshConfig: 'SSH 配置',
        remoteForward: '远程代理端口',
        mgraftcp: 'mgraftcp-fakedns',
        lsWrapper: '语言服务包装',
        externalConn: '外部连接',
        localOnly: '仅本地可用',
        remoteOnly: '仅远程可用',
        traffic: '流量监控',
        connections: '连接',
        session: '会话时长',
        totalRequests: '总请求',
        tips: '使用提示',
        refresh: '刷新',
        rollback: '回滚',
        save: '保存',
        autoRefresh: '自动刷新',
        updated: '已更新',
        tunnelWarningTitle: '代理不可达',
        tunnelWarningMsg: '无法连接远程代理端点，请检查远程代理服务与当前配置。',
        tunnelStep1: '确认远程代理服务正在运行（默认 127.0.0.1:34380）',
        tunnelStep2: '检查 proxyHost / proxyPort / proxyType 是否正确',
        tunnelStep3: '重新执行 Setup Remote Environment 并按提示重载窗口',
        tipTitleLocal: '本地转发（可选）',
        tipStep1Local: '在本地电脑启动代理软件（如 Clash、V2Ray）',
        tipStep2Local: '仅在需要通过本地代理时启用 SSH 转发',
        tipStep3Local: '启用后确认 remoteProxyPort 没有与远程已有服务冲突',
        tipStep4Local: '配置变更后重新连接远程窗口',
        tipNoteLocal: '默认推荐远程端本地 SOCKS5（127.0.0.1:34380），本地转发按需启用。',
        tipTitleRemote: '远程端排查',
        tipStep1Remote: '确认远程服务器代理服务正在运行',
        tipStep2Remote: '检查 proxyHost / proxyPort / proxyType 设置',
        tipStep3Remote: '重新执行 Setup Remote Environment',
        tipStep4Remote: '如有提示，重载窗口使语言服务生效',
        tipNoteRemote: '默认配置为 SOCKS5 127.0.0.1:34380，如你的服务不同请在面板修改。',
        pending: '待检测',
        success: '通过',
        warning: '警告',
        error: '错误',
        skipped: '已跳过',
        reportCopied: '报告已复制到剪贴板',
        configSaved: '配置已保存',
        rollbackTitle: '回滚操作',
        rollbackDesc: '此功能用于恢复之前的语言服务配置。仅当您遇到插件升级导致的严重问题或在卸载插件前使用。',
    },
    en: {
        title: 'Antigravity SSH Proxy(ATP)',
        local: 'Local',
        remote: 'Remote',
        connected: 'Connected',
        partial: 'Partial',
        disconnected: 'Disconnected',
        statusConfig: 'Status & Config',
        sshForwarding: 'SSH Forwarding',
        localProxy: 'Local Proxy',
        proxy: 'Proxy',
        languageServer: 'Language Server',
        reachable: 'Reachable',
        unreachable: 'Unreachable',
        on: 'ON',
        off: 'OFF',
        configured: 'Configured',
        notConfigured: 'Not Configured',
        enableForwarding: 'Enable Forwarding',
        localPort: 'Local Port',
        remotePort: 'Remote Port',
        proxyHost: 'Proxy Host',
        proxyPort: 'Proxy Port',
        proxyType: 'Proxy Type',
        proxyTypeHttp: 'HTTP',
        proxyTypeSocks5: 'SOCKS5 (Default)',
        diagnostics: 'Diagnostics',
        runCheck: 'Run Check',
        copyReport: 'Copy Report',
        running: 'Running...',
        localProxyService: 'Local Proxy Service',
        sshConfig: 'SSH Configuration',
        remoteForward: 'Remote Proxy Endpoint',
        mgraftcp: 'mgraftcp-fakedns',
        lsWrapper: 'Language Server Wrapper',
        externalConn: 'External Connectivity',
        localOnly: 'Local only',
        remoteOnly: 'Remote only',
        traffic: 'Traffic Monitor',
        connections: 'connections',
        session: 'Session',
        totalRequests: 'Total Requests',
        tips: 'Tips',
        refresh: 'Refresh',
        rollback: 'Rollback',
        save: 'Save',
        autoRefresh: 'Auto refresh',
        updated: 'Updated',
        tunnelWarningTitle: 'Proxy Unreachable',
        tunnelWarningMsg: 'Cannot connect to the configured remote proxy endpoint.',
        tunnelStep1: 'Ensure a proxy service is running on remote (default 127.0.0.1:34380)',
        tunnelStep2: 'Verify proxyHost / proxyPort / proxyType settings',
        tunnelStep3: 'Run Setup Remote Environment again and reload if prompted',
        tipTitleLocal: 'Local Forwarding (Optional)',
        tipStep1Local: 'Start your local proxy (e.g., Clash, V2Ray) on your computer',
        tipStep2Local: 'Enable SSH forwarding only when you want to route through local proxy',
        tipStep3Local: 'After enabling, ensure remoteProxyPort does not conflict on remote server',
        tipStep4Local: 'Reconnect the remote window after config changes',
        tipNoteLocal: 'Default mode is remote-local SOCKS5 (127.0.0.1:34380); local forwarding is opt-in.',
        tipTitleRemote: 'Remote Troubleshooting',
        tipStep1Remote: 'Ensure the proxy service is running on the remote server',
        tipStep2Remote: 'Verify proxyHost / proxyPort / proxyType configuration',
        tipStep3Remote: 'Run Setup Remote Environment again',
        tipStep4Remote: 'Reload window if prompted so language server picks up wrapper changes',
        tipNoteRemote: 'Default remote endpoint is SOCKS5 on 127.0.0.1:34380 unless you changed it.',
        pending: 'Pending',
        success: 'Pass',
        warning: 'Warning',
        error: 'Error',
        skipped: 'Skipped',
        reportCopied: 'Report copied to clipboard',
        configSaved: 'Configuration saved',
        rollbackTitle: 'Rollback Operation',
        rollbackDesc: 'Restores previous Language Server configuration. Use only if plugin update causes critical issues or before uninstalling.',
    }
};

type Lang = 'zh' | 'en';

export class StatusManager {
    private statusBarItem: vscode.StatusBarItem;
    private currentStatus: ProxyStatus;
    private updateCallbacks: StatusUpdateCallback[] = [];
    private refreshInterval: NodeJS.Timeout | undefined;
    private statusPanel: vscode.WebviewPanel | undefined;
    private countdownInterval: NodeJS.Timeout | undefined;
    private secondsUntilRefresh: number = REFRESH_INTERVAL_SEC;
    private onConfigChange: ConfigChangeCallback | undefined;
    
    // New properties for unified dashboard
    private trafficCollector: TrafficCollector;
    private currentDiagnosticReport: DiagnosticReport | null = null;
    private isRunningDiagnostics: boolean = false;
    private currentLang: Lang = 'zh';
    private static readonly DEFAULT_SHOW_LOCAL_STATUS_BAR_ITEM = true;

    constructor(private isLocal: boolean, private context: vscode.ExtensionContext) {
        this.statusBarItem = vscode.window.createStatusBarItem(
            'dinobot22.antigravity-ssh-proxy.status',
            vscode.StatusBarAlignment.Left,
            10000
        );
        this.statusBarItem.command = 'antigravity-ssh-proxy.showStatusPanel';
        this.statusBarItem.name = 'ATP';

        const config = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
        this.currentStatus = {
            runningLocation: isLocal ? 'local' : 'remote',
            sshConfigEnabled: false,
            localProxyPort: config.get<number>('localProxyPort', 7890),
            remoteProxyPort: config.get<number>('remoteProxyPort', 34380),
            remoteProxyHost: config.get<string>('remoteProxyHost', '127.0.0.1'),
            localProxyReachable: false,
            remoteProxyReachable: false,
            lastUpdated: new Date(),
        };

        // Initialize traffic collector
        this.trafficCollector = new TrafficCollector();
        
        // Load saved language preference (default to Chinese)
        this.currentLang = this.context.globalState.get<Lang>('uiLanguage', 'zh');

        this.updateStatusBar();
        this.updateStatusBarVisibility(config);
    }

    private updateStatusBarVisibility(config?: vscode.WorkspaceConfiguration): void {
        const cfg = config ?? vscode.workspace.getConfiguration('antigravity-ssh-proxy');
        const showLocalStatusBarItem = cfg.get<boolean>(
            'showLocalStatusBarItem',
            StatusManager.DEFAULT_SHOW_LOCAL_STATUS_BAR_ITEM
        );

        if (this.isLocal && !showLocalStatusBarItem) {
            this.statusBarItem.hide();
            return;
        }

        this.statusBarItem.show();
    }

    /**
     * Set config change callback for SSH config updates
     */
    setConfigChangeCallback(callback: ConfigChangeCallback): void {
        this.onConfigChange = callback;
    }

    onStatusUpdate(callback: StatusUpdateCallback): vscode.Disposable {
        this.updateCallbacks.push(callback);
        return new vscode.Disposable(() => {
            const index = this.updateCallbacks.indexOf(callback);
            if (index >= 0) {
                this.updateCallbacks.splice(index, 1);
            }
        });
    }

    startAutoRefresh(): void {
        this.stopAutoRefresh();
        this.secondsUntilRefresh = REFRESH_INTERVAL_SEC;
        
        this.refreshInterval = setInterval(() => {
            this.refreshStatus();
            this.secondsUntilRefresh = REFRESH_INTERVAL_SEC;
        }, REFRESH_INTERVAL_SEC * 1000);

        this.countdownInterval = setInterval(() => {
            this.secondsUntilRefresh = Math.max(0, this.secondsUntilRefresh - 1);
            this.updatePanelCountdown();
        }, 1000);

        this.refreshStatus();
    }

    stopAutoRefresh(): void {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = undefined;
        }
        if (this.countdownInterval) {
            clearInterval(this.countdownInterval);
            this.countdownInterval = undefined;
        }
    }

    async refreshStatus(): Promise<void> {
        const config = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
        
        this.currentStatus.localProxyPort = config.get<number>('localProxyPort', 7890);
        this.currentStatus.remoteProxyPort = config.get<number>('remoteProxyPort', 34380);
        this.currentStatus.remoteProxyHost = config.get<string>('remoteProxyHost', '127.0.0.1');

        if (this.isLocal) {
            this.currentStatus.localProxyReachable = await this.checkPort(
                '127.0.0.1',
                this.currentStatus.localProxyPort
            );
        } else {
            this.currentStatus.remoteProxyReachable = await this.checkPort(
                this.currentStatus.remoteProxyHost,
                this.currentStatus.remoteProxyPort
            );
        }

        this.currentStatus.lastUpdated = new Date();
        this.secondsUntilRefresh = REFRESH_INTERVAL_SEC;
        this.updateStatusBar();
        this.updateStatusBarVisibility(config);
        this.updatePanelIfOpen();
        this.notifyCallbacks();
    }

    updateSSHConfigStatus(enabled: boolean, port?: number): void {
        this.currentStatus.sshConfigEnabled = enabled;
        if (port !== undefined) {
            this.currentStatus.remoteProxyPort = port;
        }
        this.currentStatus.lastUpdated = new Date();
        this.updateStatusBar();
        this.updatePanelIfOpen();
        this.notifyCallbacks();
    }

    updateLanguageServerStatus(configured: boolean): void {
        this.currentStatus.languageServerConfigured = configured;
        this.currentStatus.lastUpdated = new Date();
        this.updateStatusBar();
        this.updatePanelIfOpen();
        this.notifyCallbacks();
    }

    getStatus(): ProxyStatus {
        return { ...this.currentStatus };
    }

    showStatusPanel(): void {
        if (this.statusPanel) {
            this.statusPanel.reveal();
            return;
        }

        this.statusPanel = vscode.window.createWebviewPanel(
            'atpStatus',
            'Antigravity SSH Proxy',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        // Start traffic collector when panel opens (remote only)
        if (!this.isLocal) {
            this.trafficCollector.start();
            this.trafficCollector.onUpdate(() => {
                this.updatePanelIfOpen();
            });
        }

        this.statusPanel.webview.html = this.getPanelHtml();

        this.statusPanel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'refresh':
                        await this.refreshStatus();
                        if (!this.isLocal) {
                            await this.trafficCollector.refresh();
                        }
                        break;
                    case 'saveConfig':
                        await this.saveConfig(message.config);
                        break;
                    case 'runDiagnostics':
                        await this.runInlineDiagnostics();
                        break;
                    case 'copyReport':
                        await this.copyDiagnosticReport();
                        break;
                    case 'setLanguage':
                        this.currentLang = message.lang as Lang;
                        await this.context.globalState.update('uiLanguage', this.currentLang);
                        this.updatePanelIfOpen();
                        break;
                    case 'rollback':
                        vscode.commands.executeCommand('antigravity-ssh-proxy.rollback');
                        break;
                }
            },
            undefined,
            this.context.subscriptions
        );

        this.statusPanel.onDidDispose(() => {
            this.statusPanel = undefined;
            if (!this.isLocal) {
                this.trafficCollector.stop();
            }
        });
    }

    /**
     * Run diagnostics inline and update panel
     */
    private async runInlineDiagnostics(): Promise<void> {
        if (this.isRunningDiagnostics) {
            return;
        }
        
        this.isRunningDiagnostics = true;
        this.updatePanelIfOpen();

        try {
            this.currentDiagnosticReport = await runDiagnostics((checks) => {
                // Update panel with progress
                if (this.statusPanel) {
                    this.statusPanel.webview.postMessage({
                        command: 'diagnosticProgress',
                        checks: checks
                    });
                }
            }, this.context.extensionUri.fsPath);
        } finally {
            this.isRunningDiagnostics = false;
            this.updatePanelIfOpen();
        }
    }

    /**
     * Copy diagnostic report to clipboard
     */
    private async copyDiagnosticReport(): Promise<void> {
        if (this.currentDiagnosticReport) {
            const text = generateReportText(this.currentDiagnosticReport);
            await vscode.env.clipboard.writeText(text);
            const t = i18n[this.currentLang];
            vscode.window.showInformationMessage(t.reportCopied);
        }
    }

    /**
     * Save configuration
     */
    private async saveConfig(newConfig: {
        localProxyPort?: number;
        remoteProxyPort?: number;
        remoteProxyHost?: string;
        enableLocalForwarding?: boolean;
        proxyType?: string;
    }): Promise<void> {
        const config = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
        const oldProxyType = config.get<string>('proxyType', 'socks5');
        const t = i18n[this.currentLang];
        
        try {
            if (newConfig.localProxyPort !== undefined) {
                await config.update('localProxyPort', newConfig.localProxyPort, vscode.ConfigurationTarget.Global);
            }
            if (newConfig.remoteProxyPort !== undefined) {
                await config.update('remoteProxyPort', newConfig.remoteProxyPort, vscode.ConfigurationTarget.Global);
            }
            if (newConfig.remoteProxyHost !== undefined) {
                await config.update('remoteProxyHost', newConfig.remoteProxyHost, vscode.ConfigurationTarget.Global);
            }
            if (newConfig.enableLocalForwarding !== undefined) {
                await config.update('enableLocalForwarding', newConfig.enableLocalForwarding, vscode.ConfigurationTarget.Global);
            }
            if (newConfig.proxyType !== undefined) {
                await config.update('proxyType', newConfig.proxyType, vscode.ConfigurationTarget.Global);
            }

            // Trigger config change callback
            if (this.onConfigChange) {
                await this.onConfigChange();
            }

            await this.refreshStatus();
            
            // If proxyType changed, prompt for reload
            if (newConfig.proxyType !== undefined && newConfig.proxyType !== oldProxyType) {
                const reloadMsg = this.currentLang === 'zh' 
                    ? `代理类型已更改为 ${newConfig.proxyType.toUpperCase()}。请重新加载窗口以应用更改。`
                    : `Proxy type changed to ${newConfig.proxyType.toUpperCase()}. Please reload window to apply changes.`;
                const reloadNow = this.currentLang === 'zh' ? '立即重载' : 'Reload Now';
                const later = this.currentLang === 'zh' ? '稍后' : 'Later';
                
                vscode.window.showInformationMessage(reloadMsg, reloadNow, later).then(selection => {
                    if (selection === reloadNow) {
                        vscode.commands.executeCommand('workbench.action.reloadWindow');
                    }
                });
            } else {
                vscode.window.showInformationMessage(t.configSaved);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to save config: ${error}`);
        }
    }

    private updatePanelIfOpen(): void {
        if (this.statusPanel) {
            this.statusPanel.webview.html = this.getPanelHtml();
        }
    }

    private updatePanelCountdown(): void {
        if (this.statusPanel) {
            this.statusPanel.webview.postMessage({
                command: 'updateCountdown',
                seconds: this.secondsUntilRefresh
            });
        }
    }

    private updateStatusBar(): void {
        const status = this.currentStatus;
        let tooltip: string;

        if (this.isLocal) {
            if (status.sshConfigEnabled && status.localProxyReachable) {
                this.statusBarItem.color = '#22c55e';
                tooltip = 'Antigravity SSH Proxy (ATP)\n✅ Connected';
            } else if (status.sshConfigEnabled) {
                this.statusBarItem.color = '#eab308';
                tooltip = 'Antigravity SSH Proxy (ATP)\n⚠️ SSH configured, proxy unreachable';
            } else {
                this.statusBarItem.color = '#ef4444';
                tooltip = 'Antigravity SSH Proxy (ATP)\n❌ Disconnected';
            }
        } else {
            if (status.remoteProxyReachable) {
                this.statusBarItem.color = '#22c55e';
                tooltip = 'Antigravity SSH Proxy (ATP)\n✅ Proxy OK';
            } else {
                this.statusBarItem.color = '#ef4444';
                tooltip = 'Antigravity SSH Proxy (ATP)\n❌ Proxy unreachable';
            }
        }

        this.statusBarItem.text = '$(circle-large-filled) ATP';
        this.statusBarItem.tooltip = tooltip;
        this.statusBarItem.backgroundColor = undefined;
    }

    private checkPort(host: string, port: number): Promise<boolean> {
        return new Promise((resolve) => {
            const socket = new net.Socket();
            socket.setTimeout(2000);
            socket.on('connect', () => { socket.destroy(); resolve(true); });
            socket.on('timeout', () => { socket.destroy(); resolve(false); });
            socket.on('error', () => { socket.destroy(); resolve(false); });
            socket.connect(port, host);
        });
    }

    private notifyCallbacks(): void {
        const status = this.getStatus();
        for (const callback of this.updateCallbacks) {
            callback(status);
        }
    }

    private getDiagnosticCheckName(id: string, t: typeof i18n.zh): string {
        const names: Record<string, string> = {
            'local-proxy': t.localProxyService,
            'ssh-config': t.sshConfig,
            'remote-forward': t.remoteForward,
            'mgraftcp': t.mgraftcp,
            'ls-wrapper': t.lsWrapper,
            'external-connectivity': t.externalConn,
        };
        return names[id] || id;
    }

    private getPanelHtml(): string {
        const status = this.currentStatus;
        const isLocal = status.runningLocation === 'local';
        const config = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
        const enableForwarding = config.get<boolean>('enableLocalForwarding', false);
        const proxyType = config.get<string>('proxyType', 'socks5');
        const t = i18n[this.currentLang];
        const trafficStats = this.trafficCollector.getStats();
        
        let statusColor: string;
        let statusText: string;

        if (isLocal) {
            if (status.sshConfigEnabled && status.localProxyReachable) {
                statusColor = '#22c55e';
                statusText = t.connected;
            } else if (status.sshConfigEnabled) {
                statusColor = '#eab308';
                statusText = t.partial;
            } else {
                statusColor = '#ef4444';
                statusText = t.disconnected;
            }
        } else {
            statusColor = status.remoteProxyReachable ? '#22c55e' : '#ef4444';
            statusText = status.remoteProxyReachable ? t.connected : t.disconnected;
        }

        // Generate diagnostics HTML
        const diagnosticsHtml = this.generateDiagnosticsHtml(t, isLocal);
        
        // Generate traffic HTML (remote only)
        const trafficHtml = this.generateTrafficHtml(t, trafficStats, isLocal);

        return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        :root {
            --bg-primary: #0d0d0d;
            --bg-card: #1a1a1a;
            --border-color: #252525;
            --text-primary: #f0f0f0;
            --text-secondary: #666;
            --text-muted: #444;
            --accent: #888;
            --success: #22c55e;
            --error: #ef4444;
            --warning: #eab308;
        }
        
        * { margin: 0; padding: 0; box-sizing: border-box; }
        
        body {
            font-family: 'JetBrains Mono', 'SF Mono', 'Fira Code', 'Consolas', monospace;
            background: var(--bg-primary);
            color: var(--text-primary);
            padding: 24px;
            font-size: 12px;
            line-height: 1.5;
        }
        
        .container {
            max-width: 720px;
            margin: 0 auto;
        }
        
        /* Header */
        .header {
            display: flex;
            align-items: center;
            gap: 12px;
            margin-bottom: 24px;
            padding-bottom: 20px;
            border-bottom: 1px solid var(--border-color);
        }
        
        .status-indicator {
            width: 8px;
            height: 8px;
            border-radius: 2px;
            background: ${statusColor};
            box-shadow: 0 0 12px ${statusColor}60;
        }
        
        .title {
            font-size: 14px;
            font-weight: 700;
            letter-spacing: 0.5px;
            text-transform: uppercase;
        }
        
        .env-badge {
            font-size: 9px;
            font-weight: 600;
            padding: 3px 8px;
            border-radius: 2px;
            background: var(--border-color);
            color: var(--text-secondary);
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        
        .status-badge {
            margin-left: auto;
            font-size: 10px;
            font-weight: 600;
            padding: 4px 10px;
            border-radius: 2px;
            background: ${statusColor}15;
            color: ${statusColor};
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        
        .lang-toggle {
            display: flex;
            align-items: center;
            gap: 0;
            margin-left: 12px;
        }
        
        .lang-btn {
            padding: 4px 8px;
            font-size: 10px;
            font-weight: 600;
            background: transparent;
            border: 1px solid var(--border-color);
            color: var(--text-secondary);
            cursor: pointer;
            transition: all 0.15s;
            font-family: inherit;
        }
        
        .lang-btn:first-child {
            border-radius: 2px 0 0 2px;
        }
        
        .lang-btn:last-child {
            border-radius: 0 2px 2px 0;
            border-left: none;
        }
        
        .lang-btn.active {
            background: var(--text-primary);
            color: var(--bg-primary);
            border-color: var(--text-primary);
        }
        
        /* Grid Layout */
        .grid {
            display: grid;
            grid-template-columns: 1fr 200px;
            gap: 16px;
            margin-bottom: 16px;
        }
        
        .grid-full {
            grid-column: 1 / -1;
        }
        
        @media (max-width: 600px) {
            .grid {
                grid-template-columns: 1fr;
            }
        }
        
        /* Cards */
        .card {
            background: var(--bg-card);
            border: 1px solid var(--border-color);
            border-radius: 4px;
            overflow: hidden;
        }
        
        .card-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 12px 16px;
            border-bottom: 1px solid var(--border-color);
            background: var(--bg-primary);
        }
        
        .card-title {
            font-size: 10px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 1px;
            color: var(--text-secondary);
        }
        
        .card-title-icon {
            margin-right: 8px;
            opacity: 0.7;
        }
        
        .card-body {
            padding: 12px 16px;
        }
        
        /* Rows */
        .row {
            display: flex;
            align-items: center;
            padding: 8px 0;
            border-bottom: 1px solid var(--border-color);
        }
        
        .row:last-child {
            border-bottom: none;
        }
        
        .row-label {
            flex: 1;
            color: var(--text-secondary);
            font-size: 11px;
        }
        
        .row-value {
            font-weight: 600;
            font-size: 11px;
        }
        
        .row-value.success { color: var(--success); }
        .row-value.error { color: var(--error); }
        .row-value.warning { color: var(--warning); }
        .row-value.muted { color: var(--text-muted); }
        
        .row-extra {
            margin-left: 12px;
            color: var(--text-muted);
            font-size: 10px;
            font-family: 'JetBrains Mono', monospace;
        }
        
        /* Input Rows */
        .input-row {
            display: flex;
            align-items: center;
            padding: 8px 0;
            border-bottom: 1px solid var(--border-color);
            gap: 12px;
        }
        
        .input-row:last-child {
            border-bottom: none;
        }
        
        .input-row label {
            flex: 1;
            color: var(--text-secondary);
            font-size: 11px;
        }
        
        .input-row label.toggle {
            flex: none;
        }
        
        .input-row input[type="text"],
        .input-row input[type="number"] {
            width: 100px;
            padding: 6px 10px;
            border: 1px solid var(--border-color);
            border-radius: 2px;
            background: var(--bg-primary);
            color: var(--text-primary);
            font-family: inherit;
            font-size: 11px;
        }
        
        .input-row input:focus {
            outline: none;
            border-color: var(--accent);
        }
        
        .input-row select {
            width: 100px;
            padding: 6px 10px;
            border: 1px solid var(--border-color);
            border-radius: 2px;
            background: var(--bg-primary);
            color: var(--text-primary);
            font-family: inherit;
            font-size: 11px;
            cursor: pointer;
        }
        
        .input-row select:focus {
            outline: none;
            border-color: var(--accent);
        }
        
        /* Toggle Switch */
        .toggle {
            position: relative;
            width: 32px;
            height: 16px;
            flex: none;
        }
        
        .toggle input {
            opacity: 0;
            width: 0;
            height: 0;
        }
        
        .toggle-slider {
            position: absolute;
            cursor: pointer;
            inset: 0;
            background: var(--bg-primary);
            border: 1px solid var(--border-color);
            border-radius: 2px;
            transition: 0.2s;
        }
        
        .toggle-slider:before {
            position: absolute;
            content: "";
            height: 10px;
            width: 10px;
            left: 2px;
            bottom: 2px;
            background: var(--text-secondary);
            border-radius: 1px;
            transition: 0.2s;
        }
        
        .toggle input:checked + .toggle-slider {
            background: var(--success);
            border-color: var(--success);
        }
        
        .toggle input:checked + .toggle-slider:before {
            transform: translateX(16px);
            background: var(--bg-primary);
        }
        
        /* Warning Alert */
        .alert {
            display: flex;
            gap: 16px;
            padding: 16px;
            border-radius: 4px;
            border: 1px solid;
            margin-bottom: 16px;
        }
        
        .alert-warning {
            background: ${statusColor}08;
            border-color: ${statusColor}40;
        }
        
        .alert-icon {
            font-size: 18px;
            flex-shrink: 0;
        }
        
        .alert-content {
            flex: 1;
        }
        
        .alert-title {
            font-weight: 700;
            font-size: 12px;
            color: var(--warning);
            margin-bottom: 8px;
        }
        
        .alert-message {
            font-size: 11px;
            color: var(--text-secondary);
            margin-bottom: 12px;
            line-height: 1.6;
        }
        
        .alert-steps {
            display: flex;
            flex-direction: column;
            gap: 6px;
            margin-bottom: 16px;
        }
        
        .alert-step {
            display: flex;
            align-items: center;
            gap: 10px;
            font-size: 11px;
            color: var(--text-secondary);
        }
        
        .step-num {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 18px;
            height: 18px;
            border-radius: 2px;
            background: var(--warning);
            color: var(--bg-primary);
            font-size: 10px;
            font-weight: 700;
        }
        
        /* Diagnostics */
        .diag-item {
            display: flex;
            align-items: center;
            padding: 6px 0;
            gap: 10px;
        }
        
        .diag-dot {
            width: 6px;
            height: 6px;
            border-radius: 1px;
            flex-shrink: 0;
        }
        
        .diag-dot.pending { background: var(--text-muted); }
        .diag-dot.running { background: var(--warning); animation: pulse 1s infinite; }
        .diag-dot.success { background: var(--success); }
        .diag-dot.warning { background: var(--warning); }
        .diag-dot.error { background: var(--error); }
        
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.4; }
        }
        
        .diag-name {
            flex: 1;
            font-size: 11px;
            color: var(--text-secondary);
        }
        
        .diag-name.disabled {
            color: var(--text-muted);
        }
        
        .diag-status {
            font-size: 10px;
            color: var(--text-muted);
        }
        
        .diag-status.success { color: var(--success); }
        .diag-status.error { color: var(--error); }
        .diag-status.warning { color: var(--warning); }
        
        .diag-item-wrapper {
            border-bottom: 1px solid var(--border-color);
            padding-bottom: 8px;
            margin-bottom: 8px;
        }
        
        .diag-item-wrapper:last-child {
            border-bottom: none;
            padding-bottom: 0;
            margin-bottom: 0;
        }
        
        .diag-details {
            margin-left: 16px;
            margin-top: 4px;
            padding-left: 10px;
            border-left: 2px solid var(--border-color);
        }
        
        .diag-message {
            font-size: 10px;
            color: var(--text-secondary);
            line-height: 1.4;
            margin-bottom: 4px;
        }
        
        .diag-suggestion {
            font-size: 10px;
            color: var(--warning);
            line-height: 1.4;
            font-style: italic;
        }
        
        /* Protocol List for External Connectivity */
        .protocol-list {
            margin-bottom: 6px;
        }
        
        .protocol-item {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 10px;
            line-height: 1.8;
        }
        
        .protocol-prefix {
            color: var(--text-muted);
            font-family: monospace;
        }
        
        .protocol-name {
            color: var(--text-secondary);
            min-width: 55px;
        }
        
        .protocol-status {
            font-weight: 600;
        }
        
        .protocol-status.success { color: var(--success); }
        .protocol-status.error { color: var(--error); }
        
        .protocol-current {
            color: var(--text-muted);
            font-style: italic;
        }
        /* Traffic Monitor */
        .traffic-stat {
            padding: 8px 0;
            border-bottom: 1px solid var(--border-color);
        }
        
        .traffic-stat:last-child {
            border-bottom: none;
        }
        
        .traffic-label {
            font-size: 9px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--text-muted);
            margin-bottom: 4px;
        }
        
        .traffic-value {
            font-size: 18px;
            font-weight: 700;
            color: var(--text-primary);
        }
        
        .traffic-value.small {
            font-size: 12px;
        }
        
        .traffic-bar {
            display: flex;
            height: 4px;
            background: var(--bg-primary);
            border-radius: 2px;
            overflow: hidden;
            margin-top: 8px;
        }
        
        .traffic-bar-fill {
            background: var(--success);
            transition: width 0.3s;
        }
        
        .traffic-unavailable {
            color: var(--text-muted);
            font-size: 10px;
            text-align: center;
            padding: 20px;
        }
        
        /* Tips Card */
        .tip-content {
            font-size: 11px;
            color: var(--text-secondary);
            line-height: 1.7;
        }
        
        .tip-title {
            font-weight: 700;
            color: var(--text-primary);
            margin-bottom: 12px;
            font-size: 12px;
        }
        
        .tip-steps {
            list-style: none;
            padding: 0;
            margin: 0;
        }
        
        .tip-step {
            display: flex;
            align-items: flex-start;
            gap: 10px;
            margin-bottom: 8px;
        }
        
        .tip-step .step-num {
            background: var(--border-color);
            color: var(--text-secondary);
            margin-top: 2px;
        }
        
        .tip-note {
            margin-top: 16px;
            padding-top: 12px;
            border-top: 1px dashed var(--border-color);
            font-size: 10px;
            color: var(--text-muted);
        }
        
        .tip-note strong {
            color: var(--warning);
        }
        
        /* Buttons */
        .actions {
            display: flex;
            gap: 8px;
            margin-top: 16px;
        }
        
        .btn {
            flex: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            padding: 10px 16px;
            border: 1px solid var(--border-color);
            border-radius: 2px;
            background: var(--bg-card);
            color: var(--text-primary);
            font-size: 10px;
            font-weight: 600;
            font-family: inherit;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            cursor: pointer;
            transition: all 0.15s;
        }
        
        .btn:hover {
            background: var(--border-color);
        }
        
        .btn-primary {
            background: var(--text-primary);
            color: var(--bg-primary);
            border-color: var(--text-primary);
        }
        
        .btn-primary:hover {
            background: var(--text-secondary);
            border-color: var(--text-secondary);
        }
        
        .btn-warning {
            background: var(--warning);
            color: var(--bg-primary);
            border-color: var(--warning);
        }
        
        .btn-warning:hover {
            opacity: 0.9;
        }
        
        .btn-sm {
            flex: none;
            padding: 6px 12px;
            font-size: 9px;
        }
        
        /* Footer */
        .footer {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-top: 20px;
            padding-top: 16px;
            border-top: 1px solid var(--border-color);
            font-size: 10px;
            color: var(--text-muted);
        }
        
        .countdown-num {
            font-weight: 600;
            color: var(--text-secondary);
        }
    </style>
</head>
<body>
    <div class="container">
        <!-- Header -->
        <div class="header">
            <div class="status-indicator"></div>
            <span class="title">${t.title}</span>
            <span class="env-badge">${isLocal ? t.local : t.remote}</span>
            <span class="status-badge">${statusText}</span>
            <div class="lang-toggle">
                <button class="lang-btn ${this.currentLang === 'zh' ? 'active' : ''}" onclick="setLang('zh')">中</button>
                <button class="lang-btn ${this.currentLang === 'en' ? 'active' : ''}" onclick="setLang('en')">EN</button>
            </div>
        </div>
        
        ${!isLocal && !status.remoteProxyReachable ? `
        <!-- Warning Alert -->
        <div class="alert alert-warning">
            <div class="alert-icon">⚠</div>
            <div class="alert-content">
                <div class="alert-title">${t.tunnelWarningTitle}</div>
                <div class="alert-message">${t.tunnelWarningMsg}</div>
                <div class="alert-steps">
                    <div class="alert-step"><span class="step-num">1</span>${t.tunnelStep1}</div>
                    <div class="alert-step"><span class="step-num">2</span>${t.tunnelStep2}</div>
                    <div class="alert-step"><span class="step-num">3</span>${t.tunnelStep3}</div>
                </div>
                <button class="btn btn-warning" onclick="runDiagnostics()">${t.runCheck}</button>
            </div>
        </div>
        ` : ''}
        
        <!-- Status & Config Card -->
        <div class="card" style="margin-bottom: 16px;">
            <div class="card-header">
                <span class="card-title"><span class="card-title-icon">⚡</span>${t.statusConfig}</span>
            </div>
            <div class="card-body">
                ${isLocal ? `
                <div class="row">
                    <span class="row-label">${t.sshForwarding}</span>
                    <span class="row-value ${status.sshConfigEnabled ? 'success' : 'error'}">${status.sshConfigEnabled ? t.on : t.off}</span>
                </div>
                <div class="row">
                    <span class="row-label">${t.localProxy}</span>
                    <span class="row-value ${status.localProxyReachable ? 'success' : 'error'}">${status.localProxyReachable ? t.reachable : t.unreachable}</span>
                </div>
                <div class="input-row">
                    <label>${t.enableForwarding}</label>
                    <label class="toggle">
                        <input type="checkbox" id="enableForwarding" ${enableForwarding ? 'checked' : ''}>
                        <span class="toggle-slider"></span>
                    </label>
                </div>
                <div class="input-row">
                    <label>${t.localPort}</label>
                    <input type="number" id="localProxyPort" value="${status.localProxyPort}" min="1" max="65535">
                </div>
                <div class="input-row">
                    <label>${t.remotePort}</label>
                    <input type="number" id="remoteProxyPort" value="${status.remoteProxyPort}" min="1" max="65535">
                </div>
                ` : `
                <div class="row">
                    <span class="row-label">${t.proxy}</span>
                    <span class="row-value ${status.remoteProxyReachable ? 'success' : 'error'}">${status.remoteProxyReachable ? t.reachable : t.unreachable}</span>
                    <span class="row-extra">${status.remoteProxyHost}</span>
                </div>
                ${status.languageServerConfigured !== undefined ? `
                <div class="row">
                    <span class="row-label">${t.languageServer}</span>
                    <span class="row-value ${status.languageServerConfigured ? 'success' : 'error'}">${status.languageServerConfigured ? t.configured : t.notConfigured}</span>
                </div>
                ` : ''}
                <div class="input-row">
                    <label>${t.proxyHost}</label>
                    <input type="text" id="remoteProxyHost" value="${status.remoteProxyHost}">
                </div>
                <div class="input-row">
                    <label>${t.proxyPort}</label>
                    <input type="number" id="remoteProxyPort" value="${status.remoteProxyPort}" min="1" max="65535">
                </div>
                <div class="input-row">
                    <label>${t.proxyType}</label>
                    <select id="proxyType" onchange="saveConfig()">
                        <option value="http" ${proxyType === 'http' ? 'selected' : ''}>${t.proxyTypeHttp}</option>
                        <option value="socks5" ${proxyType === 'socks5' ? 'selected' : ''}>${t.proxyTypeSocks5}</option>
                    </select>
                </div>
                `}
            </div>
        </div>
        
        <!-- Diagnostics Card -->
        <div class="card" style="margin-bottom: 16px;">
            <div class="card-header">
                <span class="card-title"><span class="card-title-icon">◎</span>${t.diagnostics}</span>
                <div style="display: flex; gap: 6px;">
                    <button class="btn btn-sm" onclick="runDiagnostics()" ${this.isRunningDiagnostics ? 'disabled' : ''}>
                        ${this.isRunningDiagnostics ? t.running : t.runCheck}
                    </button>
                    <button class="btn btn-sm" onclick="copyReport()" ${!this.currentDiagnosticReport ? 'disabled' : ''}>
                        ${t.copyReport}
                    </button>
                </div>
            </div>
            <div class="card-body">
                ${diagnosticsHtml}
            </div>
        </div>
        
        <!-- Tips & Traffic Grid -->
        <div class="grid">
            <!-- Tips Card -->
            <div class="card">
                <div class="card-header">
                    <span class="card-title"><span class="card-title-icon">◇</span>${t.tips}</span>
                </div>
                <div class="card-body">
                    <div class="tip-content">
                        ${isLocal ? `
                        <div class="tip-title">${t.tipTitleLocal}</div>
                        <ul class="tip-steps">
                            <li class="tip-step"><span class="step-num">1</span><span>${t.tipStep1Local}</span></li>
                            <li class="tip-step"><span class="step-num">2</span><span>${t.tipStep2Local}</span></li>
                            <li class="tip-step"><span class="step-num">3</span><span>${t.tipStep3Local}</span></li>
                            <li class="tip-step"><span class="step-num">4</span><span>${t.tipStep4Local}</span></li>
                        </ul>
                        <div class="tip-note"><strong>⚠</strong> ${t.tipNoteLocal}</div>
                        ` : `
                        <div class="tip-title">${t.tipTitleRemote}</div>
                        <ul class="tip-steps">
                            <li class="tip-step"><span class="step-num">1</span><span>${t.tipStep1Remote}</span></li>
                            <li class="tip-step"><span class="step-num">2</span><span>${t.tipStep2Remote}</span></li>
                            <li class="tip-step"><span class="step-num">3</span><span>${t.tipStep3Remote}</span></li>
                            <li class="tip-step"><span class="step-num">4</span><span>${t.tipStep4Remote}</span></li>
                        </ul>
                        <div class="tip-note">${t.tipNoteRemote}</div>
                        <div style="margin-top: 12px; padding-top: 8px; border-top: 1px dashed var(--border-color);">
                            <div class="tip-title" style="color: var(--error); margin-bottom: 4px;">${t.rollbackTitle}</div>
                            <div style="font-size: 10px; color: var(--text-muted);">${t.rollbackDesc}</div>
                        </div>
                        `}
                    </div>
                </div>
            </div>
            
            <!-- Traffic Card -->
            ${trafficHtml}
        </div>
        
        <!-- Actions -->
        <div class="actions">
            <button class="btn" onclick="rollback()">${t.rollback}</button>
            <button class="btn" onclick="refresh()">${t.refresh}</button>
            <button class="btn btn-primary" onclick="saveConfig()">${t.save}</button>
        </div>
        
        <!-- Footer -->
        <div class="footer">
            <span>${t.autoRefresh}: <span class="countdown-num" id="countdown">${this.secondsUntilRefresh}</span>s</span>
            <span>${t.updated} ${status.lastUpdated.toLocaleTimeString()}</span>
        </div>
    </div>
    
    <script>
        const vscode = acquireVsCodeApi();
        const isLocal = ${isLocal};
        
        function refresh() {
            vscode.postMessage({ command: 'refresh' });
        }
        
        function rollback() {
            vscode.postMessage({ command: 'rollback' });
        }
        
        function saveConfig() {
            const config = {};
            if (isLocal) {
                config.enableLocalForwarding = document.getElementById('enableForwarding').checked;
                config.localProxyPort = parseInt(document.getElementById('localProxyPort').value);
                config.remoteProxyPort = parseInt(document.getElementById('remoteProxyPort').value);
            } else {
                config.remoteProxyHost = document.getElementById('remoteProxyHost').value;
                config.remoteProxyPort = parseInt(document.getElementById('remoteProxyPort').value);
                config.proxyType = document.getElementById('proxyType').value;
            }
            vscode.postMessage({ command: 'saveConfig', config });
        }
        
        function runDiagnostics() {
            vscode.postMessage({ command: 'runDiagnostics' });
        }
        
        function copyReport() {
            vscode.postMessage({ command: 'copyReport' });
        }
        
        function setLang(lang) {
            vscode.postMessage({ command: 'setLanguage', lang });
        }
        
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'updateCountdown') {
                const el = document.getElementById('countdown');
                if (el) el.textContent = message.seconds;
            }
        });
    </script>
</body>
</html>`;
    }

    /**
     * Generate diagnostics section HTML
     */
    private generateDiagnosticsHtml(t: typeof i18n.zh, isLocal: boolean): string {
        const checks = this.currentDiagnosticReport?.checks || [
            { id: 'local-proxy', name: 'Local Proxy Service', status: 'pending' as const },
            { id: 'ssh-config', name: 'SSH Configuration', status: 'pending' as const },
            { id: 'remote-forward', name: 'Remote Proxy Endpoint', status: 'pending' as const },
            { id: 'mgraftcp', name: 'mgraftcp Binary', status: 'pending' as const },
            { id: 'ls-wrapper', name: 'Language Server Wrapper', status: 'pending' as const },
            { id: 'external-connectivity', name: 'External Connectivity', status: 'pending' as const }
        ];

        return checks.map(check => {
            const isLocalCheck = ['local-proxy', 'ssh-config'].includes(check.id);
            const isRemoteCheck = !isLocalCheck;
            const isDisabled = (isLocal && isRemoteCheck) || (!isLocal && isLocalCheck);
            
            let statusText = '';
            let statusClass = '';
            
            if (isDisabled) {
                statusText = isLocal ? t.remoteOnly : t.localOnly;
                statusClass = 'muted';
            } else if (check.status === 'pending') {
                statusText = t.pending;
                statusClass = '';
            } else if (check.status === 'running') {
                statusText = '...';
                statusClass = '';
            } else if (check.status === 'success') {
                statusText = '✓';
                statusClass = 'success';
            } else if (check.status === 'warning') {
                statusText = '!';
                statusClass = 'warning';
            } else if (check.status === 'error') {
                statusText = '✗';
                statusClass = 'error';
            }
            
            // Get message and suggestion from the check
            const message = (check as DiagnosticCheck).message;
            const suggestion = (check as DiagnosticCheck).suggestion;
            const protocolResults = (check as DiagnosticCheck).protocolResults;
            const hasDetails = !isDisabled && (message || suggestion || protocolResults);
            
            // Generate protocol list HTML for external-connectivity check
            let protocolListHtml = '';
            if (check.id === 'external-connectivity' && protocolResults && protocolResults.length > 0) {
                protocolListHtml = `
                    <div class="protocol-list">
                        ${protocolResults.map((result: ProtocolTestResult, index: number) => {
                            const isLast = index === protocolResults.length - 1;
                            const prefix = isLast ? '└──' : '├──';
                            const statusIcon = result.success ? '✓' : '✗';
                            const statusClass = result.success ? 'success' : 'error';
                            const statusText = result.success ? 'Available' : 'Not working';
                            const currentLabel = result.isCurrent ? ' ← Current' : '';
                            return `
                                <div class="protocol-item">
                                    <span class="protocol-prefix">${prefix}</span>
                                    <span class="protocol-name">${result.protocol.toUpperCase()}:</span>
                                    <span class="protocol-status ${statusClass}">${statusIcon} ${statusText}</span>
                                    ${result.isCurrent ? `<span class="protocol-current">${currentLabel}</span>` : ''}
                                </div>
                            `;
                        }).join('')}
                    </div>
                `;
            }
            
            return `
                <div class="diag-item-wrapper">
                    <div class="diag-item">
                        <div class="diag-dot ${isDisabled ? 'pending' : check.status}"></div>
                        <span class="diag-name ${isDisabled ? 'disabled' : ''}">${this.getDiagnosticCheckName(check.id, t)}</span>
                        <span class="diag-status ${statusClass}">${statusText}</span>
                    </div>
                    ${hasDetails ? `
                    <div class="diag-details">
                        ${protocolListHtml}
                        ${message && !protocolResults ? `<div class="diag-message">${message}</div>` : ''}
                        ${suggestion ? `<div class="diag-suggestion">💡 ${suggestion}</div>` : ''}
                    </div>
                    ` : ''}
                </div>
            `;
        }).join('');
    }

    /**
     * Generate traffic section HTML
     */
    private generateTrafficHtml(t: typeof i18n.zh, stats: TrafficStats, isLocal: boolean): string {
        if (isLocal) {
            return `
                <div class="card">
                    <div class="card-header">
                        <span class="card-title"><span class="card-title-icon">◈</span>${t.traffic}</span>
                    </div>
                    <div class="card-body">
                        <div class="traffic-unavailable">${t.remoteOnly}</div>
                    </div>
                </div>
            `;
        }

        const sessionDuration = this.trafficCollector.getSessionDuration();
        const barWidth = Math.min(stats.activeConnections * 10, 100);

        return `
            <div class="card">
                <div class="card-header">
                    <span class="card-title"><span class="card-title-icon">◈</span>${t.traffic}</span>
                </div>
                <div class="card-body">
                    <div class="traffic-stat">
                        <div class="traffic-label">${t.connections}</div>
                        <div class="traffic-value">${stats.activeConnections}</div>
                        <div class="traffic-bar">
                            <div class="traffic-bar-fill" style="width: ${barWidth}%"></div>
                        </div>
                    </div>
                    <div class="traffic-stat">
                        <div class="traffic-label">${t.session}</div>
                        <div class="traffic-value small">${sessionDuration}</div>
                    </div>
                    <div class="traffic-stat">
                        <div class="traffic-label">${t.totalRequests}</div>
                        <div class="traffic-value small">${stats.totalConnectionsSeen}</div>
                    </div>
                </div>
            </div>
        `;
    }

    dispose(): void {
        this.stopAutoRefresh();
        this.statusBarItem.dispose();
        this.statusPanel?.dispose();
        this.trafficCollector.dispose();
        this.updateCallbacks = [];
    }
}
