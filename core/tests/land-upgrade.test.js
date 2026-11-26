const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const protobuf = require('protobufjs');
const { buildLandUpgradeDetail } = require('../dist/services/farm/land-upgrade');

test('land 21 keeps the exact server level and currency conditions and compares gold to crystal bonuses', () => {
    const info = buildLandUpgradeDetail({ id: 21, unlocked: true, level: 4, max_level: 5,
        buff: { plant_yield_bonus: 30000, planting_time_reduction: 2000, plant_exp_bonus: 2000 },
        upgrade_condition: { preceeding_lands_count_need: 1, level_need: 150,
            items_need: [{ id: 1001, count: '450000000' }, { id: 1005, count: '18670' }] } },
        new Map([[21, { unlocked: true, level: 4 }]]));
    assert.equal(info.needLevel, 150);
    assert.deepEqual(info.costs.map(c => [c.id, c.count]), [['1001', '450000000'], ['1005', '18670']]);
    assert.equal(info.current.expBonus, 20);
    assert.equal(info.next.expBonus, 25);
    assert.equal(info.next.mutantMultiplier, 1.2);
    assert.equal(info.next.resonanceBonus, 25);
    assert.equal(info.unknown, false);
    assert.equal(info.precedingLands.met, true);
});

test('wire fields decode to the current server schema and feed the upgrade detail', () => {
    const root = new protobuf.Root().loadSync(path.join(__dirname, '../src/proto/plantpb.proto'), { keepCase: true });
    const type = root.lookupType('gamepb.plantpb.LandUpgradeCondition');
    // Synthetic wire sample: one preceding land, player level 150, item 1001 x 2.
    const condition = type.decode(Buffer.from('08011096011a0508e9071002', 'hex'));
    const info = buildLandUpgradeDetail({ id: 21, unlocked: true, level: 4, max_level: 5,
        upgrade_condition: condition }, new Map([[21, { unlocked: true, level: 4 }]]));
    assert.equal(info.needLevel, 150);
    assert.deepEqual(info.costs.map(c => [c.id, c.count]), [['1001', '2']]);
    assert.equal(info.precedingLands.required, 1);
    assert.equal(info.unknown, false);
    assert.equal(info.serverAllowed, false);
});

test('preceding land count excludes locked and lower-level plots; missing map stays unknown', () => {
    const raw = { id: 21, unlocked: true, level: 4, max_level: 5, could_upgrade: false,
        upgrade_condition: { preceeding_lands_count_need: 3, level_need: 150, items_need: [] } };
    const lands = new Map([[1, { unlocked: true, level: 4 }], [2, { unlocked: true, level: 5 }],
        [3, { unlocked: false, level: 4 }], [4, { unlocked: true, level: 3 }]]);
    const info = buildLandUpgradeDetail(raw, lands);
    assert.equal(info.precedingLands.owned, 2);
    assert.equal(info.precedingLands.met, false);
    assert.equal(info.unknown, false);
    assert.equal(info.serverAllowed, false);
    const missing = buildLandUpgradeDetail(raw);
    assert.equal(missing.precedingLands.owned, null);
    assert.equal(missing.precedingLands.met, null);
    assert.equal(missing.unknown, true);
});

test('max level does not show upgrade costs; server bonuses override static defaults', () => {
    const info = buildLandUpgradeDetail({ unlocked: true, level: 5, max_level: 5, buff: { plant_exp_bonus: 5000 } });
    assert.equal(info.mode, 'max');
    assert.equal(info.current.expBonus, 50);
    assert.equal(info.next, null);
    assert.deepEqual(info.costs, []);
});

test('unlocking shows prerequisite land and exact price instead of upgrade requirements', () => {
    const raw = { id: 8, unlocked: false, unlock_condition: { preceding_land_id: 7, need_level: 10, need_gold: 100000 } };
    const info = buildLandUpgradeDetail(raw, new Map([[7, { unlocked: true }]]));
    assert.equal(info.mode, 'unlock');
    assert.equal(info.needLevel, 10);
    assert.equal(info.prerequisite.met, true);
    assert.equal(info.costs[0].count, '100000');
    assert.equal(buildLandUpgradeDetail(raw).prerequisite.met, false);
});

test('unrecognized legacy conditions stay unknown; known official fallback does not imply upgrade permission', () => {
    const info = buildLandUpgradeDetail({ id: 21, unlocked: true, level: 4, max_level: 5,
        upgrade_condition: { condition_type: 99, condition_value: 150, required_items: [] } });
    assert.equal(info.unknown, true);
    assert.equal(info.needLevel, 0);
    assert.deepEqual(info.costs, []);
    assert.equal(info.serverAllowed, false);
    const fallback = buildLandUpgradeDetail({ id: 21, unlocked: true, level: 4, max_level: 5 });
    assert.equal(fallback.needLevel, 150);
    assert.equal(fallback.serverAllowed, false);
    assert.equal(fallback.costs[1].count, '18670');
});
