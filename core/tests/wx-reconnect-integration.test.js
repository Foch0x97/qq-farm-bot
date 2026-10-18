const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { WxAuthorizationStore } = require('../dist/services/wx-login/authorization-store');

function load(relative, overrides) {
    const filename = path.resolve(__dirname, relative);
    const realRequire = createRequire(filename);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module, exports: module.exports, require: name => overrides[name] || realRequire(name),
        process, Buffer, setTimeout, clearTimeout, Date, console,
    }, { filename });
    return module.exports;
}

test('QR authorization binds to the saved account, stays out of account responses, and is removed on deletion', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-wx-binding-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const vault = new WxAuthorizationStore(directory);
    const store = load('../dist/models/store/accounts.js', {
        '../../config/runtime-paths': { ensureDataDir() {} },
        './shared-state': { ACCOUNTS_FILE: path.join(directory, 'accounts.json') },
        './account-config': { ensureAccountConfig() {}, removeAccountConfig() {} },
        '../../services/wx-login/authorization-store': { wxAuthorizationStore: vault },
    });
    vault.stage('qr-code', { openid: 'test-id', accessToken: 'private-access', refreshToken: 'private-refresh' });
    const response = store.addOrUpdateAccount({ name: 'test', platform: 'wx', code: 'qr-code' });
    const id = response.accounts[0].id;
    assert.equal(vault.get(id).credentials.openid, 'test-id');
    assert.ok(!JSON.stringify(response).includes('private'));
    assert.ok(!fs.readFileSync(path.join(directory, 'accounts.json'), 'utf8').includes('private'));
    store.addOrUpdateAccount({ id, nick: 'nickname' });
    assert.equal(vault.get(id).credentials.openid, 'test-id');
    store.addOrUpdateAccount({ id, code: 'qr-code', name: 'renamed' });
    assert.equal(vault.get(id).credentials.openid, 'test-id');
    store.addOrUpdateAccount({ id, code: 'refreshed-code' }, { preserveWxAuthorization: true });
    assert.equal(vault.get(id).credentials.openid, 'test-id');
    store.deleteAccount(id);
    assert.equal(vault.get(id), undefined);
    const replacement = store.addOrUpdateAccount({ name: 'replacement', platform: 'wx', code: 'external-code' });
    assert.equal(replacement.accounts[0].id, id);
    assert.equal(vault.get(id), undefined);
});

function workerHarness() {
    const children = []; const workers = {}; const disconnects = []; const online = []; const timers = new Map();
    const { createWorkerManager } = load('../dist/runtime/worker-manager.js', {
        '../services/scheduler': { createScheduler: () => ({
            clear: key => timers.delete(key),
            setTimeoutTask: (key, _delay, callback) => timers.set(key, callback),
        }) },
    });
    const manager = createWorkerManager({
        fork: () => { const child = new EventEmitter(); child.send = () => {}; child.kill = () => {}; children.push(child); return child; },
        runtimeMode: 'fork', processRef: { env: {} }, mainEntryPath: 'unused', workerScriptPath: 'unused.js', workers,
        globalLogs: [], log() {}, addAccountLog() {}, normalizeStatusForPanel: value => value,
        buildConfigSnapshotForAccount: () => ({}), getOfflineAutoDeleteMs: () => Infinity,
        triggerOfflineReminder() {}, addOrUpdateAccount() {}, deleteAccount() {},
        onDisconnect: (id, details) => { disconnects.push({ id, ...details }); return true; },
        onOnline: id => online.push(id),
    });
    manager.startWorker({ id: '1', name: 'test', platform: 'wx', code: 'test-code' });
    return { manager, children, workers, disconnects, online };
}

test('worker terminal disconnect schedules recovery exactly once and ignores late messages', () => {
    const h = workerHarness();
    const child = h.children[0];
    child.emit('message', { type: 'account_disconnected', source: 'heartbeat_timeout', code: 1006 });
    child.emit('message', { type: 'account_disconnected', source: 'ws_close' });
    child.emit('message', { type: 'status_sync', data: { connection: { connected: true } } });
    child.emit('exit', 0);
    assert.equal(h.disconnects.length, 1);
    assert.equal(h.disconnects[0].source, 'heartbeat_timeout');
    assert.equal(h.online.length, 0);
    assert.equal(h.workers['1'], undefined);
});

