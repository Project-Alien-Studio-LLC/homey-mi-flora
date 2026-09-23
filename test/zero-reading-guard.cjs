const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

// Exercise the compiled device class itself, with only the Homey runtime and
// the clock stubbed.
const filename = path.resolve(__dirname, '../.homeybuild/lib/MiFloraDevice.js');
const clock = { now: 1_800_000_000_000 };
class FakeDate extends Date {
  static now() { return clock.now; }
}
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
  Date: FakeDate, Map, Set, Number, Promise,
}, { filename });
// The compiled module ends with `module.exports = MiFloraDevice`.
const MiFloraDevice = moduleStub.exports.default ?? moduleStub.exports;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// A device showing `moisture` and `nutrition`, recording every capability write.
function makeDevice(moisture, nutrition = 500) {
  const device = new MiFloraDevice();
  const values = { measure_moisture: moisture, measure_humidity: moisture, measure_nutrition: nutrition };
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

// One reading as the sensor delivers it: conductivity, then moisture.
async function read(device, nutrition, moisture, source) {
  await device.updateCapabilityValue('measure_nutrition', nutrition, source);
  await device.updateCapabilityValue('measure_moisture', moisture, source);
  clock.now += 15 * MINUTE;
}

test('a single 0 reading keeps the last good moisture and humidity', async () => {
  const { device, values, writes } = makeDevice(69);
  assert.equal(await device.updateCapabilityValue('measure_moisture', 0, 'advertised'), false);
  assert.equal(values.measure_moisture, 69);
  assert.equal(values.measure_humidity, 69);
  assert.deepEqual(writes, []);
});

test('moisture 0 with conductivity 0 is a probe fault, however long it repeats', async () => {
  const { device, values } = makeDevice(70, 118);
  for (let i = 0; i < 20; i++) await read(device, 0, 0);
  assert.equal(values.measure_moisture, 70);
  assert.equal(values.measure_humidity, 70);
  assert.equal(values.measure_nutrition, 118);
});

test('the probe fault clears when the sensor reads soil again', async () => {
  const { device, values } = makeDevice(70, 118);
  await read(device, 0, 0);
  await read(device, 0, 0);
  await read(device, 120, 68);
  assert.equal(values.measure_moisture, 68);
  assert.equal(values.measure_nutrition, 120);
});

test('after 24 hours of probe fault the 0 is shown, so a pulled probe is not hidden forever', async () => {
  const { device, values } = makeDevice(70, 118);
  await read(device, 0, 0);
  clock.now += 23 * HOUR;
  await read(device, 0, 0);
  assert.equal(values.measure_moisture, 70);
  clock.now += 2 * HOUR;
  await read(device, 0, 0);
  assert.equal(values.measure_moisture, 0);
});

test('real dry soil (conductivity still present) reaches 0 after three readings', async () => {
  const { device, values } = makeDevice(1, 200);
  await read(device, 197, 0);
  await read(device, 197, 0);
  assert.equal(values.measure_moisture, 1);
  await read(device, 197, 0);
  assert.equal(values.measure_moisture, 0);
  assert.equal(values.measure_humidity, 0);
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
