const assert = require('node:assert/strict');
const test = require('node:test');
const protobuf = require('protobufjs');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const network = require('../dist/utils/network');
const { loadProto, types } = require('../dist/utils/proto');

test('maple market reports offer and daily flags from the activity response', async t => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'farm-maple-market-'));
    const originalDataDir = process.env.FARM_DATA_DIR;
    process.env.FARM_DATA_DIR = dataDir;
    t.after(() => {
        if (originalDataDir === undefined) delete process.env.FARM_DATA_DIR;
        else process.env.FARM_DATA_DIR = originalDataDir;
        rmSync(dataDir, { recursive: true, force: true });
    });
    await loadProto();
    const activityType = types.GetGroupReply.root.lookupType('gamepb.activitypb.ActivityContent');
    const activity = id => activityType.encode({ activity_id: id }).finish();
    function reply(state) {
        const child = protobuf.Writer.create().uint32(10).bytes(activity('2026111708'));
        if (state) child.uint32(1042).bytes(Buffer.from(state, 'hex'));
        const group = protobuf.Writer.create()
            .uint32(10).bytes(activity('2026111707'))
            .uint32(18).bytes(child.finish());
        return protobuf.Writer.create().uint32(10).bytes(group.finish()).finish();
    }

    let state;
    let coinBalance = '0';
    let redeemed = 1;
    let writes = 0;
    let shopGid = 0;
    let activeWindow = false;
    const activityWindows = require('../dist/services/activity-windows');
    const { getServerTimeSec } = require('../dist/utils/utils');
    t.mock.method(activityWindows, 'getActivityWindows', async () => {
        const now = getServerTimeSec();
        return [{ id: '2026111708', beginTime: now - 60, endTime: activeWindow ? now + 60 : now - 1 }];
    });
    t.mock.method(network, 'getUserState', () => ({ gid: shopGid }));
    t.mock.method(network, 'sendMsgAsync', async (service, method, request) => {
        assert.equal(service, 'gamepb.activitypb.ActivityService');
        if (method === 'Operate') {
            const action = types.MapleMarketActionRequest.decode(request);
            if (Number(action.operate_type) === 92) {
                assert.equal(Number(action.shop_quote.shop_gid), shopGid);
                return { body: types.MapleMarketActionReply.encode({
                    activity_id: '2026111708', operate_type: 92,
                    shop_quote: { quote: { remaining_quota: 8000 } },
                }).finish() };
            }
            if (Number(action.operate_type) === 95) {
                assert.ok(action.purchase_records);
                return { body: types.MapleMarketActionReply.encode({
                    activity_id: '2026111708', operate_type: 95,
                    purchase_records: { entries: [{ timestamp: 1795824000, name: '种植好友', count: 7, total: 600, commission: 60 }] },
                }).finish() };
            }
            if (Number(action.operate_type) === 91) {
                assert.ok(action.claim_seeds);
                writes++;
                state = '0a0208012851';
                return { body: types.MapleMarketActionReply.encode({
                    activity_id: '2026111708', operate_type: 91,
                    seed_reward: { grant: { item_id: 20307, count: 31 } },
                }).finish() };
            }
            if (Number(action.operate_type) === 98) {
                assert.ok(action.share);
                writes++;
                state = '0a040801100128513042';
                return { body: types.MapleMarketActionReply.encode({
                    activity_id: '2026111708', operate_type: 98,
                    share_reward: { grant: { item_id: 20307, count: 5 } },
                }).finish() };
            }
            if (Number(action.operate_type) === 96) {
                assert.equal(Number(action.exchange.index), 10);
                assert.equal(Number(action.exchange.count), 2);
                writes++;
                redeemed += 2;
                return { body: types.MapleMarketActionReply.encode({
                    activity_id: '2026111708', operate_type: 96,
                    exchange: { grant: { item_id: 80001, count: 2 }, coin_balance: '108780' },
                }).finish() };
            }
            assert.equal(Buffer.from(request).toString('hex'), '08dc8590c6071061aa0c00');
            return { body: types.MapleMarketCatalogReply.encode({
                activity_id: '2026111708',
                operate_type: 97,
                catalog: { coin_balance: coinBalance, goods: [
                    { index: 5, price: 8500, limit: 50 },
                    { index: 10, price: 7000, limit: 50, redeemed },
                ] },
            }).finish() };
        }
        assert.equal(method, 'GetGroup');
        assert.equal(String(types.GetGroupRequest.decode(request).group_id), '2026111707');
        return { body: reply(state) };
    });

    const { getMapleMarketOverview, getMapleMarketPurchaseRecords, claimMapleMarketSeeds, shareMapleMarketQuote, runMapleMarketAutoShare, exchangeMapleMarketGoods } = require('../dist/services/activity-center');
    const cases = [
        ['0a020801120022021801287238904e', { initialPrice: 114, currentPrice: 114, shareBonus: 0, seedsClaimed: true, sharedToday: false, coinBalance: '0', settlement: null }],
        ['0a040801100128723042', { initialPrice: 114, currentPrice: 180, shareBonus: 66, seedsClaimed: true, sharedToday: true, coinBalance: '0', settlement: null }],
        ['0a04080110012872', { initialPrice: 114, currentPrice: null, shareBonus: null, seedsClaimed: true, sharedToday: true, coinBalance: '0', settlement: null }],
        ['0a0208011200189cbf0722021801285138904e408e02488caa03', { initialPrice: 81, currentPrice: 81, shareBonus: 0, seedsClaimed: true, sharedToday: false, coinBalance: '122780', settlement: { quantity: '270', coins: '54540' } }],
        // Preserves the verified fields from the second account after an official share.
        ['0a0408011001189cbf0728513042408e02488caa03', { initialPrice: 81, currentPrice: 147, shareBonus: 66, seedsClaimed: true, sharedToday: true, coinBalance: '122780', settlement: { quantity: '270', coins: '54540' } }],
        [undefined, { initialPrice: null, currentPrice: null, shareBonus: null, seedsClaimed: null, sharedToday: null, coinBalance: null, settlement: null }],
    ];
    for (const [wireState, expected] of cases) {
        state = wireState;
        const catalog = state ? { coinBalance: '0', goods: [
            { index: 5, price: 8500, limit: 50, redeemed: 0, remaining: 50 },
            { index: 10, price: 7000, limit: 50, redeemed: 1, remaining: 49 },
        ] } : null;
        assert.deepEqual(await getMapleMarketOverview(), { rules: null, ...expected, claimedSeedCount: null, shareSeedCount: null, catalog, remainingPurchaseQuota: null });
    }

    await assert.rejects(exchangeMapleMarketGoods(10, 7000, 49), { code: 'MAPLE_MARKET_BALANCE_LOW' });
    coinBalance = '122780';
    await assert.rejects(exchangeMapleMarketGoods(10, 7000, 49, 2.5), { code: 'INVALID_EXCHANGE_COUNT' });
    await assert.rejects(exchangeMapleMarketGoods(10, 7000, 49, 50), { code: 'MAPLE_MARKET_EXCHANGE_LIMIT' });
    await assert.rejects(exchangeMapleMarketGoods(10, 7000, 49, 18), { code: 'MAPLE_MARKET_BALANCE_LOW' });
    const exchangeResults = await Promise.allSettled([
        exchangeMapleMarketGoods(10, 7000, 49, 2),
        exchangeMapleMarketGoods(10, 7000, 49, 2),
    ]);
    assert.deepEqual(exchangeResults[0].value.reward, { itemId: 80001, count: 2 });
    assert.ok(exchangeResults[0].value.rewardName);
    assert.equal(exchangeResults[0].value.coinBalance, '108780');
    assert.equal(exchangeResults[1].reason.code, 'MAPLE_MARKET_OFFER_CHANGED');
    state = '0a002851';
    assert.deepEqual(await claimMapleMarketSeeds(), { reward: { itemId: 20307, count: 31 } });
    await assert.rejects(claimMapleMarketSeeds(), { code: 'MAPLE_MARKET_SEEDS_UNAVAILABLE' });
    assert.equal(await runMapleMarketAutoShare(() => false), false);
    assert.equal(await runMapleMarketAutoShare(() => true), false);
    activeWindow = true;
    state = '0a002851';
    assert.equal(await runMapleMarketAutoShare(() => true), false);
    assert.equal(writes, 2);
    state = '0a0208012851';
    assert.equal(await runMapleMarketAutoShare(() => true), true);
    assert.equal(await runMapleMarketAutoShare(() => true), true);
    shopGid = 123456;
    const sharedMarket = await getMapleMarketOverview();
    assert.equal(sharedMarket.remainingPurchaseQuota, '8000');
    assert.equal(sharedMarket.currentPrice, 147);
    assert.equal(sharedMarket.claimedSeedCount, 31);
    assert.equal(sharedMarket.shareSeedCount, 5);
    const shareState = require('../dist/services/activity-center-state');
    const day = require('../dist/utils/utils').getSystemDateKey();
    const fileToken = shareState.safeAccountFileToken();
    const receipt = JSON.parse(readFileSync(path.join(dataDir, `maple-share-reward-${fileToken}.json`), 'utf8'));
    assert.deepEqual(receipt, { day, count: 5 });
    assert.equal(shareState.loadMapleReward('share', day), 5);
    assert.equal(shareState.loadMapleReward('claim', day), 31);
    assert.equal(shareState.loadMapleReward('share', '2000-01-01'), null);
    assert.equal(shareState.loadMapleReward('claim', day, 'other-account'), null);
    await assert.rejects(shareMapleMarketQuote(), { code: 'MAPLE_MARKET_SHARE_UNAVAILABLE' });
    assert.deepEqual(await getMapleMarketPurchaseRecords(), [
        { timestamp: 1795824000, name: '种植好友', quantity: '7', total: '600', commission: '60' },
    ]);
    assert.equal(writes, 3);
});
