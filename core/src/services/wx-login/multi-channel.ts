// PCMgr OAuth behavior: YYB-Go-Enhanced c4c2355, internal/qr and internal/pcmgr.
// YYB and PCMgr share the farm's native WeChat code exchange after onboarding.
import crypto from 'node:crypto';
import { WxLoginService, request } from './service';
import type { WxLoginSession } from './service';
import { fetchWxLoginBuffer, normalizeLoginChannel } from './credentials';
import { exchangePCMgrCode, PCMgrRejected, PCMGR_HOST_APP_ID } from './pcmgr';

export class MultiChannelLoginService extends WxLoginService {
    async createQrSession(value?: unknown): Promise<{ session: WxLoginSession; qr: Buffer }> {
        const channel = normalizeLoginChannel(value);
        if (channel === 'yyb') return super.createQrSession();
        const params = new URLSearchParams({ appid: PCMGR_HOST_APP_ID,
            redirect_uri: 'https://security.guanjia.qq.com/login', response_type: 'code', scope: 'snsapi_login,snsapi_runtime_pcsdk', state: '233', self_redirect: 'true' });
        const cookies = new Map<string, string>();
        const page = await request(`https://open.weixin.qq.com/connect/qrconnect?${params}`, cookies);
        const uuid = /\/connect\/qrcode\/([^"'>\s]+)/.exec(page.body.toString('utf8'))?.[1];
        if (page.status !== 200 || !uuid) throw new Error('PCMgr 二维码生成失败');
        const image = await request(`https://open.weixin.qq.com/connect/qrcode/${encodeURIComponent(uuid)}`, cookies);
        if (image.status !== 200 || image.body.length < 100 || image.body[0] !== 255 || image.body[1] !== 216) throw new Error('PCMgr 二维码图片无效');
        return { session: { channel, clientGuid: crypto.randomBytes(16).toString('hex'), cookies, uuid }, qr: image.body };
    }
    async confirm(session: WxLoginSession): Promise<{ openid: string; loginBuffer: string }> {
        const channel = normalizeLoginChannel(session.channel);
        if (channel === 'yyb') return super.confirm(session);
        if (!session.oauthCode) throw new Error('请先扫码并在手机上确认');
        if (!session.credentials) {
            const pc = await exchangePCMgrCode(session.oauthCode, session.clientGuid!);
            session.credentials = { provider: 'pcmgr', openid: `pcmgr:${pc.accountId}`, accessToken: '', refreshToken: '', pcmgr: pc };
            session.nickname = pc.nickname;
        }
        // PCMgr newly issued keys may need a short propagation delay. Keep the
        // already issued credentials and retry only transient 20138/6, never OAuth.
        const deadline = Date.now() + 60000;
        for (;;) {
            try { session.loginBuffer = await fetchWxLoginBuffer(session.credentials); break; }
            catch (e) { if (channel !== 'pcmgr' || !(e instanceof PCMgrRejected) || e.command !== 20138 || e.code !== 6 || Date.now() >= deadline) throw e; await new Promise(resolve => setTimeout(resolve, 5000)); }
        }
        session.openid = session.credentials.openid; session.cookies.clear(); session.oauthCode = undefined;
        return { openid: session.openid, loginBuffer: session.loginBuffer! };
    }
}
