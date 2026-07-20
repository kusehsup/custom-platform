import * as vscode from 'vscode';
import { PlatformAgent } from './agent';

/**
 * Виртуальная ФС `pawn:` — один документ на выданный блок кода.
 * URI: pawn:/<file_id>~<part_index>/<basename>
 *
 * readFile  → agent.get_block (тянем содержимое блока)
 * writeFile → agent.save_block (шлём set_code по part_index с текущим hash;
 *             при конфликте версий спрашиваем перезапись).
 */
export class PawnFS implements vscode.FileSystemProvider {
    private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile = this._emitter.event;
    private hashes = new Map<string, string>();

    constructor(private agent: PlatformAgent) {}

    private parse(uri: vscode.Uri): { fileId: string; partIndex: number } {
        const seg = uri.path.split('/').filter(Boolean);
        const key = seg[0] || '';
        const [fileId, partStr] = key.split('~');
        return { fileId, partIndex: parseInt(partStr || '0', 10) };
    }

    watch(): vscode.Disposable {
        return new vscode.Disposable(() => undefined);
    }

    async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        if (!uri.path.includes('~')) {
            return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
        }
        const { fileId, partIndex } = this.parse(uri);
        try {
            const blk = await this.agent.call('get_block', { file_id: fileId, part_index: partIndex });
            this.hashes.set(uri.toString(), blk.hash);
            return {
                type: vscode.FileType.File,
                ctime: 0,
                mtime: Date.now(),
                size: Buffer.byteLength(blk.content, 'utf8'),
            };
        } catch {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
    }

    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        const { fileId, partIndex } = this.parse(uri);
        const blk = await this.agent.call('get_block', { file_id: fileId, part_index: partIndex });
        this.hashes.set(uri.toString(), blk.hash);
        return Buffer.from(blk.content, 'utf8');
    }

    async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
        const { fileId, partIndex } = this.parse(uri);
        const text = Buffer.from(content).toString('utf8');
        const hash = this.hashes.get(uri.toString());

        const res = await this.agent.call('save_block', {
            file_id: fileId, part_index: partIndex, content: text, hash,
        });

        if (res.conflict) {
            const pick = await vscode.window.showWarningMessage(
                'Блок изменён на платформе. Перезаписать серверную версию?',
                'Перезаписать', 'Отмена',
            );
            if (pick !== 'Перезаписать') {
                throw vscode.FileSystemError.NoPermissions('Сохранение отменено (конфликт версий)');
            }
            const res2 = await this.agent.call('save_block', {
                file_id: fileId, part_index: partIndex, content: text, hash: res.current_hash,
            });
            if (res2.new_hash) {
                this.hashes.set(uri.toString(), res2.new_hash);
            }
            return;
        }

        if (res.new_hash) {
            this.hashes.set(uri.toString(), res.new_hash);
        }
    }

    readDirectory(): [string, vscode.FileType][] {
        return [];
    }

    createDirectory(): void {
        // no-op
    }

    delete(): void {
        throw vscode.FileSystemError.NoPermissions('Удаление не поддерживается');
    }

    rename(): void {
        throw vscode.FileSystemError.NoPermissions('Переименование не поддерживается');
    }
}
