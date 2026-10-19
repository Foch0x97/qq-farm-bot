const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { ScanStore: WxAuthorizationStore } = require('../dist/services/yyb-scan-store');
const scanConfig = { enabled: true, reconnectDelayMin: 3, reconnectMaxAttempts: 3 };
const { YybScanReconnect: WxReconnect } = require('../dist/runtime/yyb-scan-reconnect');
const { refreshWxCredentials, fetchWxLoginBuffer, WxAuthorizationExpired } = require('../dist/services/wx-login/credentials');
const credentials = { openid: 'test-openid', accessToken: 'test-access-secret', refreshToken: 'test-refresh-secret' };
function vaultFor(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-wx-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return { vault: new WxAuthorizationStore(directory), directory };
}
function harness(t, overrides = {}) {
    const { vault, directory } = vaultFor(t);
    vault.set('1', scanConfig, 'initial', credentials);
    let account = { id: '1', platform: 'wx', code: 'initial' };
    let worker = false; let online = false; let time = 1_000_000;
    const timers = new Map(); const starts = []; const logs = []; const notices = []; const recovered = [];
    const coordinator = new WxReconnect({
        vault, getAccount: () => account, hasWorker: () => worker, isOnline: () => online,
        startWorker: acc => { starts.push({ ...acc }); worker = true; return true; },
        saveCode: (_id, code) => { account.code = code; },
        refresh: async () => ({ ...credentials, refreshToken: 'rotated-secret' }),
        loginBuffer: async () => 'test-buffer', issueCode: async () => 'new-code',
        log: (_id, text) => logs.push(text), notify: (_id, reason) => notices.push(reason), recovered: id => recovered.push(id),
        now: () => time,
        setTimer: (fn, delay) => { const timer = {}; timers.set(timer, { fn, delay }); return timer; },
        clearTimer: timer => timers.delete(timer), ...overrides,
    });
    t.after(() => coordinator.close());
    const h = { vault, directory, coordinator, starts, logs, notices, recovered, timers,
        remove: () => { account = undefined; vault.remove('1'); },
        offline: () => { worker = false; online = false; },
        connected: () => { online = true; coordinator.online('1'); },
        async ticks(count = 1) {
            for (let i = 0; i < count; i++) {
                const [timer, item] = timers.entries().next().value;
                timers.delete(timer); time += item.delay; item.fn();
                await new Promise(resolve => setImmediate(resolve));
            }
        },
    };
    return h;
}
test('scan credentials are encrypted and separate from ordinary WeChat or QQ accounts', t => {
    const h = harness(t);
    assert.deepEqual(new WxAuthorizationStore(h.directory).get('1').credentials, credentials);
    const encrypted = fs.readFileSync(path.join(h.directory, 'yyb-scan-authorization.enc'), 'utf8');
    assert.ok(!encrypted.includes(credentials.refreshToken));
    assert.equal(h.vault.matches('1', { platform: 'wx', code: 'external-code' }), false);
    assert.equal(h.vault.matches('1', { platform: 'qq', code: 'initial' }), false);
});
test('damaged authorization data is never silently overwritten', t => {
    const { vault, directory } = vaultFor(t);
    vault.set('1', scanConfig, 'code', credentials);
    const filename = path.join(directory, 'yyb-scan-authorization.enc'); fs.writeFileSync(filename, 'damaged');
    assert.throws(() => vault.set('1', scanConfig, 'other', credentials), /授权无法读取/);
    assert.equal(fs.readFileSync(filename, 'utf8'), 'damaged');
});
test('Go defaults: detect on 30s scan then wait 3min; rotate token and restart with fresh code', async t => {
    const h = harness(t); h.coordinator.disconnected('1');
    await h.ticks(6); assert.equal(h.starts.length, 0);
    await h.ticks(); assert.equal(h.starts.length, 1); assert.equal(h.starts[0].code, 'new-code');
    assert.equal(h.vault.get('1').credentials.refreshToken, 'rotated-secret');
    assert.equal(h.coordinator.status('1').attempts, 1); h.connected();
    assert.equal(h.coordinator.status('1').phase, 'online'); assert.deepEqual(h.recovered, ['1']);
    assert.ok(!JSON.stringify(h.coordinator.status('1')).includes('secret'));
});
test('Go retry timing: after initial delay retry next 30s scans, stop after configured max and clear count', async t => {
    const h = harness(t, { startWorker: () => false });
    h.coordinator.disconnected('1'); await h.ticks(7);
    assert.equal(h.coordinator.status('1').attempts, 1);
    await h.ticks(); assert.equal(h.coordinator.status('1').attempts, 2);
    await h.ticks(); assert.equal(h.coordinator.status('1').attempts, 3);
    await h.ticks(); assert.equal(h.coordinator.status('1').phase, 'failed');
    assert.equal(h.coordinator.status('1').attempts, 0);
    assert.deepEqual(h.notices, ['wx_reconnect_exhausted']);
});
test('Go successful reconnection preserves attempts even after stable online time', async t => {
    const h = harness(t); h.coordinator.disconnected('1'); await h.ticks(7); h.connected();
    await h.ticks(20); assert.equal(h.coordinator.status('1').attempts, 1);
    h.offline(); h.coordinator.disconnected('1'); await h.ticks(7); h.connected();
    assert.equal(h.coordinator.status('1').attempts, 2);
});
test('Go timeout exemption retries indefinitely without consuming attempts', async t => {
    let calls = 0;
    const h = harness(t, { startWorker: () => { calls++; return false; } });
    h.coordinator.configure('1', { reconnectMaxAttempts: 1 });
    h.coordinator.disconnected('1', { source: 'request_timeout' }); await h.ticks(13);
    assert.equal(calls, 7); assert.equal(h.coordinator.status('1').attempts, 0);
    assert.equal(h.coordinator.status('1').transient, true); assert.equal(h.coordinator.status('1').phase, 'waiting');
});
test('duplicate disconnects never overlap; stop during refresh cannot restart account', async t => {
    let finish; let calls = 0;
    const h = harness(t, { refresh: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
    h.coordinator.disconnected('1'); h.coordinator.disconnected('1'); await h.ticks(10);
    assert.equal(calls, 1); h.coordinator.cancel('1'); finish({ ...credentials, refreshToken: 'rotated-after-stop' });
    await new Promise(resolve => setImmediate(resolve)); await h.ticks(10);
    assert.equal(h.starts.length, 0); assert.equal(h.vault.get('1').credentials.refreshToken, 'rotated-after-stop');
    assert.equal(h.coordinator.disconnected('1'), false);
});
test('deletion and a fresh QR session win over an older async authorization refresh', async t => {
    for (const mode of ['delete', 'new-scan']) {
        let finish;
        const h = harness(t, { refresh: () => new Promise(resolve => { finish = resolve; }) });
        h.coordinator.disconnected('1'); await h.ticks(7);
        if (mode === 'delete') h.remove();
        else { h.vault.set('1', scanConfig, 'new', { ...credentials, openid: 'replacement' }); }
        finish(credentials); await new Promise(resolve => setImmediate(resolve));
        assert.equal(h.starts.length, 0);
        assert.equal(h.vault.get('1')?.credentials.openid, mode === 'delete' ? undefined : 'replacement');
    }
});
test('Go fallback uses old code if refresh fails; expired authorization is visible and retry remains bounded', async t => {
    const h = harness(t, { refresh: async () => { throw new WxAuthorizationExpired(); } });
    h.coordinator.disconnected('1'); await h.ticks(7);
    assert.equal(h.starts[0].code, 'initial'); assert.equal(h.coordinator.status('1').needsScan, true);
    h.offline(); h.coordinator.disconnected('1', { source: 'login_rejected' }); await h.ticks();
    assert.equal(h.starts.length, 2); assert.equal(h.coordinator.status('1').attempts, 2);
    assert.deepEqual(h.notices, ['wx_authorization_expired']);
});
test('config persists per account, is editable and resets count; manual retry is immediate and uncounted', async t => {
    const h = harness(t); h.coordinator.configure('1', { reconnectDelayMin: 1, reconnectMaxAttempts: 7 });
    assert.equal(new WxAuthorizationStore(h.directory).get('1').reconnectMaxAttempts, 7);
    h.coordinator.disconnected('1'); await h.ticks(2); assert.equal(h.starts.length, 0);
    await h.ticks(); assert.equal(h.starts.length, 1);
    h.offline(); h.coordinator.retryNow('1'); await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.starts.length, 2); assert.equal(h.coordinator.status('1').attempts, 0);
    h.coordinator.configure('1', { reconnectDelayMin: 0, reconnectMaxAttempts: -1 });
    assert.equal(h.coordinator.config('1').reconnectDelayMin, 3); assert.equal(h.coordinator.config('1').reconnectMaxAttempts, 3);
    assert.throws(() => h.coordinator.configure('1', { reconnectDelayMin: 1.2 }));
});
test('Go kicked recovery waits configured delay, including immediate special path when scheduled recovery disabled', async t => {
    const h = harness(t); h.coordinator.disconnected('1', { kicked: true }); await h.ticks(5);
    assert.equal(h.starts.length, 0); await h.ticks(); assert.equal(h.starts.length, 1);
    h.offline(); h.coordinator.configure('1', { enabled: false });
    assert.equal(h.coordinator.disconnected('1'), false);
    assert.equal(h.coordinator.disconnected('1', { kicked: true }), true);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(h.starts.length, 2);
});
test('disabled scheduled recovery finishes its kick attempt when worker startup fails, without retrying forever', async t => {
    let starts = 0;
    const h = harness(t, { startWorker: () => { starts++; return false; } });
    h.coordinator.configure('1', { enabled: false });
    h.coordinator.disconnected('1', { kicked: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.coordinator.status('1').phase, 'stopped');
    assert.equal(h.coordinator.status('1').pending, false);
    await h.ticks(20);
    assert.equal(starts, 1);
});
test('disabled scheduled recovery clears connecting state after failed kick login', async t => {
    const h = harness(t);
    h.coordinator.configure('1', { enabled: false });
    h.coordinator.disconnected('1', { kicked: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.coordinator.status('1').phase, 'connecting');
    h.offline();
    h.coordinator.disconnected('1', { source: 'login_rejected' });
    assert.equal(h.coordinator.status('1').phase, 'stopped');
    assert.equal(h.coordinator.status('1').pending, false);
    await h.ticks(20);
    assert.equal(h.starts.length, 1);
});
test('1000016 permanently disables reconnect; explicit manual stop never reopens after kick', async t => {
    const h = harness(t); h.coordinator.disconnected('1', { code: 1000016 });
    assert.equal(h.vault.get('1').enabled, false); assert.equal(h.coordinator.status('1').phase, 'restricted');
    assert.throws(() => h.coordinator.retryNow('1'));
    h.coordinator.cancel('1'); assert.equal(h.coordinator.disconnected('1', { kicked: true }), false);
    await h.ticks(20); assert.equal(h.starts.length, 0);
});
test('manual authorization refresh is single-flight and does not restart online game session', async t => {
    const h = harness(t); await h.coordinator.refreshAuthorization('1');
    assert.equal(h.vault.get('1').credentials.refreshToken, 'rotated-secret'); assert.equal(h.starts.length, 0);
});
test('YYB refresh uses exact field names/signature, persists new refresh token, and sends it for login buffer', async t => {
    const oldFetch = global.fetch; t.after(() => { global.fetch = oldFetch; }); let calls = 0;
    global.fetch = async (url, init) => {
        calls++; assert.equal(init.redirect, 'error'); const value = JSON.parse(init.body);
        assert.equal(init.headers['Ual-Access-Signature'], crypto.createHash('md5').update(`${init.body}${init.headers['Ual-Access-Timestamp']}wgrdg373hy26ww2${init.headers['Ual-Access-Nonce']}`).digest('hex'));
        if (calls === 1) {
            assert.equal(new URL(url).pathname, '/pc_yyb_auth/pcyyb_refresh_token_auth');
            assert.deepEqual(value, { userInfo: { openId: credentials.openid, refreshToken: credentials.refreshToken, accessToken: credentials.accessToken, loginType: 'WX' } });
            return new Response(JSON.stringify({ code: 0, user_info: { access_token: 'new-access', refresh_token: 'new-refresh' } }));
        }
        assert.equal(value.extInfo.listS.access_token.value[0], 'new-access'); assert.ok(init.headers.Cookie.includes('refreshtoken=new-refresh'));
        return new Response(JSON.stringify({ code: 0, ext_info: { list_s: { login_buffer: { value: ['new-buffer'] } } } }));
    };
    assert.equal(await fetchWxLoginBuffer(await refreshWxCredentials(credentials)), 'new-buffer');
});
test('transport failures and rejected authorization are distinct and response secrets never reach errors', async t => {
    const oldFetch = global.fetch; t.after(() => { global.fetch = oldFetch; });
    global.fetch = async () => new Response('private token', { status: 503 });
    await assert.rejects(refreshWxCredentials(credentials), e => !(e instanceof WxAuthorizationExpired) && !e.message.includes('private'));
    global.fetch = async () => new Response(JSON.stringify({ code: -1, msg: 'private token' }));
    await assert.rejects(refreshWxCredentials(credentials), e => e instanceof WxAuthorizationExpired && !e.message.includes('private'));
});
