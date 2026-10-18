import { WxAuthorizationExpired } from './credentials';

export interface ThirdpartyWx { apiBase: string; apiToken: string; openid: string; }
export function normalizeThirdparty(input: any): ThirdpartyWx {
    const raw = String(input?.apiBase || '').trim().replace(/\/+$/, '').replace(/\/api\/open(?:\/v1(?:\/farm\/code)?)?$/, '');
    let url: URL;
    try { url = new URL(raw); } catch { throw new Error('应用宝接口地址无效'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('应用宝接口地址必须为不带凭据的 HTTP/HTTPS 地址');
    const apiToken = String(input?.apiToken || '').trim();
    const openid = String(input?.openid || '').trim();
    if (!apiToken || !openid || apiToken.length > 4096 || openid.length > 512) throw new Error('请填写有效的 APITOKEN 和 OPENID');
    return { apiBase: url.toString().replace(/\/+$/, ''), apiToken, openid };
}
export function extractThirdpartyCode(data: any): string {
    for (const value of [data?.data?.code, data?.data?.result?.code, data?.data?.token, data?.code, data?.token]) {
        if (typeof value === 'string' && value.length >= 4) return value;
    }
    return '';
}
export async function getThirdpartyCode(config: ThirdpartyWx, forceRefresh = false): Promise<string> {
    const normalized = normalizeThirdparty(config);
    let response: Response;
    try {
        response = await fetch(`${normalized.apiBase}/api/open/v1/farm/code`, {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${normalized.apiToken}` },
            body: JSON.stringify({ openid: normalized.openid, forceRefresh }),
        });
    } catch { throw new Error('第三方应用宝暂时无法连接'); }
    if (response.status === 401 || response.status === 403) throw new WxAuthorizationExpired();
    if (!response.ok) throw new Error(`第三方应用宝暂时不可用 (HTTP ${response.status})`);
    let data: any;
    try { data = await response.json(); } catch { throw new Error('第三方应用宝响应格式异常'); }
    const code = extractThirdpartyCode(data);
    if (!code) throw new Error('第三方应用宝未返回有效 Code');
    return code;
}
