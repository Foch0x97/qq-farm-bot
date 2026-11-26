const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function load(relative, overrides, extras = {}) {
    const filename = path.join(__dirname, '../dist', relative);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module, exports: module.exports, __dirname: path.dirname(filename), __filename: filename,
        require(name) {
            if (Object.hasOwn(overrides, name)) return overrides[name];
            if (name.startsWith('node:')) return require(name);
            throw new Error(`Unexpected dependency: ${name}`);
        }, ...extras,
    }, { filename });
    return module.exports;
}

test('hosted account controls preserve renewal lifecycle, await stops and retain existing session IDs', async () => {
    const calls = [];
    let providerOptions, reconnectOptions, finishStop;
    const account = { id: '1', platform: 'wx' };
    const workers = {};
    const reconnect = {
        resume: id => calls.push(['resume', id]), cancel: id => calls.push(['cancel', id]),
        close: () => calls.push(['close']), owns: () => true,
    };
    const engine = load('runtime/runtime-engine.js', {
        '../models/store': { getAccounts: () => ({ accounts: [account] }) },
        '../config/config': {}, '../services/push': {},
        './runtime-state': { createRuntimeState: () => ({ workers, runtimeEvents: new EventEmitter() }) },
        './relogin-reminder': { createReloginReminderService: () => ({}) },
        './data-provider': { createDataProvider: options => { providerOptions = options; return {}; } },
        './worker-manager': { createWorkerManager: () => ({
            startWorker: (acc, session) => { calls.push(['rawStart', acc.id, session]); return true; },
            stopWorker: id => calls.push(['rawStop', id]),
            restartWorker: () => Promise.resolve('restarted'),
            startAccountWorker: async acc => { calls.push(['hostStart', acc.id]); return true; },
            stopAccountWorker: acc => { calls.push(['hostStop', acc.id]); return new Promise(resolve => { finishStop = resolve; }); },
            detachAllWorkers: async () => calls.push(['detach']),
        }) },
        './yyb-scan-reconnect': { YybScanReconnect: class { constructor(options) { reconnectOptions = options; return reconnect; } } },
        '../session/ipc': {},
    }, { process: { env: {} } }).createRuntimeEngine({ processRef: { env: {} } });
    assert.equal(engine.startWorker(account, 'existing-session'), true);
    assert.deepEqual(calls.splice(0), [['resume', '1'], ['rawStart', '1', 'existing-session']]);
    assert.equal(await providerOptions.startWorker(account), true);
    assert.deepEqual(calls.splice(0), [['resume', '1'], ['hostStart', '1']]);
    const stopping = providerOptions.stopWorker(account);
    assert.deepEqual(calls.splice(0), [['cancel', '1'], ['hostStop', '1']]);
    finishStop(); await stopping;
    assert.equal(await providerOptions.restartWorker(account), 'restarted');
    assert.deepEqual(calls.splice(0), [['resume', '1']]);
    // Renewal uses the fresh code path rather than resetting its retry lifecycle.
    assert.equal(reconnectOptions.startWorker(account), true);
    assert.deepEqual(calls.splice(0), [['rawStart', '1', undefined]]);
    await engine.detachAllWorkers();
    assert.deepEqual(calls.splice(0), [['close'], ['detach']]);
});

test('worker manager forwards renewal ownership to the hosted gateway without marking ordinary accounts', () => {
    const children = [];
    class Child extends EventEmitter {
        sent = [];
        constructor() { super(); children.push(this); }
        postMessage(message) { this.sent.push(message); }
    }
    const manager = load('runtime/worker-manager.js', {
        '../services/scheduler': { createScheduler: () => ({}) },
        '@qq-farm-bot/session-contract': {},
        '../session/ipc': { accountSessionKey: account => account.id },
        '../config/runtime-paths': {},
    }, { process: { env: {} } }).createWorkerManager({
        WorkerThread: Child, processRef: { env: { FARM_SESSION_SOCKET: 'test-only' } },
        workerScriptPath: 'worker.js', workers: {}, log() {},
        buildConfigSnapshotForAccount: () => ({}), isYybScan: id => id === 'renewable',
    });
    manager.startWorker({ id: 'renewable', platform: 'wx' });
    manager.startWorker({ id: 'ordinary', platform: 'wx' });
    assert.equal(children[0].sent[0].config.yybScan, true);
    assert.equal(children[1].sent[0].config.yybScan, false);
});

test('hosted gateway applies third-party timeout recovery only to opted-in accounts', async () => {
    const port = new EventEmitter();
    const connected = [];
    const process = { env: {} };
    port.postMessage = () => {};
    load('session/gateway-worker.js', {
        'node:worker_threads': { parentPort: port }, './ipc': {},
        '../utils/proto': { loadProto: async () => {} },
        '../config/config': { updateRuntimeConfig() {} },
        '../utils/network': {
            networkEvents: new EventEmitter(),
            connect: (_code, ready) => { connected.push(process.env.FARM_YYB_SCAN); ready(); },
            getSessionSnapshot: () => ({}),
        },
    }, { process, Buffer });
    for (const yybScan of [true, false]) {
        port.emit('message', { id: connected.length, op: 'open', params: { yybScan } });
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.deepEqual(connected, ['1', '']);
});

test('unhosted restart waits for the previous worker to exit and reports a replacement startup failure', async () => {
    const children = [];
    let failStart = false;
    class Child extends EventEmitter {
        constructor() {
            super();
            if (failStart) throw new Error('worker failed to start');
            children.push(this);
        }
        postMessage() {}
    }
    const scheduler = { clear() {}, setTimeoutTask() {} };
    const manager = load('runtime/worker-manager.js', {
        '../services/scheduler': { createScheduler: () => scheduler },
        '@qq-farm-bot/session-contract': {},
        '../session/ipc': { accountSessionKey: account => account.id },
        '../config/runtime-paths': {},
    }, { process: { env: {} } }).createWorkerManager({
        WorkerThread: Child, processRef: { env: {} }, workerScriptPath: 'worker.js', workers: {},
        globalLogs: [], log() {}, addAccountLog() {}, buildConfigSnapshotForAccount: () => ({}),
    });
    const account = { id: '1', platform: 'wx' };
    assert.equal(manager.startWorker(account), true);
    let finished = false;
    const restarting = manager.restartWorker(account).then(result => { finished = true; return result; });
    assert.equal(await manager.restartWorker(account), false);
    assert.equal(finished, false);
    assert.equal(children.length, 1);
    failStart = true;
    children[0].emit('exit', 0, null);
    assert.equal(await restarting, false);
});
