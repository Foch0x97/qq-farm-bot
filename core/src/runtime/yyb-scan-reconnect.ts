import { WxAuthorizationExpired, refreshWxCredentials, fetchWxLoginBuffer } from '../services/wx-login/credentials';
import { getNativeWxLoginCode } from '../services/wx-login/native-protocol';
import { scanStore, ScanStore } from '../services/yyb-scan-store';

type Phase = 'waiting' | 'refreshing' | 'connecting' | 'online' | 'stopped' | 'failed' | 'restricted';
interface Recovery { phase: Phase; attempts: number; offlineSince: number; transient: boolean; manual: boolean; hadFailure: boolean; }
export interface ReconnectConfig { enabled?: boolean; reconnectDelayMin?: number; reconnectMaxAttempts?: number; }
interface Options {
    getAccount: (id: string) => any;
    hasWorker: (id: string) => boolean;
    isOnline?: (id: string) => boolean;
    startWorker: (account: any) => boolean;
    saveCode: (id: string, code: string) => void;
    log: (id: string, message: string) => void;
    notify: (id: string, reason: string) => void;
    recovered?: (id: string) => void;
    vault?: ScanStore;
    refresh?: typeof refreshWxCredentials;
    loginBuffer?: typeof fetchWxLoginBuffer;
    issueCode?: typeof getNativeWxLoginCode;
    now?: () => number;
    setTimer?: typeof setTimeout;
    clearTimer?: typeof clearTimeout;
}

/** Go parity: 30s scan, default 3min/3 attempts, preserve successful counts.
 * After the initial delay, failures are retried on the next 30s scan (the Go
 * implementation retains offlineSince until a connection succeeds).
 */
