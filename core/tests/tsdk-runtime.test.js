const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');

const {
    MINI_PROGRAM_APP_IDS,
    TSDK_SHA256,
    TSDK_VERSION,
    TSDK_BUILDS,
    TsdkRuntime,
    resolveTsdkHostProfile,
} = require('../dist/utils/tsdk-runtime');

const HISTORICAL_QQ = require('./fixtures/qq-host-20261101.json');
const loadHistoricalTsdk = require('./fixtures/load-historical-tsdk.cjs');
const EXPECTED_QQ_CREDENTIAL_BYTES = Buffer.from(HISTORICAL_QQ.credentialHex, 'hex');

test('TSDK selects the mini-program host profile by account platform', () => {
    assert.deepEqual(resolveTsdkHostProfile('qq'), {
        appId: MINI_PROGRAM_APP_IDS.qq,
        debugMode: 0,
        deviceText: 'windows;windows;windows 10.0;0;',
        platform: 'qq',
        userDataPath: 'qqfile://usr/',
    });
    assert.deepEqual(resolveTsdkHostProfile('wx'), {
        appId: MINI_PROGRAM_APP_IDS.wx,
        debugMode: 2,
        platform: 'wx',
    });
});

test('QQ virtual user paths stay inside the account TSDK directory', () => {
    const dataDir = path.join(os.tmpdir(), 'qq-farm-tsdk-path-test');
    const runtime = new TsdkRuntime({ dataDir, platform: 'qq' });

    assert.equal(runtime.resolveDataPath('qqfile://usr/state.bin'), path.join(dataDir, 'state.bin'));
    assert.throws(
        () => runtime.resolveDataPath('qqfile://usr/../../outside.bin'),
        /TSDK 文件路径越出账号目录/,
    );
});

test('both bundled TSDK binaries match their release manifests and load valid WASM', () => {
    assert.equal(TSDK_BUILDS.qq.version, TSDK_VERSION);
    assert.equal(TSDK_BUILDS.qq.sha256, TSDK_SHA256);
    for (const build of Object.values(TSDK_BUILDS)) {
        assert.match(build.version, /^v\d+\.\d+\.\d+\.\d+$/);
        assert.match(build.sha256, /^[a-f0-9]{64}$/);
        const bytes = fs.readFileSync(path.join(__dirname, '../src/utils', build.file));
        assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), build.sha256);
        assert.equal(WebAssembly.validate(bytes), true);
    }
});

test('current QQ host reproduces the exact credential vector with its frozen historical WASM', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-tsdk-test-'));
    const originalHttpsGet = https.get;
    let runtime;
    try {
        // Initialization seeds server time synchronously; the delayed network refresh is irrelevant to this vector.
        https.get = () => ({ on() { return this; } });
        const bytes = fs.readFileSync(path.join(__dirname, 'fixtures', HISTORICAL_QQ.file));
        assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), HISTORICAL_QQ.sha256);
        const { TsdkRuntime: HistoricalRuntime } = loadHistoricalTsdk(HISTORICAL_QQ);
        runtime = new HistoricalRuntime({
            accountId: 'credential-vector',
            dataDir: path.join(tempRoot, 'data'),
            platform: 'qq',
        });
        await runtime.init();
        runtime.bindUser('tsdk-regression-openid');

        const encoded = runtime.getEncryptedInitInfo();
        const decoded = Buffer.from(encoded, 'base64');
        assert.equal(encoded.length, 136);
        assert.deepEqual(decoded, EXPECTED_QQ_CREDENTIAL_BYTES);

        const plaintext = Buffer.from('tsdk-transform-regression');
        const encrypted = runtime.transform(plaintext, false);
        assert.notDeepEqual(encrypted, plaintext);
        assert.deepEqual(runtime.transform(encrypted, true), plaintext);
    } finally {
        runtime?.destroy();
        https.get = originalHttpsGet;
        const resolvedRoot = path.resolve(tempRoot);
        const resolvedTemp = path.resolve(os.tmpdir());
        assert.ok(resolvedRoot.startsWith(`${resolvedTemp}${path.sep}`));
        assert.ok(path.basename(resolvedRoot).startsWith('qq-farm-tsdk-test-'));
        fs.rmSync(resolvedRoot, { recursive: true, force: true });
    }
});

test('current-release QQ WASM produces canonical credentials and reversible ciphertext', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-tsdk-current-'));
    const originalGet = https.get;
    const runtime = new TsdkRuntime({dataDir:directory, platform:'qq'});
    try {
        https.get = () => ({on() { return this; }});
        await runtime.init(); runtime.bindUser('synthetic-current-qq-openid');
        const diagnostics = runtime.getDiagnostics();
        assert.equal(diagnostics.ready, true);
        assert.equal(diagnostics.version, TSDK_BUILDS.qq.version);
        assert.equal(diagnostics.wasmSha256, TSDK_BUILDS.qq.sha256);
        const credential = runtime.getEncryptedInitInfo();
        assert.ok(credential.length > 0);
        assert.equal(Buffer.from(credential, 'base64').toString('base64'), credential);
        for (const length of [1, 31, 256]) {
            const plaintext = Buffer.alloc(length, 0x51);
            const encrypted = runtime.transform(plaintext, false);
            assert.notDeepEqual(encrypted, plaintext);
            assert.deepEqual(runtime.transform(encrypted, true), plaintext);
        }
    } finally {
        runtime.destroy(); https.get = originalGet;
        assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
        assert.ok(path.basename(directory).startsWith('qq-farm-tsdk-current-'));
        fs.rmSync(directory, {recursive:true, force:true});
    }
});

