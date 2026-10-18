import type { Application, Request } from 'express';
import type { AdminContext } from './context';
import { wxAuthorizationStore } from '../../services/wx-login/authorization-store';
import { getThirdpartyCode, normalizeThirdparty } from '../../services/wx-login/thirdparty';
const { getAccountList, resolveAccId, handleApiError } = require('./middleware');

export function validateWxReconnectConfig(body: any): void {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('重连配置无效');
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new Error('重连开关无效');
    for (const key of ['reconnectDelayMin', 'reconnectMaxAttempts']) {
        if (body[key] !== undefined && (!Number.isSafeInteger(body[key]) || body[key] > (key === 'reconnectDelayMin' ? 10080 : 10000))) throw new Error('重连配置必须为有效整数');
    }
}
export function mountWxAccountRoutes(app: Application, ctx: AdminContext): void {
    function idFor(req: Request): string {
        const id = resolveAccId(ctx, req.params.id);
        const account = getAccountList(ctx).find((a: any) => String(a.id) === id);
        if (!account || account.platform !== 'wx') throw new Error('微信账号不存在');
        return id;
    }
    app.get('/api/accounts/:id/wx-reconnect', (req, res) => {
        try { res.json({ ok: true, data: ctx.provider.getWxReconnect(idFor(req)) }); } catch (e) { handleApiError(res, e); }
    });
    app.post('/api/accounts/:id/wx-reconnect', (req, res) => {
        try {
            validateWxReconnectConfig(req.body);
            const id = idFor(req); ctx.provider.setWxReconnect(id, req.body);
            res.json({ ok: true, data: ctx.provider.getWxReconnect(id) });
        } catch (e) { handleApiError(res, e); }
    });
    app.post('/api/accounts/:id/wx-reconnect/retry', (req, res) => {
        try { const id = idFor(req); ctx.provider.retryWxReconnect(id); res.json({ ok: true, data: ctx.provider.getWxReconnect(id) }); } catch (e) { handleApiError(res, e); }
    });
    app.post('/api/accounts/:id/wx-authorization/refresh', async (req, res) => {
        try { const id = idFor(req); await ctx.provider.refreshWxAuthorization(id); res.json({ ok: true, data: ctx.provider.getWxReconnect(id) }); } catch (e) { handleApiError(res, e); }
    });
    app.get('/api/wx-login/authorizations', (_req, res) => {
        try {
            const accounts = getAccountList(ctx).filter((a: any) => a.platform === 'wx');
            res.json({ ok: true, data: accounts.map((a: any) => ({ accountId: a.id, name: a.name, ...ctx.provider.getWxReconnect(String(a.id)) })) });
        } catch (e) { handleApiError(res, e); }
    });
    app.post('/api/wx-login/authorizations/refresh', async (_req, res) => {
        const results = [];
        for (const account of getAccountList(ctx).filter((a: any) => a.platform === 'wx')) {
            const id = String(account.id);
            if (!ctx.provider.getWxReconnect(id)?.available) continue;
            try { await ctx.provider.refreshWxAuthorization(id); results.push({ accountId: id, ok: true }); }
            catch { results.push({ accountId: id, ok: false }); }
        }
        res.json({ ok: true, data: results });
    });
    app.post('/api/wx-login/thirdparty/code', async (req, res) => {
        try {
            const config = normalizeThirdparty(req.body);
            const code = await getThirdpartyCode(config, req.body?.forceRefresh === true);
            wxAuthorizationStore.stageThirdparty(code, config);
            res.json({ ok: true, data: { code, openid: config.openid } });
        } catch (e) { handleApiError(res, e); }
    });
}
