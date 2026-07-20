import * as cp from 'child_process';
import * as vscode from 'vscode';

interface Pending {
    resolve: (v: any) => void;
    reject: (e: any) => void;
    timer: NodeJS.Timeout;
}

export interface AgentEvent {
    event: string;
    data: any;
}

/**
 * Клиент к Python sync-агенту: спавнит процесс и общается по JSON-RPC поверх
 * stdio (по одному JSON на строку). Ответы матчятся по id, события (без id)
 * прокидываются через onEvent.
 */
export class PlatformAgent {
    private proc?: cp.ChildProcessWithoutNullStreams;
    private nextId = 1;
    private pending = new Map<number, Pending>();
    private buffer = '';
    private emitter = new vscode.EventEmitter<AgentEvent>();
    readonly onEvent = this.emitter.event;

    isRunning(): boolean {
        return !!this.proc;
    }

    start(pythonPath: string, cwd: string, platformUrl: string, proxyUrl: string): void {
        if (this.proc) {
            return;
        }
        this.proc = cp.spawn(
            pythonPath,
            ['-m', 'sync.agent', '--platform-url', platformUrl, '--proxy-url', proxyUrl],
            { cwd, env: { ...process.env, PYTHONPATH: cwd } },
        );
        this.proc.stdout.setEncoding('utf-8');
        this.proc.stdout.on('data', (chunk: string) => this.onData(chunk));
        this.proc.stderr.on('data', (d: Buffer) => console.error('[platform-agent]', d.toString()));
        this.proc.on('exit', (code) => this.cleanup(code));
    }

    private onData(chunk: string): void {
        this.buffer += chunk;
        let idx: number;
        while ((idx = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, idx).trim();
            this.buffer = this.buffer.slice(idx + 1);
            if (!line) {
                continue;
            }
            let msg: any;
            try {
                msg = JSON.parse(line);
            } catch {
                continue;
            }
            if (typeof msg.id === 'number') {
                const p = this.pending.get(msg.id);
                if (p) {
                    this.pending.delete(msg.id);
                    clearTimeout(p.timer);
                    if (msg.error) {
                        p.reject(new Error(msg.error));
                    } else {
                        p.resolve(msg.result);
                    }
                }
            } else if (msg.event) {
                this.emitter.fire({ event: msg.event, data: msg.data });
            }
        }
    }

    call(method: string, params: any = {}, timeoutMs = 130000): Promise<any> {
        if (!this.proc) {
            return Promise.reject(new Error('Агент не запущен'));
        }
        const id = this.nextId++;
        const payload = JSON.stringify({ id, method, params }) + '\n';
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    reject(new Error('Таймаут запроса: ' + method));
                }
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.proc!.stdin.write(payload);
        });
    }

    private cleanup(code: number | null): void {
        for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(new Error('Агент завершился (code ' + code + ')'));
        }
        this.pending.clear();
        this.proc = undefined;
    }

    stop(): void {
        if (this.proc) {
            try {
                this.proc.stdin.end();
            } catch {
                // ignore
            }
            this.proc.kill();
            this.proc = undefined;
        }
    }
}
