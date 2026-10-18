import crypto from 'node:crypto';

export interface WxCredentials {
    openid: string;
    accessToken: string;
    refreshToken: string;
}

export class WxAuthorizationExpired extends Error {
    constructor() { super('微信授权已失效，请重新扫码'); }
}

const BASE = 'https://yybadaccess.3g.qq.com/pc_yyb_auth/';
const ACCESS_KEY = 'wgrdg373hy26ww2';

// This uses the same YYB endpoints already used by the upstream QR login flow.
// Never include response bodies/tokens in errors: errors can reach panel logs.
async function signedRequest(endpoint: string, value: unknown, cookies?: WxCredentials): Promise<any> {
    const body = JSON.stringify(value);
    const timestamp = String(Date.now());
    const nonce = String(crypto.randomInt(1000, 10000));
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Ual-Access-Businessid': 'pc_yyb_auth',
        'Ual-Access-Timestamp': timestamp,
        'Ual-Access-Nonce': nonce,
        'Ual-Access-Signature': crypto.createHash('md5').update(`${body}${timestamp}${ACCESS_KEY}${nonce}`).digest('hex'),
    };
    if (cookies) headers.Cookie = `openid=${cookies.openid}; accesstoken=${cookies.accessToken}; refreshtoken=${cookies.refreshToken}`;
    let response: Response;
    try {
        response = await fetch(BASE + endpoint, { method: 'POST', body, headers, redirect: 'error', signal: AbortSignal.timeout(35000) });
    } catch { throw new Error('微信授权服务暂时无法连接'); }
    if (response.status === 401 || response.status === 403) throw new WxAuthorizationExpired();
    if (!response.ok) throw new Error(`微信授权服务暂时不可用 (HTTP ${response.status})`);
    let data: any;
    try { data = await response.json(); } catch { throw new Error('微信授权服务响应格式异常'); }
    if (data.code === undefined || !Number.isFinite(Number(data.code))) throw new Error('微信授权服务响应缺少状态码');
    // Business rejection of the saved authorization requires a new scan.
    if (Number(data.code) !== 0) throw new WxAuthorizationExpired();
    return data;
}

export async function refreshWxCredentials(credentials: WxCredentials): Promise<WxCredentials> {
    if (!credentials.openid || !credentials.accessToken || !credentials.refreshToken) throw new WxAuthorizationExpired();
    const data = await signedRequest('pcyyb_refresh_token_auth', {
        userInfo: { openId: credentials.openid, refreshToken: credentials.refreshToken, accessToken: credentials.accessToken, loginType: 'WX' },
    });
    const info = data.user_info;
    if (typeof info?.access_token !== 'string' || !info.access_token) throw new Error('微信授权刷新未返回有效凭据');
    return { ...credentials, accessToken: info.access_token, refreshToken: info.refresh_token || credentials.refreshToken };
}

export async function fetchWxLoginBuffer(credentials: WxCredentials): Promise<string> {
    const data = await signedRequest('pcyyb_get_wx_login_buffer_auth', {
        extInfo: {
            listS: { unionid: { value: [credentials.openid] }, user_id: { value: [credentials.openid] }, access_token: { value: [credentials.accessToken] } },
            listI: { user_type: { value: [0] } },
        },
    }, credentials);
    const buffer = data?.ext_info?.list_s?.login_buffer?.value?.[0];
    if (typeof buffer !== 'string' || !buffer) throw new Error('微信授权刷新未返回登录状态');
    return buffer;
}
