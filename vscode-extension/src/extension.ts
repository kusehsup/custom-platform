import * as vscode from 'vscode';
import { PlatformAgent, AgentEvent } from './agent';
import { PawnFS } from './fsProvider';
import { PlatformTree } from './tree';

let agent: PlatformAgent;
let tree: PlatformTree;
let treeView: vscode.TreeView<any>;
let serverChannel: vscode.OutputChannel;
let compileChannel: vscode.OutputChannel;
let statusItem: vscode.StatusBarItem;
let connected = false;
let lastServer = 'unknown';

export function activate(ctx: vscode.ExtensionContext): void {
    agent = new PlatformAgent();
    tree = new PlatformTree(agent);
    const fs = new PawnFS(agent);

    serverChannel = vscode.window.createOutputChannel('Platform: Server');
    compileChannel = vscode.window.createOutputChannel('Platform: Compile');
    statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusItem.command = 'platformSync.connect';
    updateStatus();
    statusItem.show();

    treeView = vscode.window.createTreeView('platformSyncFiles', { treeDataProvider: tree });

    ctx.subscriptions.push(
        vscode.workspace.registerFileSystemProvider('pawn', fs, { isCaseSensitive: true }),
        treeView,
        serverChannel,
        compileChannel,
        statusItem,
        agent.onEvent(handleEvent),
    );

    setShowAll(false);

    const reg = (id: string, fn: (...a: any[]) => any) =>
        ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

    reg('platformSync.connect', () => connect(ctx));
    reg('platformSync.disconnect', () => disconnect());
    reg('platformSync.refresh', () => tree.refresh());
    reg('platformSync.showAllFiles', () => setShowAll(true));
    reg('platformSync.showAccessibleFiles', () => setShowAll(false));
    reg('platformSync.openBlock', (uri: vscode.Uri) => openBlock(uri));
    reg('platformSync.compile', () => compile());
    reg('platformSync.startServer', () => serverCmd('start_server'));
    reg('platformSync.stopServer', () => serverCmd('stop_server'));
    reg('platformSync.showConsole', () => serverChannel.show());
}

async function connect(ctx: vscode.ExtensionContext): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('platformSync');
    const platformUrl = cfg.get<string>('platformUrl', '');
    const proxyUrl = cfg.get<string>('proxyUrl', '');
    const pythonPath = cfg.get<string>('pythonPath', 'python3');
    const agentCwd =
        cfg.get<string>('agentCwd', '') ||
        vscode.workspace.workspaceFolders?.[0].uri.fsPath ||
        '';

    if (!platformUrl) {
        vscode.window.showErrorMessage('Задай platformSync.platformUrl в настройках.');
        return;
    }

    const prevLogin = (await ctx.secrets.get('platformSync.login')) || '';
    const login = await vscode.window.showInputBox({ prompt: 'Логин платформы', value: prevLogin });
    if (login === undefined) {
        return;
    }
    const password = await vscode.window.showInputBox({ prompt: 'Пароль платформы', password: true });
    if (password === undefined) {
        return;
    }
    await ctx.secrets.store('platformSync.login', login);

    agent.start({
        extensionPath: ctx.extensionPath,
        pythonPath,
        cwd: agentCwd,
        platformUrl,
        proxyUrl,
    });
    await new Promise((r) => setTimeout(r, 300));

    try {
        const res = await agent.call('connect', { login, password }, 40000);
        if (!res.connected) {
            vscode.window.showErrorMessage('Подключение не удалось: ' + (res.error || ''));
            return;
        }
        connected = true;
        updateStatus();
        await tree.refresh();
        const mode = agent.launchMode === 'bundled' ? 'встроенный агент' : 'python-агент';
        vscode.window.showInformationMessage(`Подключено к платформе (${mode}).`);
    } catch (e: any) {
        vscode.window.showErrorMessage('Ошибка подключения: ' + e.message);
    }
}

async function disconnect(): Promise<void> {
    try {
        await agent.call('disconnect', {}, 5000);
    } catch {
        // ignore
    }
    agent.stop();
    connected = false;
    tree.clear();
    updateStatus();
}

async function openBlock(uri: vscode.Uri): Promise<void> {
    try {
        const doc = await vscode.workspace.openTextDocument(uri);
        // Pawn ≈ C: включаем C-подсветку (у VS Code нет встроенного pawn)
        await vscode.languages.setTextDocumentLanguage(doc, 'c');
        await vscode.window.showTextDocument(doc);
    } catch (e: any) {
        vscode.window.showErrorMessage('Не удалось открыть блок: ' + e.message);
    }
}

async function compile(): Promise<void> {
    compileChannel.show(true);
    compileChannel.appendLine('▶ Компиляция...');
    try {
        const r = await agent.call('compile');
        compileChannel.appendLine(r.result || '(пустой ответ)');
    } catch (e: any) {
        compileChannel.appendLine('Ошибка: ' + e.message);
    }
}

async function serverCmd(method: 'start_server' | 'stop_server'): Promise<void> {
    try {
        const r = await agent.call(method);
        lastServer = r.server;
        updateStatus();
        vscode.window.showInformationMessage('Сервер: ' + r.server);
        if (method === 'start_server') {
            serverChannel.show(true);
        }
    } catch (e: any) {
        vscode.window.showErrorMessage('Ошибка: ' + e.message);
    }
}

function handleEvent(ev: AgentEvent): void {
    switch (ev.event) {
        case 'server_log':
            serverChannel.appendLine(ev.data.line);
            break;
        // compile_result выводится из ответа команды compile() — не дублируем здесь
        case 'status':
            if (ev.data.server) {
                lastServer = ev.data.server;
            }
            updateStatus(ev.data.compile);
            break;
        case 'code_updated':
            tree.refresh();
            break;
    }
}

function setShowAll(value: boolean): void {
    tree.setShowAll(value);
    // Контекст управляет тем, какая кнопка-переключатель видна в шапке вью.
    vscode.commands.executeCommand('setContext', 'platformSync.showAll', value);
    if (treeView) {
        treeView.description = value ? 'все файлы' : 'только доступные';
    }
}

function updateStatus(compiling?: boolean): void {
    const conn = connected ? '$(plug) Платформа' : '$(debug-disconnect) Платформа: не подключено';
    const srv = connected ? ` · сервер: ${lastServer}` : '';
    const comp = compiling ? ' · компиляция…' : '';
    statusItem.text = conn + srv + comp;
    statusItem.tooltip = 'CustomPlatform Sync';
}

export function deactivate(): void {
    agent?.stop();
}
