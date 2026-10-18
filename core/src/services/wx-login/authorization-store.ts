import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { WxCredentials } from './credentials';

export interface WxAuthorization {
    sessionId: string;
    credentials?: WxCredentials;
    thirdparty?: { apiBase: string; apiToken: string; openid: string };
    enabled: boolean;
    reconnectDelayMin: number;
    reconnectMaxAttempts: number;
    needsScan: boolean;
    updatedAt: number;
}

/** Separate encrypted storage: never add refresh credentials to accounts.json/API payloads. */
export class WxAuthorizationStore {
    private pending = new Map<string, { credentials?: WxCredentials; thirdparty?: WxAuthorization['thirdparty']; until: number }>();
    constructor(private directory: string) {}
    private hash(code: string): string { return crypto.createHash('sha256').update(code).digest('hex'); }
    private key(create: boolean): Buffer {
        const file = path.join(this.directory, 'wx-authorization.key');
        if (create && !fs.existsSync(file)) {
            fs.mkdirSync(this.directory, { recursive: true });
            fs.writeFileSync(file, crypto.randomBytes(32), { mode: 0o600, flag: 'wx' });
        }
        const key = fs.readFileSync(file);
        if (key.length !== 32) throw new Error('微信授权密钥无效，请恢复完整数据备份');
        return key;
    }
    private read(): Record<string, WxAuthorization> {
        const file = path.join(this.directory, 'wx-authorization.enc');
        if (!fs.existsSync(file)) return {};
        try {
            const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
            const decipher = crypto.createDecipheriv('aes-256-gcm', this.key(false), Buffer.from(envelope.iv, 'base64'));
            decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
            return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8'));
        } catch { throw new Error('微信授权数据无法读取，请恢复完整数据备份或重新扫码'); }
    }
    private write(data: Record<string, WxAuthorization>): void {
        const key = this.key(true);
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
        const file = path.join(this.directory, 'wx-authorization.enc');
        const temp = `${file}.${crypto.randomUUID()}.tmp`;
        try {
            fs.writeFileSync(temp, JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') }), { mode: 0o600, flag: 'wx' });
            fs.renameSync(temp, file);
        } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    }
    get(id: string): WxAuthorization | undefined { return this.read()[id]; }
    list(): Record<string, WxAuthorization> { return this.read(); }
    stage(code: string, credentials: WxCredentials): void {
        for (const [key, item] of this.pending) if (item.until <= Date.now()) this.pending.delete(key);
        if (this.pending.size >= 100) this.pending.delete(this.pending.keys().next().value!);
        if (credentials.refreshToken) this.pending.set(this.hash(code), { credentials: { ...credentials }, until: Date.now() + 10 * 60_000 });
    }
    bindCode(id: string, code: string, platform: string): void {
        const key = this.hash(code);
        const item = this.pending.get(key);
        this.pending.delete(key);
        const data = this.read();
        if (platform === 'wx' && item && item.until > Date.now()) {
            const previous = data[id];
            data[id] = {
                sessionId: crypto.randomUUID(), credentials: item.credentials, thirdparty: item.thirdparty,
                enabled: previous?.enabled ?? true,
                reconnectDelayMin: previous?.reconnectDelayMin || (item.thirdparty ? 5 : 3),
                reconnectMaxAttempts: previous?.reconnectMaxAttempts || 3,
                needsScan: false, updatedAt: Date.now(),
            };
        } else {
            if (!data[id]) return;
            delete data[id];
        }
        this.write(data);
    }
    stageThirdparty(code: string, thirdparty: NonNullable<WxAuthorization['thirdparty']>): void {
        for (const [key, item] of this.pending) if (item.until <= Date.now()) this.pending.delete(key);
        if (this.pending.size >= 100) this.pending.delete(this.pending.keys().next().value!);
        this.pending.set(this.hash(code), { thirdparty: { ...thirdparty }, until: Date.now() + 10 * 60_000 });
    }
    update(id: string, sessionId: string, changes: Partial<Pick<WxAuthorization, 'credentials' | 'enabled' | 'needsScan' | 'reconnectDelayMin' | 'reconnectMaxAttempts'>>): boolean {
        const data = this.read();
        if (!data[id] || data[id].sessionId !== sessionId) return false;
        data[id] = { ...data[id], ...changes, updatedAt: Date.now() };
        this.write(data);
        return true;
    }
    remove(id: string): void {
        const data = this.read();
        if (!data[id]) return;
        delete data[id];
        this.write(data);
    }
}

const { getDataDir } = require('../../config/runtime-paths');
export const wxAuthorizationStore = new WxAuthorizationStore(getDataDir());