test('runtime refuses corrupted QQ and WeChat WASM before initialization', async () => {
    const originalRead = fs.readFileSync;
    for (const platform of ['qq', 'wx']) {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-tsdk-corrupt-'));
        const runtime = new TsdkRuntime({dataDir:directory, platform});
        try {
            fs.readFileSync = function(filename, ...args) {
                const bytes = originalRead.call(this, filename, ...args);
                if (typeof filename === 'string' && path.basename(filename) === TSDK_BUILDS[platform].file) {
                    const corrupted = Buffer.from(bytes); corrupted[corrupted.length - 1] ^= 1;
                    return corrupted;
                }
                return bytes;
            };
            await assert.rejects(runtime.init(), /TSDK 文件校验失败/);
            assert.equal(runtime.getDiagnostics().ready, false);
        } finally {
            fs.readFileSync = originalRead; runtime.destroy();
            assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
            assert.ok(path.basename(directory).startsWith('qq-farm-tsdk-corrupt-'));
            fs.rmSync(directory, {recursive:true, force:true});
        }
    }
});

test('WeChat loads its current-release WASM and reports unsupported host calls without user data', async () => {
    const build = TSDK_BUILDS.wx;
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '../src/utils', build.file))).digest('hex'), build.sha256);
    const originalGet = https.get;
    const originalRequest = https.request;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-tsdk-wx-'));
    let runtime;
    try {
        https.get = () => ({ on() { return this; } });
        https.request = () => ({ on() { return this; }, end() {} });
        runtime = new TsdkRuntime({ dataDir, platform: 'wx' });
        await runtime.init();
        runtime.bindUser('synthetic-wx-openid');
        assert.equal(runtime.getDiagnostics().version, build.version);
        assert.equal(runtime.getDiagnostics().wasmSha256, build.sha256);
        assert.equal(path.basename(runtime.getDiagnostics().wasmPath), 'tsdk-wx.wasm');
        const plaintext = Buffer.from('synthetic-wechat-protocol-vector');
        const ciphertext = runtime.transform(plaintext);
        assert.notDeepEqual(ciphertext, plaintext);
        assert.deepEqual(runtime.transform(ciphertext, true), plaintext);
        assert.equal(runtime.createImports().a.e(), 0);
        assert.equal(runtime.getDiagnostics().unsupportedAceVmCalls, 1);
        assert.ok(runtime.getDiagnostics().lastUnsupportedAceVmAt > 0);
        assert.ok(!JSON.stringify(runtime.getDiagnostics()).includes('synthetic-wx-openid'));
        const pkgAssets = require('../package.json').pkg.assets;
        assert.ok(pkgAssets.includes('src/utils/tsdk-wx.wasm'));
        assert.match(fs.readFileSync(path.join(__dirname, '../Dockerfile'), 'utf8'), /COPY[^\n]+tsdk-wx\.wasm/);
    } finally {
        runtime?.destroy();
        https.get = originalGet;
        https.request = originalRequest;
        assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep));
        assert.ok(path.basename(dataDir).startsWith('qq-farm-tsdk-wx-'));
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});

test('long UTF-8 JavaScript stacks fit the host buffer and allow WeChat initialization', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-tsdk-long-stack-'));
    const originalPrepareStackTrace = Error.prepareStackTrace;
    const originalGet = https.get;
    const originalRequest = https.request;
    const runtime = new TsdkRuntime({ dataDir, platform: 'wx' });
    try {
        https.get = () => ({ on() { return this; } });
        https.request = () => ({ on() { return this; }, end() {} });
        const stack = '调用栈😀'.repeat(2000);
        Error.prepareStackTrace = (error, frames) => error.message === 'TSDK JavaScript 调用栈'
            ? stack
            : originalPrepareStackTrace ? originalPrepareStackTrace(error, frames) : error.toString();
        runtime.memory = new WebAssembly.Memory({ initial: 1 });
        const capture = runtime.createImports().a.c;
        const view = new Uint8Array(runtime.memory.buffer);
        for (const capacity of [1, 5, 10, 1024]) {
            view.fill(0x7F, 64, 64 + capacity + 1);
            const written = capture(64, capacity);
            assert.ok(written >= 1 && written <= capacity);
            assert.equal(view[64 + written - 1], 0);
            assert.equal(view[64 + capacity], 0x7F);
            const text = Buffer.from(view.subarray(64, 64 + written - 1)).toString('utf8');
            assert.ok(stack.startsWith(text));
            assert.ok(!text.includes('\uFFFD'));
        }
        assert.equal(capture(64, 0), 0);
        assert.equal(capture(0, 1024), 0);
        runtime.memory = null;
        await runtime.init();
        assert.equal(runtime.getDiagnostics().ready, true);
        const plaintext = Buffer.from('long-stack-wechat-login');
        assert.deepEqual(runtime.transform(runtime.transform(plaintext), true), plaintext);
    } finally {
        runtime.destroy();
        Error.prepareStackTrace = originalPrepareStackTrace;
        https.get = originalGet;
        https.request = originalRequest;
        assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep));
        assert.ok(path.basename(dataDir).startsWith('qq-farm-tsdk-long-stack-'));
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});

