import * as vscode from 'vscode';
import * as net from 'net';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface TrafficStats {
    activeConnections: number;
    totalConnectionsSeen: number;
    sessionStartTime: Date;
    lastUpdated: Date;
    proxyReachable: boolean;
}

type StatsUpdateCallback = (stats: TrafficStats) => void;

export class TrafficCollector {
    private stats: TrafficStats;
    private refreshInterval: NodeJS.Timeout | undefined;
    private updateCallbacks: StatsUpdateCallback[] = [];
    private peakConnections: number = 0;
    private readonly refreshIntervalMs: number = 2000;

    constructor() {
        this.stats = {
            activeConnections: 0,
            totalConnectionsSeen: 0,
            sessionStartTime: new Date(),
            lastUpdated: new Date(),
            proxyReachable: false
        };
    }

    /**
     * Check if running in remote environment
     */
    isRemote(): boolean {
        return !!vscode.env.remoteName;
    }

    /**
     * Start collecting traffic statistics
     */
    start(): void {
        if (!this.isRemote()) {
            return;
        }

        this.stats.sessionStartTime = new Date();
        this.stop(); // Clear any existing interval
        
        // Initial collection
        this.collect();
        
        // Set up periodic collection
        this.refreshInterval = setInterval(() => {
            this.collect();
        }, this.refreshIntervalMs);
    }

    /**
     * Stop collecting traffic statistics
     */
    stop(): void {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = undefined;
        }
    }

    /**
     * Register a callback for stats updates
     */
    onUpdate(callback: StatsUpdateCallback): vscode.Disposable {
        this.updateCallbacks.push(callback);
        return new vscode.Disposable(() => {
            const index = this.updateCallbacks.indexOf(callback);
            if (index >= 0) {
                this.updateCallbacks.splice(index, 1);
            }
        });
    }

    /**
     * Get current statistics
     */
    getStats(): TrafficStats {
        return { ...this.stats };
    }

    /**
     * Manually trigger a stats refresh
     */
    async refresh(): Promise<TrafficStats> {
        await this.collect();
        return this.getStats();
    }

    /**
     * Collect traffic statistics
     */
    private async collect(): Promise<void> {
        const config = vscode.workspace.getConfiguration('antigravity-ssh-proxy');
        const remoteProxyHost = config.get<string>('remoteProxyHost', '127.0.0.1');
        const remoteProxyPort = config.get<number>('remoteProxyPort', 34380);

        // Check proxy reachability
        this.stats.proxyReachable = await this.checkPort(remoteProxyHost, remoteProxyPort);

        // Get active connections using ss command
        const activeConnections = await this.getActiveConnections(remoteProxyPort);
        
        // Track total connections seen
        // Simple heuristic: if current connections > peak, we've seen new connections
        if (activeConnections > this.peakConnections) {
            this.stats.totalConnectionsSeen += (activeConnections - this.peakConnections);
            this.peakConnections = activeConnections;
        } else if (activeConnections < this.peakConnections) {
            // Connections closed, but peak remains as reference for next surge
            // We add the difference to estimate "requests processed"
            this.stats.totalConnectionsSeen += this.peakConnections - activeConnections;
            this.peakConnections = activeConnections;
        }

        this.stats.activeConnections = activeConnections;
        this.stats.lastUpdated = new Date();

        // Notify callbacks
        for (const callback of this.updateCallbacks) {
            callback(this.getStats());
        }
    }

    /**
     * Get active connection count using ss command
     */
    private async getActiveConnections(port: number): Promise<number> {
        try {
            const { stdout } = await execAsync(
                `ss -tn state established '( dport = :${port} or sport = :${port} )' 2>/dev/null | tail -n +2 | wc -l`,
                { timeout: 5000 }
            );
            const count = parseInt(stdout.trim(), 10);
            return isNaN(count) ? 0 : count;
        } catch {
            return 0;
        }
    }

    /**
     * Check if a port is reachable
     */
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

    /**
     * Get session duration in human-readable format
     */
    getSessionDuration(): string {
        const now = new Date();
        const diffMs = now.getTime() - this.stats.sessionStartTime.getTime();
        const diffSec = Math.floor(diffMs / 1000);
        
        const hours = Math.floor(diffSec / 3600);
        const minutes = Math.floor((diffSec % 3600) / 60);
        const seconds = diffSec % 60;

        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }

    dispose(): void {
        this.stop();
        this.updateCallbacks = [];
    }
}
