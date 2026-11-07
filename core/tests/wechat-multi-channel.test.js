const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { MultiChannelLoginService } = require('../dist/services/wx-login/multi-channel');
const { hasSavedAuthorization, normalizeLoginChannel } = require('../dist/services/wx-login/credentials');
const { exchangePCMgrCode, fetchPCMgrBuffer, renewPCMgr, pcBytes, pcInt, decryptPCMgr, PCMGR_HOST_APP_ID } = require('../dist/services/wx-login/pcmgr');
const pc = { accountId: '42', loginKey: 'old', clientGuid: 'a'.repeat(32), renewedAt: 1, renewInterval: 0 };
function mockFetch(t, fn) { const old = global.fetch; global.fetch = fn; t.after(() => { global.fetch = old; }); }

test('only YYB and PCMgr are accepted and old saved YYB credentials remain valid', () => {
    assert.equal(normalizeLoginChannel(), 'yyb');
    for (const channel of ['yyb', 'pcmgr']) assert.equal(normalizeLoginChannel(channel), channel);
    assert.throws(() => normalizeLoginChannel('gameassist'));
    assert.equal(hasSavedAuthorization({ provider: 'gameassist', openid: 'removed', accessToken: 'a', refreshToken: 'r' }), false);
    assert.throws(() => normalizeLoginChannel('https://untrusted.invalid'));
    assert.equal(hasSavedAuthorization({ openid: 'old', accessToken: 'a', refreshToken: 'r' }), true);
    assert.equal(hasSavedAuthorization({ provider: 'pcmgr', openid: 'pcmgr:42', accessToken: '', refreshToken: '', pcmgr: pc }), true);
    assert.equal(hasSavedAuthorization({ provider: 'pcmgr', openid: 'pcmgr:43', pcmgr: pc }), false);
});

test('PCMgr QR uses its own OAuth identity and preserves its device GUID', async t => {
    const urls = [];
    mockFetch(t, async url => { urls.push(new URL(url)); return new Response(url.includes('/connect/qrcode/') ? Buffer.from([255, 216, ...Array(120).fill(0)]) : '<img src="/connect/qrcode/synthetic-uuid">'); });
    const service = new MultiChannelLoginService({ preserveAuthorization: true });
        const { session } = await service.createQrSession('pcmgr');
        const query = urls.at(-2).searchParams;
        assert.equal(query.get('scope'), 'snsapi_login,snsapi_runtime_pcsdk');
        assert.equal(query.get('appid'), PCMGR_HOST_APP_ID);
        assert.equal(query.get('redirect_uri'), 'https://security.guanjia.qq.com/login');
        assert.equal(query.get('state'), '233');
        assert.equal(session.channel, 'pcmgr');
        assert.equal(session.clientGuid.length, 32);
});

test('PCMgr OAuth requires both success codes and runtime scope, preserving 64-bit account identity', async t => {
    const body = '{"ret":0,"data":{"resp":{"retCode":0,"accountId":9007199254740993,"loginkey":"private-key","wxscope":"snsapi_login,snsapi_runtime_pcsdk"}}}';
    mockFetch(t, async (url, init) => { assert.equal(url, 'https://jprx.m.qq.com/data/3078/forward'); assert.equal(JSON.parse(init.body).req.clientGuid, pc.clientGuid); return new Response(body); });
    assert.equal((await exchangePCMgrCode('synthetic-code', pc.clientGuid)).accountId, '9007199254740993');
    for (const response of [{ ret: 0, data: { resp: { accountId: 42, loginkey: 'secret' } } }, { ret: 0, data: { resp: { retCode: 0, accountId: 42, loginkey: 'secret', wxscope: 'snsapi_login' } } }]) {
        global.fetch = async () => Response.json(response);
        await assert.rejects(exchangePCMgrCode('synthetic-code', pc.clientGuid), e => !e.message.includes('secret'));
    }
});

test('PCMgr renewal rotates only a matching account key and its saved device; rejects malformed results', async () => {
    const fresh = await renewPCMgr(pc, async (cmd, guid, req) => {
        assert.equal(cmd, 20042); assert.equal(guid.toString('hex'), pc.clientGuid);
        assert.equal(req.toString('hex'), '0802102a1a036f6c642220' + Buffer.from(pc.clientGuid).toString('hex'));
        return Buffer.from('1002182a22036e657728e002', 'hex');
    });
    assert.equal(fresh.loginKey, 'new'); assert.equal(fresh.renewInterval, 352); assert.equal(fresh.clientGuid, pc.clientGuid); assert.equal(pc.loginKey, 'old');
    for (const raw of ['1002182b22036e657728e002', '1002182a220028e002', '0802', '0a001002182a22036e657728e002']) await assert.rejects(renewPCMgr(pc, async () => Buffer.from(raw, 'hex')));
});

test('PCMgr buffer requires its own host and handles proto3 omitted zero without accepting invalid/duplicate results', async () => {
    const make = host => Buffer.concat([pcBytes(1, Buffer.from('synthetic-ticket')), pcBytes(2, Buffer.from('device')), pcBytes(3, Buffer.from(host))]).toString('base64');
    const buffer = make(PCMGR_HOST_APP_ID);
    assert.equal(await fetchPCMgrBuffer(pc, async (cmd, guid, req) => { assert.equal(cmd, 20138); assert.equal(guid.toString('hex'), pc.clientGuid); assert.ok(req.length); return pcBytes(3, Buffer.from(buffer)); }), buffer);
    for (const raw of [Buffer.alloc(0), Buffer.from([10, 0]), Buffer.from([24, 1]), Buffer.concat([pcInt(1, 4294967296n), pcBytes(3, Buffer.from(buffer))]), Buffer.concat([pcBytes(3, Buffer.from(buffer)), pcBytes(3, Buffer.from(buffer))]), pcBytes(3, Buffer.from(make('wxd44977328b36e647')))]) await assert.rejects(fetchPCMgrBuffer(pc, async () => raw), error => !error.message.includes('synthetic-ticket'));
});

test('PCMgr authenticated envelope rejects changed bytes, wrong command and wrong sequence', () => {
    const key = Buffer.alloc(16), iv = Buffer.alloc(12), seq = 123, cmd = 20138;
    const plain = Buffer.alloc(64); plain.writeUInt16BE(11); plain.writeUInt16BE(cmd, 2); plain.writeUInt32BE(seq, 4); plain.writeUInt32BE(64, 8);
    const n = Buffer.from(iv); n.writeUInt32LE(seq, 4);
    const c = crypto.createCipheriv('aes-128-gcm', key, n); const ciphertext = Buffer.concat([c.update(plain), c.final()]);
    const h = Buffer.alloc(56); h.writeUInt16BE(11); h.writeUInt16BE(cmd, 2); h.writeUInt16BE(56, 4); h.writeUInt32BE(120, 8); h.writeUInt32BE(seq, 12); c.getAuthTag().copy(h, 24);
    const packet = Buffer.concat([h, ciphertext]); assert.equal(decryptPCMgr(packet, key, iv, cmd, seq).length, 0);
    assert.throws(() => decryptPCMgr(packet, key, iv, cmd, seq + 1)); assert.throws(() => decryptPCMgr(packet, key, iv, 20042, seq));
    packet[60] ^= 1; assert.throws(() => decryptPCMgr(packet, key, iv, cmd, seq), /认证失败/);
});
