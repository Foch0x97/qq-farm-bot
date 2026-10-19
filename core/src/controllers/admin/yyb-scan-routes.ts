import crypto from 'node:crypto';
import type { Application } from 'express';
import type { AdminContext } from './context';
import { WxLoginService } from '../../services/wx-login/service';
import type { WxLoginSession, ScanStatus } from '../../services/wx-login/service';
import { normalizeScanConfig, scanStore, ScanStore } from '../../services/yyb-scan-store';
const store = require('../../models/store');
const { handleApiError } = require('./middleware');

interface Task {
    id: string; createdAt: number; status: ScanStatus | 'complete'; session: WxLoginSession;
    qr: Buffer; pending?: Promise<void>; result?: { accountId: string };
}
export function mountYybScanRoutes(app: Application, ctx: AdminContext, service = new WxLoginService({ preserveAuthorization: true }), vault: ScanStore = scanStore): void {
    const tasks = new Map<string, Task>();
    const ttl = 180000;
    const alive = (task: Task) => tasks.get(task.id) === task && Date.now() - task.createdAt < ttl;
    function destroy(task: Task): void { tasks.delete(task.id); service.destroy(task.session); task.qr = Buffer.alloc(0); }
    function requireTask(id: string): Task {
        const task = tasks.get(id);
        if (!task || !alive(task)) { if (task) destroy(task); throw new Error('二维码已失效，请重新获取'); }
        return task;
    }
    async function serial(task: Task, operation: () => Promise<void>): Promise<void> {
        while (task.pending) await task.pending;
        if (!alive(task)) throw new Error('扫码已取消或失效');
        const pending = operation(); task.pending = pending;
        try { await pending; } finally { if (task.pending === pending) task.pending = undefined; }
    }
    const cleanup = setInterval(() => { for (const task of tasks.values()) if (!alive(task)) destroy(task); }, 30000);
    cleanup.unref();
    ctx.server?.once('close', () => { clearInterval(cleanup); for (const task of tasks.values()) destroy(task); });
    app.post('/api/yyb-scan/tasks', async (_req, res) => {
        try {
            for (const task of tasks.values()) if (!alive(task)) destroy(task);
            if (tasks.size >= 100) throw new Error('扫码任务过多，请稍后重试');
            const { session, qr } = await service.createQrSession();
            const task: Task = { id: crypto.randomBytes(32).toString('hex'), createdAt: Date.now(), status: 'waiting', session, qr };
            tasks.set(task.id, task);
            res.json({ ok: true, data: { taskId: task.id, qrUrl: `/api/yyb-scan/tasks/${task.id}/qr` } });
        } catch (e) { handleApiError(res, e); }
    });
    app.get('/api/yyb-scan/tasks/:id/qr', (req, res) => {
        try { res.type('jpeg').send(requireTask(String(req.params.id)).qr); } catch (e) { handleApiError(res, e); }
    });
    app.delete('/api/yyb-scan/tasks/:id', (req, res) => {
        const task = tasks.get(String(req.params.id)); if (task) destroy(task);
        res.json({ ok: true });
    });
    app.get('/api/yyb-scan/tasks/:id/status', async (req, res) => {
        try {
            const task = requireTask(String(req.params.id));
            await serial(task, async () => {
                if (task.status === 'waiting' || task.status === 'scanned') {
                    const status = await service.poll(task.session);
                    if (alive(task)) task.status = status;
                }
            });
            res.json({ ok: true, data: { status: task.status } });
        } catch (e) { handleApiError(res, e); }
    });
    app.post('/api/yyb-scan/tasks/:id/complete', async (req, res) => {
        try {
            const config = normalizeScanConfig(req.body);
            const task = requireTask(String(req.params.id));
            await serial(task, async () => {
                if (task.result) return;
                if (task.status !== 'authorized') throw new Error('请先扫码并在手机上确认');
                await service.confirm(task.session);
                if (!alive(task)) throw new Error('扫码已取消或失效');
                const code = await service.issueCode(task.session, 'wx5306c5978fdb76e4');
                if (!alive(task)) throw new Error('扫码已取消或失效');
                const credentials = task.session.credentials;
                if (!credentials?.refreshToken) throw new Error('未获取到可保存的微信授权，请重新扫码');
                const accounts = store.getAccounts().accounts;
                const requestedId = String(req.body?.accountId || '');
                const existingId = requestedId || Object.entries(vault.list()).find(([, record]) => record.credentials.openid === credentials.openid)?.[0];
                const existing = accounts.find((a: any) => a.id === existingId);
                if (requestedId && !existing) throw new Error('账号已删除，请重新添加');
                const name = existing?.name || task.session.nickname || `微信账号${credentials.openid.slice(-4)}`;
                const data = store.addOrUpdateAccount({ ...(existing ? { id: existing.id } : {}), name, code, platform: 'wx' });
                const accountId = String(existing?.id || data.accounts.at(-1)?.id);
                vault.set(accountId, config, code, credentials);
                if (existing) ctx.provider.restartAccount(accountId); else ctx.provider.startAccount(accountId);
                task.result = { accountId }; task.status = 'complete';
                service.destroy(task.session); task.qr = Buffer.alloc(0);
            });
            res.json({ ok: true, data: task.result });
        } catch (e) { handleApiError(res, e); }
    });
    app.get('/api/yyb-scan/config', (req, res) => {
        try {
            const state = ctx.provider.getYybScan(String(req.query.accountId || ''));
            res.json({ ok: true, data: state?.available ? state : { ...vault.defaults(), available: false, phase: 'stopped', attempts: 0 } });
        } catch (e) { handleApiError(res, e); }
    });
    app.post('/api/yyb-scan/config', (req, res) => {
        try {
            const config = normalizeScanConfig(req.body);
            const id = String(req.body?.accountId || '');
            if (id && ctx.provider.getYybScan(id)?.available) ctx.provider.configureYybScan(id, config);
            else vault.saveDefaults(config);
            res.json({ ok: true });
        } catch (e) { handleApiError(res, e); }
    });
    app.post('/api/yyb-scan/retry', (req, res) => {
        try { ctx.provider.retryYybScan(String(req.body?.accountId || '')); res.json({ ok: true }); }
        catch (e) { handleApiError(res, e); }
    });
}
