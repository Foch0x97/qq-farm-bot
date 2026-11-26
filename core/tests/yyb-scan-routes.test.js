const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { ScanStore } = require('../dist/services/yyb-scan-store');
const credentials = { openid: 'scan-user', accessToken: 'private-access', refreshToken: 'private-refresh' };

async function harness(t, options = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yyb-scan-api-'));
    const vault = new ScanStore(directory);
    const accounts = [{ id: 'original', name: '原有微信', platform: 'wx', code: 'native-code' }];
    const starts = []; const restarts = []; let confirms = 0; let destroyed = 0;
    const service = {
        createQrSession: async () => ({ session: { cookies: new Map(), uuid: 'uuid' }, qr: Buffer.from('synthetic-qr') }),
        poll: async () => 'authorized',
        confirm: async session => { confirms++; await options.confirm?.(); session.credentials = { ...credentials }; session.nickname = '测试昵称'; },
        issueCode: async () => 'scan-code',
        destroy: session => { destroyed++; session.credentials = undefined; },
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
    const closeScan = module.exports.mountYybScanRoutes(app, { provider: {
        startAccount: async id => { starts.push(id); return options.start ? options.start() : true; },
        restartAccount: async id => { restarts.push(id); return options.restart ? options.restart() : true; },
        getYybScan: id => vault.matches(id, accounts.find(a => a.id === id)) ? { available: true, enabled: true, reconnectDelayMin: 3, reconnectMaxAttempts: 3, phase: 'stopped', attempts: 0 } : { available: false },
        configureYybScan() {}, retryYybScan() {},
    } }, service, vault);
    server.once('close', closeScan);
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
    return { call, task, accounts, starts, restarts, vault, directory, confirms: () => confirms, destroyed: () => destroyed, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
test('scan endpoints require auth; settings persist and only explicit scan completion saves authorization', async t => {
    const h = await harness(t);
    assert.equal((await h.call('/api/yyb-scan/tasks', 'POST', undefined, false)).status, 401);
    await h.call('/api/yyb-scan/config', 'POST', { enabled: false, reconnectDelayMin: 2, reconnectMaxAttempts: 4 });
    assert.deepEqual(new ScanStore(h.directory).defaults(), { enabled: false, reconnectDelayMin: 2, reconnectMaxAttempts: 4 });
    const url = await h.task();
    const image = await h.call(url + '/qr'); assert.equal(await image.text(), 'synthetic-qr');
    const result = await (await h.call(url + '/complete', 'POST', { enabled: true, reconnectDelayMin: 3, reconnectMaxAttempts: 3, remark: '   ' })).json();
    assert.equal(result.ok, true); assert.equal(result.data.accountId, 'scan-added');
    assert.equal(result.data.startup, 'connecting');
    assert.equal(h.accounts[1].name, '测试昵称');
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
test('completion waits for startup, retains authorization on failure and returns the same outcome on retry', async t => {
    let finishStart;
    let enteredStart;
    const starting = new Promise(resolve => { enteredStart = resolve; });
    const h = await harness(t, { start: () => new Promise(resolve => { finishStart = resolve; enteredStart(); }) });
    const url = await h.task();
    let responded = false;
    const first = h.call(url + '/complete', 'POST', {}).then(response => { responded = true; return response.json(); });
    await starting;
    assert.equal(responded, false);
    assert.ok(h.vault.get('scan-added'));
    const duplicate = h.call(url + '/complete', 'POST', {}).then(response => response.json());
    finishStart(false);
    const saved = { ok: true, data: { accountId: 'scan-added', startup: 'failed' } };
    assert.deepEqual(await first, saved);
    assert.deepEqual(await duplicate, saved);
    assert.equal(h.confirms(), 1);
    assert.deepEqual(h.starts, ['scan-added']);
});

test('rejected restart leaves the updated account and saved authorization available', async t => {
    const h = await harness(t, { restart: () => { throw new Error('internal failure'); } });
    const url = await h.task();
    const response = await (await h.call(url + '/complete', 'POST', { accountId: 'original' })).json();
    assert.deepEqual(response, { ok: true, data: { accountId: 'original', startup: 'failed' } });
    assert.ok(h.vault.matches('original', h.accounts[0]));
    assert.equal(h.accounts.length, 1);
});

test('closing the HTTP server disposes active WeChat scan tasks', async t => {
    const h = await harness(t);
    await h.task();
    assert.equal(h.destroyed(), 0);
    await h.close();
    assert.equal(h.destroyed(), 1);
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
test('WeChat remark overrides the nickname and updates the selected account when editing', async t => {
    const h = await harness(t);
    const added = await h.task();
    await h.call(added + '/complete', 'POST', { remark: '  农场小号  ' });
    assert.equal(h.accounts[1].name, '农场小号');
    const edited = await h.task();
    await h.call(edited + '/complete', 'POST', { accountId: 'scan-added', remark: '新备注' });
    assert.equal(h.accounts.length, 2);
    assert.equal(h.accounts[1].name, '新备注');
});