test('unsupported ACEVM fingerprints exact bounded bytes without executing or retaining task content', () => {
    for (const platform of ['qq', 'wx']) {
        const runtime = new TsdkRuntime({ dataDir: path.join(os.tmpdir(), 'synthetic-acevm-diagnostics'), platform });
        runtime.memory = new WebAssembly.Memory({ initial: 2 });
        const view = new Uint8Array(runtime.memory.buffer);
        const invoke = runtime.createImports().a.e;
        try {
            assert.equal(runtime.getDiagnostics().lastUnsupportedAceVmTaskHash, '');
            const tasks = [Buffer.from('{"synthetic":"甲"}'), Buffer.from('{"synthetic":"乙"}'), Buffer.from([0xFF, 0xFE])];
            assert.equal(tasks[0].length, tasks[1].length);
            const hashes = [];
            for (const task of tasks) {
                view.set(task, 64);
                view[64 + task.length] = 0;
                assert.equal(invoke(64), 0);
                const result = runtime.getDiagnostics();
                assert.equal(result.lastUnsupportedAceVmTaskHash, crypto.createHash('sha256').update(task).digest('hex'));
                assert.equal(result.lastUnsupportedAceVmTaskBytes, task.length);
                assert.equal(result.lastUnsupportedAceVmTaskReadFailed, false);
                assert.ok(!JSON.stringify(result).includes('synthetic'));
                hashes.push(result.lastUnsupportedAceVmTaskHash);
            }
            assert.notEqual(hashes[0], hashes[1]);
            assert.equal(runtime.getDiagnostics().unsupportedAceVmCalls, tasks.length);
            for (const ptr of [undefined, 0, -1, view.length, Number.NaN]) {
                assert.equal(invoke(ptr), 0);
                const result = runtime.getDiagnostics();
                assert.equal(result.lastUnsupportedAceVmTaskHash, '');
                assert.equal(result.lastUnsupportedAceVmTaskReadFailed, true);
            }
            view.fill(65, 64, 64 + 65537);
            assert.equal(invoke(64), 0);
            assert.equal(runtime.getDiagnostics().lastUnsupportedAceVmTaskReadFailed, true);
            view[64 + 65536] = 0;
            assert.equal(invoke(64), 0);
            assert.equal(runtime.getDiagnostics().lastUnsupportedAceVmTaskBytes, 65536);
            assert.equal(runtime.getDiagnostics().lastUnsupportedAceVmTaskReadFailed, false);
        } finally {
            runtime.destroy();
        }
        const next = new TsdkRuntime({ dataDir: path.join(os.tmpdir(), 'synthetic-acevm-diagnostics'), platform });
        assert.equal(next.getDiagnostics().unsupportedAceVmCalls, 0);
        assert.equal(next.getDiagnostics().lastUnsupportedAceVmTaskHash, '');
        next.destroy();
    }
});

test('compiled pkg layout resolves platform WASM assets from src', async () => {
    const vm = require('node:vm');
    const { createRequire } = require('node:module');
    const filename = path.resolve(__dirname, '../dist/utils/tsdk-runtime.js');
    const realRequire = createRequire(filename);
    const sandbox = {
        require: name => name === '../config/runtime-paths'
            ? { getResourcePath: (...parts) => path.resolve(__dirname, '../dist', ...parts) }
            : realRequire(name),
        module: { exports: {} }, exports: {}, __dirname: path.dirname(filename),
        Buffer, WebAssembly, process, console,
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
    const originalGet = https.get;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-tsdk-pkg-'));
    try {
        https.get = () => ({ on() { return this; } });
        for (const platform of ['qq', 'wx']) {
            const runtime = new sandbox.module.exports.TsdkRuntime({ dataDir, platform });
            try {
                await runtime.init();
                assert.equal(runtime.getDiagnostics().version, TSDK_BUILDS[platform].version);
                assert.equal(runtime.getDiagnostics().wasmSha256, TSDK_BUILDS[platform].sha256);
                assert.equal(path.basename(runtime.getDiagnostics().wasmPath), TSDK_BUILDS[platform].file);
            } finally { runtime.destroy(); }
        }
    } finally {
        https.get = originalGet;
        assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep));
        assert.ok(path.basename(dataDir).startsWith('qq-farm-tsdk-pkg-'));
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});
