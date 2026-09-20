const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const test = require('node:test');

// Exercise the compiled app's real retry path without starting a Homey runtime.
const filename = path.resolve(__dirname, '../.homeybuild/app.js');
const localRequire = createRequire(filename);
const moduleStub = { exports: {} };
vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
  exports: moduleStub.exports,
  module: moduleStub,
  require: name => name === 'homey' ? { App: class { error() {} } } : localRequire(name),
  console: { log() {}, error() {} },
  Buffer, Map, Date, Error,
}, { filename });
const App = moduleStub.exports.default || moduleStub.exports;

test('failed retries warn once, preserve cached readings, and recover on a successful read', async () => {
  const app = new App();
  let attempts = 0;
  let warnings = [];
  let clears = 0;
  const device = {
    id: 'test-sensor',
    getName: () => 'Test sensor',
    getSetting: () => 'test',
    setWarning: async message => warnings.push(message),
    unsetWarning: async () => { clears++; },
    setSettings: () => assert.fail('failure must not advance last_updated'),
    setCapabilityValue: () => assert.fail('failure must not rewrite cached readings'),
  };
  app.handleUpdateSequence = async () => {
    attempts++;
    throw new Error('Peripheral Not Found: test-sensor');
  };
  await assert.rejects(app.updateDevice(device), /Max retries \(3\) exceeded: Peripheral Not Found/);
  assert.equal(attempts, 3);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /readings may be stale/);
  assert.equal(clears, 0);
  app.handleUpdateSequence = async () => device;
  assert.equal(await app.updateDevice(device), device);
  assert.equal(clears, 1);
});

test('warning storage failure does not replace the actual BLE failure or add retries', async () => {
  const app = new App();
  let attempts = 0;
  app.handleUpdateSequence = async () => { attempts++; throw new Error('Peripheral Not Found'); };
  const device = {
    id: 'test-sensor', getName: () => 'Test sensor', getSetting: () => 'test',
    setWarning: async () => { throw new Error('Warning storage failed'); },
  };
  await assert.rejects(app.updateDevice(device), /Max retries \(3\) exceeded: Peripheral Not Found/);
  assert.equal(attempts, 3);
});
