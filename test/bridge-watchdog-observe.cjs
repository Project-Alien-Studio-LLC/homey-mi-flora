const assert = require('node:assert/strict');
const test = require('node:test');
const { observeBridge } = require('../tools/bridge-watchdog-observe.cjs');

for (const available of [true, false, undefined]) {
  test(`availability=${available} never dispatches an outlet or app command`, async () => {
    const reads = [];
    const Homey = new Proxy({
      devices: {
        getDevice: async ({ id }) => {
          reads.push(id);
          assert.equal(id, 'bridge-id', 'Only the Bridge may be read');
          return { available, setCapabilityValue: () => assert.fail('Unexpected power command') };
        },
      },
    }, { get(target, key) {
      assert.equal(key, 'devices', 'No other manager is required');
      return target[key];
    } });
    assert.deepEqual(await observeBridge({ Homey, bridgeId: 'bridge-id', log() {} }), {
      status: available === true ? 'available' : 'unavailable',
      automaticPowerCycle: false,
    });
    assert.deepEqual(reads, ['bridge-id']);
  });
}

test('a failed Bridge read stays a failure and does not claim recovery', async () => {
  await assert.rejects(observeBridge({
    Homey: { devices: { getDevice: async () => { throw new Error('API unavailable'); } } },
    bridgeId: 'bridge-id', log() {},
  }), /API unavailable/);
});
