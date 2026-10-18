export {};
import { WxReconnect } from './wx-reconnect';
const { fork } = require('node:child_process');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const store = require('../models/store');
const { updateRuntimeConfig, getRuntimeConfig, getDefaultSystemConfig } = require('../config/config');
const { sendPushooMessage } = require('../services/push');
const { createDataProvider } = require('./data-provider');
const { createReloginReminderService } = require('./relogin-reminder');
const { createRuntimeState } = require('./runtime-state');
const { createWorkerManager } = require('./worker-manager');

const OPERATION_KEYS = ['harvest', 'farming', 'fertilize', 'plant', 'steal', 'helpFarming', 'taskClaim', 'sell', 'upgrade'];

interface RuntimeEngineOptions {
    processRef?: any;
    mainEntryPath?: string;
    workerScriptPath?: string;
    runtimeMode?: string;
    onStatusSync?: (accountId: string, status: any, accountName?: string) => void;
    onLog?: (entry: any, accountId?: string, accountName?: string) => void;
    onAccountLog?: (entry: any) => void;
    startAdminServer?: (dataProvider: any) => void;
}

function createRuntimeEngine(options: RuntimeEngineOptions = {}) {
    const processRef = options.processRef || process;
    // Detect if running from source (tsx) or compiled (node)
    const isRunningFromSource = __dirname.includes(`${path.sep}src${path.sep}`);
    const fileExt = isRunningFromSource ? '.ts' : '.js';
    const mainEntryPath = options.mainEntryPath || path.join(__dirname, `../../client${fileExt}`);
    const workerScriptPath = options.workerScriptPath || path.join(__dirname, `../core/worker${fileExt}`);
    const runtimeMode = String(options.runtimeMode || processRef.env.FARM_RUNTIME_MODE || 'thread').toLowerCase();
    const onStatusSync = typeof options.onStatusSync === 'function' ? options.onStatusSync : null;
    const onLog = typeof options.onLog === 'function' ? options.onLog : null;
    const onAccountLog = typeof options.onAccountLog === 'function' ? options.onAccountLog : null;
    const startAdminServer = typeof options.startAdminServer === 'function' ? options.startAdminServer : null;

    const runtimeState = createRuntimeState({
        store,
        operationKeys: OPERATION_KEYS,
    });
    const {
        workers,
        globalLogs: GLOBAL_LOGS,
        accountLogs: ACCOUNT_LOGS,
        runtimeEvents,
        nextConfigRevision,
        buildConfigSnapshotForAccount,
        log,
        addAccountLog,
        normalizeStatusForPanel,
        buildDefaultStatus,
        filterLogs,
    } = runtimeState;

    const reloginReminder = createReloginReminderService({
        store,
        sendPushooMessage,
        log,
    });

    const {
        getOfflineAutoDeleteMs,
        triggerOfflineReminder: rawTriggerOfflineReminder,
        sendConfiguredPush,
    } = reloginReminder;

    const wxOfflineNotifications = new Map<string, { lastAt: number; pending: boolean }>();
    function triggerOfflineReminder(payload: any): void {
        const id = String(payload.accountId || '');
        const account = store.getAccounts().accounts.find((a: any) => a.id === id);
        if (account?.platform === 'wx') {
            const previous = wxOfflineNotifications.get(id);
            const now = Date.now();
            wxOfflineNotifications.set(id, { lastAt: previous?.lastAt || now, pending: true });
            if (previous && now - previous.lastAt < 10 * 60000) return;
            wxOfflineNotifications.set(id, { lastAt: now, pending: true });
        }
        void rawTriggerOfflineReminder({ ...payload, accountName: payload.accountName || account?.name || id });
    }

    let wxReconnect: WxReconnect;
    const { startWorker: rawStartWorker, stopWorker: rawStopWorker, restartWorker: rawRestartWorker, callWorkerApi } = createWorkerManager({
        fork,
        WorkerThread: Worker,
        runtimeMode,
        processRef,
        mainEntryPath,
        workerScriptPath,
        workers,
        globalLogs: GLOBAL_LOGS,
        log,
        addAccountLog,
        normalizeStatusForPanel,
        buildConfigSnapshotForAccount,
        getOfflineAutoDeleteMs,
        triggerOfflineReminder,
        sendConfiguredPush,
        addOrUpdateAccount: store.addOrUpdateAccount,
        deleteAccount: store.deleteAccount,
        onDisconnect: (id: string, details: any) => wxReconnect?.disconnected(id, details) || false,
        onOnline: (id: string) => wxReconnect?.online(id),
        onWorkerExit: (id: string) => wxReconnect?.idle(id),
        onStatusSync: (accountId: string, status: any, accountName?: string) => {
            runtimeEvents.emit('status', { accountId, status, accountName });
            if (onStatusSync) onStatusSync(accountId, status, accountName);
        },
        onWorkerLog: (entry: any, accountId: string, accountName?: string) => {
            runtimeEvents.emit('worker_log', { entry, accountId, accountName });
            if (onLog) onLog(entry, accountId, accountName);
        },
    });
    wxReconnect = new WxReconnect({
        getAccount: (id: string) => store.getAccounts().accounts.find((a: any) => a.id === id),
        hasWorker: (id: string) => !!workers[id],
        isOnline: (id: string) => !!workers[id]?.status?.connection?.connected && !workers[id]?.stopping,
        startWorker: rawStartWorker,
        saveCode: (id: string, code: string) => store.addOrUpdateAccount({ id, code }, { preserveWxAuthorization: true }),
        log: (id: string, message: string) => addAccountLog('wx_reconnect', message, id),
        notify: (id: string, reason: string) => triggerOfflineReminder({ accountId: id, reason, offlineMs: 0 }),
        recovered: (id: string) => {
            const notification = wxOfflineNotifications.get(id);
            if (!notification?.pending) return;
            notification.pending = false;
            const account = store.getAccounts().accounts.find((a: any) => a.id === id);
            void sendConfiguredPush({ title: '账号已恢复挂机', content: '微信自动重连成功，已恢复原有自动化任务。', accountId: id, accountName: account?.name || id });
        },
    });
    function startWorker(account: any): boolean { wxReconnect.resume(String(account.id)); return rawStartWorker(account); }
    function stopWorker(id: string): void { wxReconnect.cancel(id); rawStopWorker(id); }
    function restartWorker(account: any): void { wxReconnect.resume(String(account.id)); rawRestartWorker(account); }
    const dataProvider = createDataProvider({
        workers,
        globalLogs: GLOBAL_LOGS,
        accountLogs: ACCOUNT_LOGS,
        store,
        getAccounts: store.getAccounts,
        callWorkerApi,
        buildDefaultStatus,
        normalizeStatusForPanel,
        filterLogs,
        addAccountLog,
        nextConfigRevision,
        broadcastConfigToWorkers,
        buildConfigSnapshotForAccount,
        broadcastGameConfigReload,
        startWorker,
        stopWorker,
        restartWorker,
        wxReconnect,
    });

    runtimeEvents.on('log', (entry: any) => {
        if (onLog) onLog(entry, entry && entry.accountId ? entry.accountId : '', entry && entry.accountName ? entry.accountName : '');
    });
    runtimeEvents.on('account_log', (entry: any) => {
        if (onAccountLog) onAccountLog(entry);
    });

    function broadcastConfigToWorkers(targetAccountId = ''): void {
        const targetId = String(targetAccountId || '').trim();
        for (const [accId, worker] of Object.entries(workers)) {
            if (targetId && String(accId) !== targetId) continue;
            const snapshot = buildConfigSnapshotForAccount(accId);
            try {
                (worker as any).process.send({ type: 'config_sync', config: snapshot });
            } catch {
                // ignore IPC failures for exited workers
            }
        }
    }

    function broadcastGameConfigReload(): void {
        for (const worker of Object.values(workers)) {
            try {
                (worker as any).process.send({ type: 'reload_config' });
            } catch {
                // ignore IPC failures for exited workers
            }
        }
    }

    function startAllAccounts(): void {
        const accounts = (store.getAccounts().accounts || []);
        if (accounts.length > 0) {
            log('系统', `发现 ${accounts.length} 个账号，正在启动...`);
            accounts.forEach((acc: any) => startWorker(acc));
        } else {
            log('系统', '未发现账号，请访问管理面板添加账号');
        }
    }

    async function start(options: { startAdminServer?: boolean; autoStartAccounts?: boolean } = {}): Promise<void> {
        const shouldStartAdminServer = options.startAdminServer !== false;
        const shouldAutoStartAccounts = options.autoStartAccounts !== false;

        const savedSystemConfig = store.getSystemConfig();
        if (savedSystemConfig) {
            updateRuntimeConfig(savedSystemConfig);
            log('系统', `已加载系统配置: serverUrl=${savedSystemConfig.serverUrl}, clientVersion=${savedSystemConfig.clientVersion}, platform=${savedSystemConfig.platform}`);
        }

        if (shouldStartAdminServer && startAdminServer) {
            startAdminServer(dataProvider);
        }

        if (shouldAutoStartAccounts) {
            startAllAccounts();
        }
    }

    function stopAllAccounts(): void {
        wxReconnect.close();
        for (const accountId of Object.keys(workers)) {
            stopWorker(accountId);
        }
    }

    return {
        store,
        runtimeEvents,
        workers,
        dataProvider,
        start,
        startAllAccounts,
        stopAllAccounts,
        broadcastConfigToWorkers,
        broadcastGameConfigReload,
        startWorker,
        stopWorker,
        restartWorker,
        callWorkerApi,
        log,
        addAccountLog,
    };
}

module.exports = {
    createRuntimeEngine,
};
