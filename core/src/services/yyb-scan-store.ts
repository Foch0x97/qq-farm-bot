import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { WxCredentials } from './wx-login/credentials';

export interface ScanConfig { enabled: boolean; reconnectDelayMin: number; reconnectMaxAttempts: number; }
export interface ScanRecord extends ScanConfig { session: string; codeHash: string; credentials: WxCredentials; needsScan?: boolean; updatedAt: number; }
export function normalizeScanConfig(input: any): ScanConfig {
    if (input?.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error('重连开关无效');
    const config = { enabled: input?.enabled ?? true, reconnectDelayMin: 3, reconnectMaxAttempts: 3 };
    for (const key of ['reconnectDelayMin', 'reconnectMaxAttempts'] as const) {
        if (input?.[key] === undefined) continue;
        const value = Number(input[key]);
        if (!Number.isSafeInteger(value) || value < 1 || value > (key === 'reconnectDelayMin' ? 10080 : 10000)) throw new Error('重连时间和次数必须为有效正整数');
        config[key] = value;
    }
    return config;
}
export class ScanStore {
    constructor(private directory: string) {}
    defaults(): ScanConfig {
        const { readJsonFile } = require('./json-db');
        return normalizeScanConfig(readJsonFile(path.join(this.directory, 'yyb-scan-defaults.json'), () => ({})));
    }
    saveDefaults(config: ScanConfig): void {
        const { writeJsonFileAtomic } = require('./json-db');
        fs.mkdirSync(this.directory, { recursive: true });
        writeJsonFileAtomic(path.join(this.directory, 'yyb-scan-defaults.json'), normalizeScanConfig(config));
    }
    private hash(code: string): string { return crypto.createHash('sha256').update(code).digest('hex'); }
    private key(create = false): Buffer {
        const filename = path.join(this.directory, 'yyb-scan-authorization.key');
        if (create && !fs.existsSync(filename)) {
            fs.mkdirSync(this.directory, { recursive: true });
            fs.writeFileSync(filename, crypto.randomBytes(32), { mode: 0o600, flag: 'wx' });
        }
        const key = fs.readFileSync(filename);
        if (key.length !== 32) throw new Error('应用宝扫码密钥无效');
        return key;
    }
    list(): Record<string, ScanRecord> {
        const filename = path.join(this.directory, 'yyb-scan-authorization.enc');
        if (!fs.existsSync(filename)) return {};
        try {
            const envelope = JSON.parse(fs.readFileSync(filename, 'utf8'));
            const decipher = crypto.createDecipheriv('aes-256-gcm', this.key(), Buffer.from(envelope.iv, 'base64'));
            decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
            return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8'));
        } catch { throw new Error('应用宝扫码授权无法读取，请恢复完整备份'); }
    }
    private write(records: Record<string, ScanRecord>): void {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', this.key(true), iv);
        const data = Buffer.concat([cipher.update(JSON.stringify(records), 'utf8'), cipher.final()]);
        const filename = path.join(this.directory, 'yyb-scan-authorization.enc');
        const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
        try {
            fs.writeFileSync(temporary, JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }), { mode: 0o600, flag: 'wx' });
            fs.renameSync(temporary, filename);
        } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    }
    get(id: string): ScanRecord | undefined { return this.list()[id]; }
    matches(id: string, account: any): boolean {
        const record = this.get(id);
        return account?.platform === 'wx' && !!record && record.codeHash === this.hash(String(account.code || ''));
    }
    set(id: string, config: ScanConfig, code: string, credentials: WxCredentials): void {
        const records = this.list();
        records[id] = { ...normalizeScanConfig(config), credentials: { ...credentials }, session: crypto.randomUUID(), codeHash: this.hash(code), updatedAt: Date.now() };
        this.write(records);
    }
    update(id: string, session: string, changes: Partial<ScanRecord>, code?: string): boolean {
        const records = this.list();
        if (records[id]?.session !== session) return false;
        records[id] = { ...records[id], ...changes, updatedAt: Date.now(), ...(code === undefined ? {} : { codeHash: this.hash(code) }) };
        this.write(records); return true;
    }
    remove(id: string): void {
        const records = this.list();
        if (!records[id]) return;
        delete records[id]; this.write(records);
    }
}
const { getDataDir } = require('../config/runtime-paths');
export const scanStore = new ScanStore(getDataDir());
