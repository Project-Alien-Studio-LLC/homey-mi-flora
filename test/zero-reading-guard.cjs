const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

// Exercise the compiled device class itself, with only the Homey runtime stubbed.
const filename = path.resolve(__dirname, '../.homeybuild/lib/MiFloraDevice.js');
class StubDevice {}
const moduleStub = { exports: {} };
vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
  exports: moduleStub.exports,
  module: moduleStub,
  require: name => {
    if (name === 'homey') return { __esModule: true, default: { Device: StubDevice } };
    throw new Error(`unexpected require: ${ name }`);
  },
  console: { log() {}, error() {} },
  Date, Map, Set, Number, Promise,
}, { filename });
// The compiled module ends with `module.exports = MiFloraDevice`.
const MiFloraDevice = moduleStub.exports.default ?? moduleStub.exports;

// A device showing `initial` moisture, recording every capability write.
function makeDevice(initial) {
  const device = new MiFloraDevice();
  const values = { measure_moisture: initial, measure_humidity: initial };
  const writes = [];
  Object.assign(device, {
    homey: { __: key => key, settings: { get: () => 15 } },
    getName: () => 'Marble Green Pothos',
    getApp: () => ({}),
    getCapabilityValue: capability => values[capability],
    hasCapability: capability => capability in values,
    setCapabilityValue: async (capability, value) => { values[capability] = value; writes.push([capability, value]); },
    log() {},
    _checkThresholdTrigger: async () => {},
  });
  return { device, values, writes };
}

test('a single 0 reading keeps the last good moisture and humidity', async () => {
  const { device, values, writes } = makeDevice(69);
  assert.equal(await device.updateCapabilityValue('measure_moisture', 0, 'advertised'), false);
  assert.equal(values.measure_moisture, 69);
  assert.equal(values.measure_humidity, 69);
  assert.deepEqual(writes, []);
});

test('a glitch that recovers never shows 0', async () => {
  const { device, values } = makeDevice(69);
  await device.updateCapabilityValue('measure_moisture', 0);
  await device.updateCapabilityValue('measure_moisture', 0);
  await device.updateCapabilityValue('measure_moisture', 70);
  assert.equal(values.measure_moisture, 70);
  assert.equal(values.measure_humidity, 70);
});

test('a recovered reading resets the count, so two later 0s still are not enough', async () => {
  const { device, values } = makeDevice(69);
  await device.updateCapabilityValue('measure_moisture', 0);
  await device.updateCapabilityValue('measure_moisture', 0);
  await device.updateCapabilityValue('measure_moisture', 68);
  await device.updateCapabilityValue('measure_moisture', 0);
  await device.updateCapabilityValue('measure_moisture', 0);
  assert.equal(values.measure_moisture, 68);
});

test('three 0 readings in a row are believed, from either source', async () => {
  const { device, values } = makeDevice(69);
  assert.equal(await device.updateCapabilityValue('measure_moisture', 0, 'advertised'), false);
  assert.equal(await device.updateCapabilityValue('measure_moisture', 0, 'connected'), false);
  assert.equal(await device.updateCapabilityValue('measure_moisture', 0, 'advertised'), true);
  assert.equal(values.measure_moisture, 0);
  assert.equal(values.measure_humidity, 0);
});

test('a held-back 0 does not mark the connected value fresh or block broadcasts', async () => {
  const { device, values } = makeDevice(69);
  await device.updateCapabilityValue('measure_moisture', 0, 'connected');
  assert.equal(device.hasFreshConnectedValue('measure_moisture'), false);
  assert.equal(await device.updateCapabilityValue('measure_moisture', 66, 'advertised'), true);
  assert.equal(values.measure_moisture, 66);
});

test('0 is accepted straight away when the plant already reads 0', async () => {
  const { device, values } = makeDevice(0);
  assert.equal(await device.updateCapabilityValue('measure_moisture', 0), true);
  assert.equal(values.measure_moisture, 0);
});

test('other capabilities are not held back', async () => {
  const { device, values } = makeDevice(69);
  values.measure_temperature = 24;
  assert.equal(await device.updateCapabilityValue('measure_temperature', 0), true);
  assert.equal(values.measure_temperature, 0);
});
