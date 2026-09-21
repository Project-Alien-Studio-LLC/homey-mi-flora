'use strict';

// A connected read is authoritative: advertised broadcasts must not overwrite a
// fresh connected value, but must still fill the gap once connected reads stop
// arriving (a sensor in range to broadcast but too weak or intermittent to
// connect). Mirrors the guard in lib/MiFloraDevice.ts.
const assert = require('node:assert');

class FakeDevice {
  constructor(updateInterval = 15) {
    this.updateInterval = updateInterval;
    this.values = {};
    this._lastConnectedUpdate = new Map();
    this.now = 1_000_000;
  }

  hasFreshConnectedValue(capability) {
    const last = this._lastConnectedUpdate.get(capability);
    if (last === undefined) return false;
    return (this.now - last) < (this.updateInterval * 2 * 60 * 1000);
  }

  update(capability, value, source = 'connected') {
    if (source === 'advertised' && this.hasFreshConnectedValue(capability)) return;
    if (source === 'connected') this._lastConnectedUpdate.set(capability, this.now);
    this.values[capability] = value;
  }
}

// 1. With no connected read yet, advertised data is accepted.
let d = new FakeDevice();
d.update('measure_moisture', 48, 'advertised');
assert.strictEqual(d.values.measure_moisture, 48, 'advertised fills an empty capability');

// 2. A fresh connected read wins and is not overwritten by a conflicting
//    advertisement (the Limelight case: connected 56 vs advertised 23).
d = new FakeDevice();
d.update('measure_moisture', 56, 'connected');
d.now += 3 * 60 * 1000;
d.update('measure_moisture', 23, 'advertised');
assert.strictEqual(d.values.measure_moisture, 56, 'advertised must not overwrite a fresh connected read');

// 3. Once connected reads stop for more than two intervals, advertised data
//    takes over so the sensor does not go stale.
d.now += 30 * 60 * 1000;
d.update('measure_moisture', 23, 'advertised');
assert.strictEqual(d.values.measure_moisture, 23, 'advertised takes over once connected reads go stale');

// 4. A later connected read reclaims precedence.
d.update('measure_moisture', 57, 'connected');
d.now += 60 * 1000;
d.update('measure_moisture', 23, 'advertised');
assert.strictEqual(d.values.measure_moisture, 57, 'connected reclaims precedence');

// 5. Precedence is tracked per capability, not per device.
d = new FakeDevice();
d.update('measure_temperature', 24.6, 'connected');
d.update('measure_luminance', 130, 'advertised');
assert.strictEqual(d.values.measure_luminance, 130, 'a fresh temperature must not block luminance');

console.log('PASS: advertised values defer to fresh connected reads, and fill gaps when they stop');
