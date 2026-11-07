/** PC Manager wire protocol, locally adapted from YYB-Go-Enhanced c4c2355.
 * Source: https://github.com/525815266/YYB-Go-Enhanced/tree/c4c2355891804bd5e9d8be2caca2033f881624cb/internal/pcmgr
 * This channel has its own identity and keys; never treat its login key as a YYB token.
 */
import crypto from 'node:crypto';

export const PCMGR_HOST_APP_ID = 'wx5cd60c5d4817a188';
export interface PCMgrCredentials { accountId: string; loginKey: string; clientGuid: string; renewedAt: number; renewInterval: number; nickname?: string; }
export class PCMgrRejected extends Error {
    constructor(public command: number, public code: number) { super(`PCMgr ${command} 返回业务错误 ${code}`); }
}
type Fields = Map<number, Buffer | bigint>;
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const le32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const vint = (n: bigint) => { const bytes: number[] = []; do { let v = Number(n & 127n); n >>= 7n; if (n) v |= 128; bytes.push(v); } while (n); return Buffer.from(bytes); };
export const pcInt = (field: number, n: bigint | number) => Buffer.concat([vint(BigInt(field * 8)), vint(BigInt(n))]);
export const pcBytes = (field: number, b: Buffer) => Buffer.concat([vint(BigInt(field * 8 + 2)), vint(BigInt(b.length)), b]);
export function pcFields(raw: Buffer): Fields {
    const fields: Fields = new Map(); let pos = 0;
    const read = () => { let n = 0n; for (let shift = 0n; shift < 70n && pos < raw.length; shift += 7n) { const b = raw[pos++]; n |= BigInt(b & 127) << shift; if (!(b & 128)) return n; } throw new Error('PCMgr protobuf 格式无效'); };
    while (pos < raw.length) {
        const tag = read(); const field = Number(tag >> 3n); const wire = Number(tag & 7n);
        if (!field || fields.has(field)) throw new Error('PCMgr protobuf 字段无效');
        if (wire === 0) fields.set(field, read());
        else if (wire === 2) { const size = Number(read()); if (!Number.isSafeInteger(size) || size < 0 || pos + size > raw.length) throw new Error('PCMgr protobuf 长度无效'); fields.set(field, raw.subarray(pos, pos + size)); pos += size; }
        else throw new Error('PCMgr protobuf 类型无效');
    }
    return fields;
}
const num = (fields: Fields, n: number) => { const v = fields.get(n); return typeof v === 'bigint' ? v : 0n; };
const bytes = (fields: Fields, n: number) => { const v = fields.get(n); if (!Buffer.isBuffer(v)) throw new Error(`PCMgr 缺少字段 ${n}`); return v; };
export function validatePCMgr(c: PCMgrCredentials): void {
    if (!c || !/^[1-9]\d{0,18}$/.test(c.accountId) || BigInt(c.accountId) > 9223372036854775807n || !c.loginKey || Buffer.byteLength(c.loginKey) > 1024 || !/^[0-9a-f]{32}$/.test(c.clientGuid)) throw new Error('PCMgr 授权无效，请重新扫码');
}
function header(cmd: number, seq: number, size: number) {
    const b = Buffer.alloc(56); b.writeUInt16BE(11); b.writeUInt16BE(cmd, 2); b.writeUInt16BE(56, 4); b.writeUInt16BE(0x5200, 6); b.writeUInt32BE(size, 8); b.writeUInt32BE(seq, 12); b.writeUInt16BE(1, 40); return b;
}
const nonce = (iv: Buffer, seq: number, response: boolean) => { const n = Buffer.from(iv); const o = response ? 4 : 0; n.writeUInt32LE((n.readUInt32LE(o) + seq) >>> 0, o); return n; };
export function decryptPCMgr(raw: Buffer, key: Buffer, iv: Buffer, cmd: number, seq: number): Buffer {
    if (raw.length < 56 || raw.length > 2000000 || raw.readUInt16BE(0) !== 11 || raw.readUInt16BE(2) !== cmd || raw.readUInt16BE(4) !== 56 || raw.readUInt32BE(8) !== raw.length || raw.readUInt32BE(12) !== seq) throw new Error('PCMgr 响应信封不匹配');
    let plain: Buffer;
    try { const d = crypto.createDecipheriv('aes-128-gcm', key, nonce(iv, seq, true)); d.setAuthTag(raw.subarray(24, 40)); plain = Buffer.concat([d.update(raw.subarray(56)), d.final()]); }
    catch { throw new Error('PCMgr 响应认证失败'); }
    if (plain.length < 64 || plain.readUInt16BE(0) !== 11 || plain.readUInt16BE(2) !== cmd || plain.readUInt32BE(4) !== seq || (plain.readUInt32BE(8) !== plain.length && !(cmd === 395 && plain.readUInt32BE(8) === 64))) throw new Error('PCMgr 内层响应不匹配');
    return plain.subarray(64);
}
const blob = (tag: number, data: Buffer) => Buffer.concat([Buffer.from([tag, 14, 1]), u32(data.length), data]);
function parseKV(raw: Buffer) {
    if (raw.length < 4) throw new Error('PCMgr 握手数据不完整');
    const count = raw.readUInt32BE(0); if (count > 64) throw new Error('PCMgr 握手字段过多');
    const widths = [0, 1, 1, 2, 2, 4, 4, 8, 8, 4, 8, 16, 20, -1, -1, -1, -1, 4, -1, 0];
    const fields = new Map<string, Buffer>(); let pos = 4;
    for (let i = 0; i < count; i++) {
        if (pos + 2 > raw.length) throw new Error('PCMgr 握手键不完整');
        let size = raw.readUInt16BE(pos); pos += 2;
        if (!size || size > 128 || pos + size + 2 > raw.length) throw new Error('PCMgr 握手键无效');
        const name = raw.subarray(pos, pos + size).toString().replace(/\0$/, ''); pos += size;
        const kind = raw[pos]; pos += 2; size = widths[kind];
        if (size === undefined) throw new Error('PCMgr 握手类型无效');
        if (size <= 0) { if (pos + 4 > raw.length) throw new Error('PCMgr 握手长度缺失'); size = raw.readUInt32BE(pos); pos += 4; }
        if (pos + size > raw.length || fields.has(name)) throw new Error('PCMgr 握手值无效');
        fields.set(name, raw.subarray(pos, pos + size)); pos += size;
    }
    if (pos !== raw.length) throw new Error('PCMgr 握手包含多余数据');
    return fields;
}
async function exchange(packet: Buffer): Promise<Buffer> {
    let r: Response;
    try { r = await fetch('http://conna.gj.qq.com/', { method: 'POST', body: Uint8Array.from(packet).buffer, headers: { 'Content-Type': 'application/octet-stream' }, redirect: 'error', signal: AbortSignal.timeout(35000) }); }
    catch { throw new Error('PCMgr 网关暂时无法连接'); }
    if (!r.ok) throw new Error(`PCMgr 网关 HTTP ${r.status}`);
    const b = Buffer.from(await r.arrayBuffer()); if (b.length > 2000000) throw new Error('PCMgr 响应过大'); return b;
}
export async function callPCMgr(cmd: number, guid: Buffer, request: Buffer): Promise<Buffer> {
    if (![20042, 20138].includes(cmd) || guid.length !== 16 || request.length > 1000000) throw new Error('PCMgr 请求无效');
    const seed = crypto.randomBytes(48); let key: Buffer = seed.subarray(0, 16); let iv: Buffer = seed.subarray(16, 28); let seq = seed.readUInt32LE(28) & 0x7ffffffe;
    const auth = Buffer.concat([u32(5), blob(1, key), blob(2, iv), Buffer.from([3, 6, 1]), le32(seq), Buffer.from([4, 8, 1]), Buffer.alloc(8), blob(5, guid)]);
    const pub = 'MIGJAoGBAL6yyUhfCwUl37nvZ1Y3wqLxdIeuM1HegcWfoyWW9TJ3PF/Y8VSgdyuJjsN14F608TG5SlGagfT+i3j7JMqKI/Bq6F+nMISkgvMtrQ5NDsbGwerhop1R3MRxIjkNW4ZBtkElF3QbR41K1vpXRtl1goTbL1YTEm75EHNlFoDBIverAgMBAAE=';
    const encrypted = crypto.publicEncrypt({ key: crypto.createPublicKey({ key: Buffer.from(pub, 'base64'), format: 'der', type: 'pkcs1' }), padding: crypto.constants.RSA_PKCS1_PADDING }, auth);
    const raw = await exchange(Buffer.concat([header(395, seq, 56 + encrypted.length), encrypted]));
    const kv = parseKV(decryptPCMgr(raw, key, iv, 395, seq));
    const ret = kv.get('ret'); if (ret?.length !== 4 || ret.readUInt32LE(0) !== 0) throw new Error('PCMgr 握手被拒绝');
    key = kv.get('session_key')!; iv = kv.get('session_aes_iv')!; const sid = kv.get('session_id');
    if (key?.length !== 16 || iv?.length !== 12 || sid?.length !== 8) throw new Error('PCMgr 握手缺少会话');
    seq++;
    const rpcHead = Buffer.concat([pcBytes(1, guid), pcBytes(2, Buffer.alloc(0)), pcBytes(3, Buffer.from('thisisjustatestaccount'))]);
    const body = Buffer.concat([pcInt(1, seq), pcInt(2, cmd), pcBytes(3, rpcHead), pcBytes(4, request)]);
    const inner = Buffer.alloc(64); inner.writeUInt16BE(11); inner.writeUInt16BE(cmd, 2); inner.writeUInt32BE(seq, 4); inner.writeUInt32BE(64 + body.length, 8); inner.writeUInt32BE(2010, 12); inner.writeUInt32BE(seq, 36); inner.writeUInt32BE(30865, 40); inner.writeUInt16BE(1, 60);
    const enc = crypto.createCipheriv('aes-128-gcm', key, nonce(iv, seq, false)); const sealed = Buffer.concat([enc.update(Buffer.concat([inner, body])), enc.final()]);
    const outer = header(cmd, seq, 56 + sealed.length); sid.copy(outer, 16); enc.getAuthTag().copy(outer, 24);
    const envelope = pcFields(decryptPCMgr(await exchange(Buffer.concat([outer, sealed])), key, iv, cmd, seq));
    if (num(envelope, 2) !== BigInt(cmd)) throw new Error('PCMgr 响应命令不匹配');
    const response = pcFields(bytes(envelope, 3)); if (num(response, 1) !== BigInt(seq)) throw new Error('PCMgr 响应序号不匹配');
    for (const n of [2, 3]) { const code = num(response, n); if (code) throw new PCMgrRejected(cmd, Number(BigInt.asIntN(32, code))); }
    const result = bytes(response, 4); if (!result.length) throw new Error('PCMgr 响应缺少业务数据'); return result;
}
export async function exchangePCMgrCode(code: string, clientGuid: string): Promise<PCMgrCredentials> {
    let r: Response;
    try { r = await fetch('https://jprx.m.qq.com/data/3078/forward', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ req: { platType: 3, loginAccType: 32, authCode: code, clientGuid } }), redirect: 'error', signal: AbortSignal.timeout(35000) }); }
    catch { throw new Error('PCMgr 授权服务暂时无法连接'); }
    if (!r.ok) throw new Error(`PCMgr 授权 HTTP ${r.status}`);
    let data: any;
    try { const raw = await r.text(); if (raw.length > 1000000) throw new Error(); data = JSON.parse(raw.replace(/("accountId"\s*:\s*)(\d+)/g, '$1"$2"')); }
    catch { throw new Error('PCMgr 授权响应格式无效'); }
    const v = data?.data?.resp;
    if (data?.ret !== 0 || v?.retCode !== 0) throw new Error(`PCMgr 授权被拒绝（${Number.isFinite(v?.retCode) ? v.retCode : '响应无状态码'}）`);
    const scope = Array.isArray(v.wxscope) ? v.wxscope : String(v.wxscope || '').split(',');
    if (!scope.some((s: unknown) => String(s).trim() === 'snsapi_runtime_pcsdk')) throw new Error('PCMgr 未取得小游戏权限');
    const creds: PCMgrCredentials = { accountId: String(v.accountId || ''), loginKey: v.loginkey, clientGuid, renewedAt: Date.now(), renewInterval: Number(v.renewalTime) || 0, nickname: String(v.thirdPartyAccInfo?.nickName || '') };
    validatePCMgr(creds); return creds;
}
export async function fetchPCMgrBuffer(c: PCMgrCredentials, call = callPCMgr): Promise<string> {
    validatePCMgr(c);
    const req = Buffer.concat([pcInt(1, BigInt(c.accountId)), pcBytes(2, Buffer.from(c.loginKey)), pcBytes(3, Buffer.from(c.clientGuid))]);
    const fields = pcFields(await call(20138, Buffer.from(c.clientGuid, 'hex'), req));
    if (fields.has(1) && typeof fields.get(1) !== 'bigint') throw new Error('PCMgr 业务结果类型无效');
    if (num(fields, 1)) throw new PCMgrRejected(20138, Number(BigInt.asIntN(32, num(fields, 1))));
    const buffer = bytes(fields, 3).toString(); const raw = Buffer.from(buffer, 'base64');
    const ticket = pcFields(raw);
    if (raw.toString('base64') !== buffer || !bytes(ticket, 1).length || !bytes(ticket, 2).length || bytes(ticket, 3).toString() !== PCMGR_HOST_APP_ID) throw new Error('PCMgr 票据身份不匹配');
    return buffer;
}
export async function renewPCMgr(c: PCMgrCredentials, call = callPCMgr): Promise<PCMgrCredentials> {
    validatePCMgr(c);
    const req = Buffer.concat([pcInt(1, 2), pcInt(2, BigInt(c.accountId)), pcBytes(3, Buffer.from(c.loginKey)), pcBytes(4, Buffer.from(c.clientGuid))]);
    const fields = pcFields(await call(20042, Buffer.from(c.clientGuid, 'hex'), req));
    if (fields.has(1) && typeof fields.get(1) !== 'bigint') throw new Error('PCMgr 续期结果类型无效');
    if (num(fields, 1)) throw new PCMgrRejected(20042, Number(BigInt.asIntN(32, num(fields, 1))));
    if (num(fields, 2) !== 2n || num(fields, 3) !== BigInt(c.accountId) || num(fields, 5) < 1n || num(fields, 5) > 0x7fffffffn) throw new Error('PCMgr 续期身份或周期不匹配');
    const next = { ...c, loginKey: bytes(fields, 4).toString(), renewedAt: Date.now(), renewInterval: Number(num(fields, 5)) }; validatePCMgr(next); return next;
}
