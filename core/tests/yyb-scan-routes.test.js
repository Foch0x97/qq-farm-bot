const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { ScanStore } = require('../dist/services/yyb-scan-store');
const { WxLoginService } = require('../dist/services/wx-login/service');
const credentials = { openid: 'scan-user', accessToken: 'private-access', refreshToken: 'private-refresh' };

async function harness(t, options = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yyb-scan-api-'));
    const vault = new ScanStore(directory);
    const accounts = [{ id: 'original', name: '原有微信', platform: 'wx', code: 'native-code' }];
    const starts = []; const restarts = []; let confirms = 0;
    const service = {
        createQrSession: async () => ({ session: { cookies: new Map(), uuid: 'uuid' }, qr: Buffer.from('synthetic-qr') }),
        poll: async () => 'authorized',
        confirm: async session => { confirms++; await options.confirm?.(); session.credentials = { ...credentials }; session.nickname = '测试昵称'; },
        issueCode: async () => 'scan-code',
        destroy: session => { session.credentials = undefined; },
    };
    const filename = path.resolve(__dirname, '../dist/controllers/admin/yyb-scan-routes.js');
    const realRequire = createRequire(filename); const module = { exports: {} };
    const store = {
        getAccounts: () => ({ accounts }),
        addOrUpdateAccount: value => {
            if (value.id) Object.assign(accounts.find(a => a.id === value.id), value);
            else accounts.push({ ...value, id: 'scan-added' });
            return { accounts };
        },
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        require: name => name === '../../models/store' ? store : realRequire(name),
        module, exports: module.exports, Buffer, Date, setInterval, clearInterval, console,
    }, { filename });
    const express = require('express'); const app = express(); app.use(express.json());
    app.use('/api', (req, res, next) => req.headers['x-admin-token'] === 'test' ? next() : res.sendStatus(401));
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    module.exports.mountYybScanRoutes(app, { server, provider: {
        startAccount: id => starts.push(id), restartAccount: id => restarts.push(id),
        getYybScan: id => vault.matches(id, accounts.find(a => a.id === id)) ? { available: true, enabled: true, reconnectDelayMin: 3, reconnectMaxAttempts: 3, phase: 'stopped', attempts: 0 } : { available: false },
        configureYybScan() {}, retryYybScan() {},
    } }, service, vault);
    t.after(() => { server.closeAllConnections(); server.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (url, method = 'GET', data, auth = true) => fetch(base + url, {
        method, headers: { 'Content-Type': 'application/json', ...(auth ? { 'x-admin-token': 'test' } : {}) },
        ...(data ? { body: JSON.stringify(data) } : {}),
    });
    async function task() {
        const created = await (await call('/api/yyb-scan/tasks', 'POST')).json();
        const id = created.data.taskId;
        await call(`/api/yyb-scan/tasks/${id}/status`);
        return `/api/yyb-scan/tasks/${id}`;
    }
    return { call, task, accounts, starts, restarts, vault, directory, confirms: () => confirms };
}
test('scan endpoints require auth; settings persist and only explicit scan completion saves authorization', async t => {
    const h = await harness(t);
    assert.equal((await h.call('/api/yyb-scan/tasks', 'POST', undefined, false)).status, 401);
    await h.call('/api/yyb-scan/config', 'POST', { enabled: false, reconnectDelayMin: 2, reconnectMaxAttempts: 4 });
    assert.deepEqual(new ScanStore(h.directory).defaults(), { enabled: false, reconnectDelayMin: 2, reconnectMaxAttempts: 4 });
    const url = await h.task();
    const image = await h.call(url + '/qr'); assert.equal(await image.text(), 'synthetic-qr');
    const result = await (await h.call(url + '/complete', 'POST', { enabled: true, reconnectDelayMin: 3, reconnectMaxAttempts: 3 })).json();
    assert.equal(result.ok, true); assert.equal(result.data.accountId, 'scan-added');
    assert.deepEqual(h.starts, ['scan-added']); assert.equal(h.accounts[0].code, 'native-code');
    assert.equal(h.vault.get('original'), undefined); assert.equal(h.vault.get('scan-added').credentials.refreshToken, credentials.refreshToken);
    assert.ok(!JSON.stringify(h.accounts).includes('private')); assert.ok(!JSON.stringify(result).includes('private'));
    assert.ok(!fs.readFileSync(path.join(h.directory, 'yyb-scan-authorization.enc'), 'utf8').includes('private'));
});
test('concurrent scan completion is single-flight and idempotent', async t => {
    let finish; let entered;
    const ready = new Promise(resolve => { entered = resolve; });
    const h = await harness(t, { confirm: () => { entered(); return new Promise(resolve => { finish = resolve; }); } });
    const url = await h.task();
    const first = h.call(url + '/complete', 'POST', {}); await ready;
    const second = h.call(url + '/complete', 'POST', {});
    finish();
    assert.equal((await (await first).json()).ok, true); assert.equal((await (await second).json()).ok, true);
    assert.equal(h.confirms(), 1); assert.equal(h.accounts.length, 2); assert.equal(h.starts.length, 1);
});
test('closing scan while confirm is pending never adds or restarts an account', async t => {
    let finish; let entered;
    const ready = new Promise(resolve => { entered = resolve; });
    const h = await harness(t, { confirm: () => { entered(); return new Promise(resolve => { finish = resolve; }); } });
    const url = await h.task(); const completing = h.call(url + '/complete', 'POST', {}); await ready;
    await h.call(url, 'DELETE'); finish();
    assert.equal((await (await completing).json()).ok, false);
    assert.equal(h.accounts.length, 1); assert.equal(h.starts.length, 0); assert.deepEqual(h.vault.list(), {});
});
test('scan relogin updates the explicitly edited account without duplicating it', async t => {
    const h = await harness(t); const url = await h.task();
    const result = await (await h.call(url + '/complete', 'POST', { accountId: 'original' })).json();
    assert.equal(result.ok, true); assert.equal(h.accounts.length, 1); assert.equal(h.accounts[0].name, '原有微信');
    assert.deepEqual(h.restarts, ['original']); assert.equal(h.vault.get('original').credentials.openid, credentials.openid);
});
test('only the new opt-in login service retains refresh authorization; upstream WeChat behavior stays unchanged', async t => {
    const original = global.fetch; t.after(() => { global.fetch = original; });
    global.fetch = async url => ({ status: 200, headers: new Headers(), arrayBuffer: async () => Buffer.from(JSON.stringify(String(url).includes('login_buffer')
        ? { code: 0, ext_info: { list_s: { login_buffer: { value: ['buffer'] } } } }
        : { code: 0, nick_name: 'nickname' })) });
    for (const preserveAuthorization of [false, true]) {
        const service = new WxLoginService({ preserveAuthorization });
        const session = { cookies: new Map([['openid', credentials.openid], ['accesstoken', credentials.accessToken], ['refreshtoken', credentials.refreshToken]]), uuid: 'uuid', oauthCode: 'oauth' };
        await service.confirm(session);
        assert.deepEqual(session.credentials, preserveAuthorization ? credentials : undefined);
        assert.equal(session.cookies.size, 0); service.destroy(session); assert.equal(session.credentials, undefined);
    }
});