export class YybScanReconnect {
    private states = new Map<string, Recovery>();
    private stopped = new Set<string>();
    private busy = new Set<string>();
    private closed = false;
    private timer?: ReturnType<typeof setTimeout>;
    private nextScanAt = 0;
    private vault: ScanStore;
    private now: () => number;
    private setTimer: typeof setTimeout;
    private clearTimer: typeof clearTimeout;
    constructor(private options: Options) {
        this.vault = options.vault || scanStore;
        this.now = options.now || Date.now;
        this.setTimer = options.setTimer || setTimeout;
        this.clearTimer = options.clearTimer || clearTimeout;
        this.scheduleScan();
    }
    private scheduleScan(): void {
        if (this.closed) return;
        this.nextScanAt = this.now() + 30000;
        this.timer = this.setTimer(() => {
            try { this.scan(); } catch { /* A damaged authorization store must not crash the runtime. */ }
            this.scheduleScan();
        }, 30000);
        this.timer.unref?.();
    }
    owns(id: string): boolean { try { return this.vault.matches(id, this.options.getAccount(id)); } catch { return false; } }
    config(id: string): Required<ReconnectConfig> {
        const auth = this.vault.get(id);
        return { enabled: auth?.enabled ?? true, reconnectDelayMin: auth?.reconnectDelayMin || 3, reconnectMaxAttempts: auth?.reconnectMaxAttempts || 3 };
    }
    status(id: string) {
        try {
            const auth = this.vault.get(id); const config = this.config(id); const state = this.states.get(id);
            return {
                ...config, available: this.owns(id), enabled: !!auth?.enabled,
                phase: state?.phase || (this.options.isOnline?.(id) ? 'online' : 'stopped'),
                provider: 'yyb-scan', needsScan: !!auth?.needsScan,
                openid: auth?.credentials?.openid || '', updatedAt: auth?.updatedAt || 0,
                attempts: state?.attempts || 0, transient: state?.transient || false, offlineSince: state?.offlineSince || 0,
                nextAt: state?.phase === 'waiting' ? (state.manual || state.hadFailure ? this.nextScanAt : (state.offlineSince || this.nextScanAt) + config.reconnectDelayMin * 60000) : 0,
                pending: !!state && ['waiting', 'refreshing', 'connecting'].includes(state.phase),
            };
        } catch { return { available: false, enabled: false, phase: 'storage_error', attempts: 0, nextAt: 0, pending: false }; }
    }
    cancel(id: string): void { this.states.delete(id); this.stopped.add(id); }
    resume(id: string): void { this.cancel(id); this.stopped.delete(id); }
    close(): void { this.closed = true; if (this.timer) this.clearTimer(this.timer); this.states.clear(); }
    configure(id: string, changes: ReconnectConfig): void {
        const auth = this.vault.get(id);
        if (!auth || !this.owns(id)) throw new Error('请先在应用宝登录中扫码授权');
        const config = this.config(id);
        if (changes.enabled !== undefined) {
            if (typeof changes.enabled !== 'boolean') throw new Error('重连开关无效');
            config.enabled = changes.enabled;
        }
        for (const key of ['reconnectDelayMin', 'reconnectMaxAttempts'] as const) {
            const value = changes[key];
            if (value === undefined) continue;
            if (!Number.isSafeInteger(value) || value > (key === 'reconnectDelayMin' ? 10080 : 10000)) throw new Error('重连配置必须为有效整数');
            config[key] = value > 0 ? value : 3;
        }
        this.vault.update(id, auth.session, config);
        const hadState = this.states.has(id);
        this.resume(id); // Go resets count/stopped state when configuration is saved.
        if (config.enabled && hadState && !this.options.isOnline?.(id)) this.disconnected(id);
    }
    setEnabled(id: string, enabled: boolean): void { this.configure(id, { enabled }); }
    idle(id: string): void {
        const state = this.states.get(id);
        if (state?.phase === 'waiting' && state.manual) void this.run(id, state);
    }
    async refreshAuthorization(id: string): Promise<void> {
        const auth = this.vault.get(id);
        if (!auth) throw new Error('该账号未保存微信授权');
        if (this.busy.has(id)) throw new Error('该账号正在刷新或重连，请稍后重试');
        this.busy.add(id);
        try {
            {
                if (!auth.credentials) throw new WxAuthorizationExpired();
                const credentials = await (this.options.refresh || refreshWxCredentials)(auth.credentials);
                if (!this.vault.update(id, auth.session, { credentials, needsScan: false })) return;
                await (this.options.loginBuffer || fetchWxLoginBuffer)(credentials);
            }
            this.vault.update(id, auth.session, { needsScan: false });
            this.options.log(id, '微信授权刷新成功');
        } catch (error) {
            if (error instanceof WxAuthorizationExpired) this.vault.update(id, auth.session, { needsScan: true });
            throw error;
        } finally { this.busy.delete(id); }
    }
    retryNow(id: string): void {
        const auth = this.vault.get(id);
        if (!this.owns(id)) throw new Error('请先通过应用宝登录扫码授权');
        if (!auth?.enabled) throw new Error('请先开启自动重连');
        if (this.options.isOnline?.(id)) return;
        this.resume(id);
        const state: Recovery = { phase: 'waiting', attempts: 0, offlineSince: this.now(), transient: false, manual: true, hadFailure: false };
        this.states.set(id, state); void this.run(id, state);
    }
    online(id: string): void {
        const state = this.states.get(id);
        if (!state || this.stopped.has(id)) return;
        if (state.phase !== 'online') {
            state.phase = 'online'; state.offlineSince = 0; state.transient = false; state.hadFailure = false; state.manual = false;
            this.options.log(id, '微信自动重连成功，已恢复挂机'); this.options.recovered?.(id);
        }
        // Go intentionally preserves attempts across successful reconnections.
    }
    disconnected(id: string, reason: { source?: string; code?: number; kicked?: boolean } = {}): boolean {
        if (this.closed || this.stopped.has(id)) return false;
        let auth; try { auth = this.vault.get(id); } catch { return false; }
        const account = this.options.getAccount(id);
        if (account?.platform !== 'wx' || !auth || !this.owns(id)) return false;
        if (reason.code === 1000016) {
            this.vault.update(id, auth.session, { enabled: false });
            this.states.set(id, { phase: 'restricted', attempts: 0, offlineSince: 0, transient: false, manual: false, hadFailure: false });
            this.stopped.add(id); this.options.log(id, '账号登录受限（1000016），已永久关闭自动重连'); return false;
        }
        // Go immediately recovers a kick when scheduled reconnect is disabled.
        if (!auth.enabled && !reason.kicked) {
            const state = this.states.get(id);
            if (state) { state.phase = 'stopped'; state.manual = false; state.offlineSince = 0; }
            return false;
        }
        const existing = this.states.get(id);
        if (existing && ['waiting', 'refreshing', 'failed'].includes(existing.phase)) return existing.phase !== 'failed';
        const isFailedAttempt = existing?.phase === 'connecting';
        const transient = reason.source === 'request_timeout' || (!!isFailedAttempt && !!existing?.transient);
        const state: Recovery = existing || { phase: 'waiting', attempts: 0, offlineSince: 0, transient, manual: false, hadFailure: false };
        state.phase = 'waiting'; state.transient = transient;
        if (!isFailedAttempt) state.offlineSince = reason.kicked ? this.now() : 0;
        state.hadFailure = !!isFailedAttempt; state.manual = !auth.enabled && !!reason.kicked;
        if (transient) state.attempts = 0;
        this.states.set(id, state);
        if (state.manual) void this.run(id, state);
        return true;
    }
    private scan(): void {
        for (const [id, state] of this.states) {
            if (state.phase !== 'waiting' || this.stopped.has(id) || this.busy.has(id)) continue;
            if (!this.options.getAccount(id)) { this.cancel(id); continue; }
            if (!state.offlineSince) { state.offlineSince = this.now(); continue; }
            const config = this.config(id);
            if (!state.manual && !config.enabled) continue;
            if (!state.manual && this.now() - state.offlineSince < config.reconnectDelayMin * 60000) continue;
            if (!state.transient && !state.manual && state.attempts >= config.reconnectMaxAttempts) {
                state.phase = 'failed'; state.attempts = 0;
                this.options.log(id, `微信自动重连已达上限（${config.reconnectMaxAttempts} 次），请手动重试`);
                this.options.notify(id, 'wx_reconnect_exhausted'); continue;
            }
            void this.run(id, state);
        }
    }
    private async run(id: string, state: Recovery): Promise<void> {
        if (this.closed || this.states.get(id) !== state || this.stopped.has(id) || this.busy.has(id) || this.options.hasWorker(id) || !this.owns(id)) return;
        this.busy.add(id); let sessionId = ''; let codeBefore = '';
        const current = () => {
            const auth = this.vault.get(id); const account = this.options.getAccount(id);
            return !this.closed && this.states.get(id) === state && !this.stopped.has(id)
                && account?.platform === 'wx' && account.code === codeBefore && auth?.session === sessionId && (auth.enabled || state.manual);
        };
        try {
            const auth = this.vault.get(id); const account = this.options.getAccount(id);
            if (!auth || !account) { this.cancel(id); return; }
            sessionId = auth.session; codeBefore = account.code;
            if (!current()) { this.cancel(id); return; }
            if (!state.transient && !state.manual) state.attempts++;
            state.phase = 'refreshing';
            this.options.log(id, state.transient ? '游戏请求超时，正在刷新授权重连（不计次数上限）' : '正在刷新微信授权并重连');
            let code = '';
            try {
                {
                    if (!auth.credentials) throw new WxAuthorizationExpired();
                    const credentials = await (this.options.refresh || refreshWxCredentials)(auth.credentials);
                    if (!this.vault.update(id, sessionId, { credentials, needsScan: false })) return;
                    if (!current()) return;
                    const buffer = await (this.options.loginBuffer || fetchWxLoginBuffer)(credentials);
                    if (!current()) return;
                    code = await (this.options.issueCode || getNativeWxLoginCode)(buffer, 'wx5306c5978fdb76e4');
                }
            } catch (error) {
                if (!current()) return;
                if (error instanceof WxAuthorizationExpired) {
                    const wasExpired = !!this.vault.get(id)?.needsScan;
                    this.vault.update(id, sessionId, { needsScan: true });
                    if (!wasExpired) this.options.notify(id, 'wx_authorization_expired');
                }
                this.options.log(id, '换 Code 暂未成功，按 Go 策略尝试已保存的 Code');
            }
            if (!current() || this.options.hasWorker(id)) return;
            if (code) { this.vault.update(id, sessionId, {}, code); this.options.saveCode(id, code); codeBefore = code; }
            state.phase = 'connecting';
            if (!this.options.startWorker(this.options.getAccount(id))) throw new Error('账号启动失败');
        } catch {
            let valid = false; try { valid = current(); } catch {}
            if (valid) {
                const scheduledEnabled = !!this.vault.get(id)?.enabled;
                state.phase = scheduledEnabled ? 'waiting' : 'stopped';
                state.manual = false;
                state.hadFailure = true;
                this.options.log(id, scheduledEnabled ? '重连未成功，将在下一轮扫描继续尝试' : '本次恢复未成功，定时重连已关闭，等待手动操作');
            }
        } finally {
            this.busy.delete(id);
            if (this.states.get(id) === state && state.phase === 'refreshing') this.cancel(id);
        }
    }
}
