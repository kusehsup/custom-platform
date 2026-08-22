import * as vscode from 'vscode';
import { PlatformAgent } from './agent';

export interface PartInfo {
    part_index: number;
    line: number;
    hash: string;
    lines: number;
    preview?: string;
}

export interface FileEntry {
    file_id: string;
    name: string;
    fullPath: string;
    parts: PartInfo[];
}

export function blockUri(file: FileEntry, part: PartInfo): vscode.Uri {
    return vscode.Uri.parse(`pawn:/${file.file_id}~${part.part_index}/${file.name}`);
}

export class PlatformTree implements vscode.TreeDataProvider<TreeNode> {
    private _emitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._emitter.event;
    private files: FileEntry[] = [];
    private _showAll = false;

    constructor(private agent: PlatformAgent) {}

    get showAll(): boolean {
        return this._showAll;
    }

    setShowAll(v: boolean): void {
        this._showAll = v;
        this._emitter.fire();
    }

    /** Доступен ли файл (есть выданные блоки/полный доступ). */
    private isAccessible(f: FileEntry): boolean {
        return f.parts.length > 0;
    }

    async refresh(): Promise<void> {
        try {
            const r = await this.agent.call('list_files');
            this.files = (r.files || []) as FileEntry[];
        } catch {
            this.files = [];
        }
        this._emitter.fire();
    }

    clear(): void {
        this.files = [];
        this._emitter.fire();
    }

    getTreeItem(node: TreeNode): vscode.TreeItem {
        return node;
    }

    getChildren(node?: TreeNode): TreeNode[] {
        if (!node) {
            // По умолчанию — только доступные файлы; по кнопке — все.
            const list = this._showAll ? this.files : this.files.filter((f) => this.isAccessible(f));
            return list.map((f) => new TreeNode(f));
        }
        if (node.file && node.file.parts.length > 1 && node.part === undefined) {
            return node.file.parts.map((p) => new TreeNode(node.file!, p));
        }
        return [];
    }
}

export class TreeNode extends vscode.TreeItem {
    constructor(public file?: FileEntry, public part?: PartInfo) {
        super('', vscode.TreeItemCollapsibleState.None);

        if (file && part === undefined) {
            const noAccess = file.parts.length === 0;
            if (file.parts.length > 1) {
                this.label = file.name;
                this.description = `${file.fullPath} · ${file.parts.length} блоков`;
                this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
                this.iconPath = new vscode.ThemeIcon('file-code');
            } else {
                this.label = file.name;
                this.description = file.fullPath + (noAccess ? ' · нет доступа' : '');
                this.iconPath = new vscode.ThemeIcon(noAccess ? 'lock' : 'file-code');
                if (!noAccess) {
                    this.command = {
                        command: 'platformSync.openBlock',
                        title: 'Открыть',
                        arguments: [blockUri(file, file.parts[0])],
                    };
                }
            }
        } else if (file && part) {
            // Заголовок блока — его первая строка, чтобы сразу ориентироваться.
            const preview = (part.preview || '').trim();
            this.label = preview || `строка ${part.line}`;
            this.description = `@ ${part.line} · ${part.lines} строк`;
            this.tooltip = `${file.fullPath}\nблок со строки ${part.line} (${part.lines} строк)` +
                (preview ? `\n\n${preview}` : '');
            this.iconPath = new vscode.ThemeIcon('symbol-namespace');
            this.command = {
                command: 'platformSync.openBlock',
                title: 'Открыть',
                arguments: [blockUri(file, part)],
            };
        }
    }
}