test('unexpected worker exits notify recovery while intentional stops do not', () => {
    const unexpected = workerHarness(); unexpected.children[0].emit('exit', 1);
    assert.equal(unexpected.disconnects[0].source, 'worker_exit');
    const intentional = workerHarness(); intentional.manager.stopWorker('1'); intentional.children[0].emit('exit', 0);
    assert.equal(intentional.disconnects.length, 0);
});

test('kick and actual login success reach their respective recovery handlers', () => {
    const h = workerHarness();
    h.children[0].emit('message', { type: 'status_sync', data: { connection: { connected: true } } });
    assert.deepEqual(h.online, ['1']);
    h.children[0].emit('message', { type: 'account_kicked', reasonCode: 2 });
    assert.equal(h.disconnects[0].kicked, true);
});

test('account APIs validate config, isolate account ids, preserve authentication and expose no credential tokens', async t => {
    const express = require('express');
    const { mountWxAccountRoutes } = require('../dist/controllers/admin/wx-account-routes');
    const app = express(); app.use(express.json());
    app.use('/api', (req, res, next) => req.headers['x-admin-token'] === 'test-only' ? next() : res.sendStatus(401));
    const config = { available: true, enabled: true, reconnectDelayMin: 3, reconnectMaxAttempts: 3 };
    let refreshes = 0; let retries = 0;
    mountWxAccountRoutes(app, { provider: {
        getAccounts: () => ({ accounts: [{ id: '1', name: 'wechat', platform: 'wx' }, { id: '2', platform: 'qq' }] }),
        getWxReconnect: () => ({ ...config }),
        setWxReconnect: (_id, value) => Object.assign(config, value),
        refreshWxAuthorization: async () => { refreshes++; },
        retryWxReconnect: () => { retries++; },
    } });
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (url, body, auth = true) => fetch(base + url, {
        method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(auth ? { 'x-admin-token': 'test-only' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal((await call('/api/accounts/1/wx-reconnect', undefined, false)).status, 401);
    assert.equal((await call('/api/accounts/1/wx-reconnect', { reconnectDelayMin: 1.5 })).status, 500);
    assert.equal(config.reconnectDelayMin, 3);
    assert.equal((await call('/api/accounts/unknown/wx-reconnect')).status, 500);
    assert.equal((await call('/api/accounts/2/wx-reconnect')).status, 500);
    assert.equal((await call('/api/accounts/1/wx-reconnect', { reconnectDelayMin: 4, reconnectMaxAttempts: 6 })).status, 200);
    assert.equal(config.reconnectDelayMin, 4); assert.equal(config.reconnectMaxAttempts, 6);
    await call('/api/accounts/1/wx-reconnect/retry', {}); assert.equal(retries, 1);
    await call('/api/accounts/1/wx-authorization/refresh', {}); assert.equal(refreshes, 1);
    const list = await (await call('/api/wx-login/authorizations')).json();
    assert.equal(list.data.length, 1); assert.equal(list.data[0].accountId, '1');
    assert.ok(!JSON.stringify(list).includes('refreshToken'));
    await call('/api/wx-login/authorizations/refresh', {}); assert.equal(refreshes, 2);
});

test('native login sockets cleanly handle read timeouts and connection failures', async t => {
    const net = require('node:net');
    const filename = path.resolve(__dirname, '../dist/services/wx-login/native-protocol.js');
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.testSocket = socket;', {
        module, exports: module.exports, require: createRequire(filename), Buffer, setTimeout, clearTimeout, Date,
    }, { filename });
    const sockets = new Set();
    const server = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const port = server.address().port;
    t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
    const client = await module.exports.testSocket('127.0.0.1', port, 20);
    await assert.rejects(client.take(), /socket read timeout/); client.close();
    await new Promise(resolve => server.close(resolve));
    await assert.rejects(module.exports.testSocket('127.0.0.1', port, 100), /ECONNREFUSED/);
});
