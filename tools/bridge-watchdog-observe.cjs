'use strict';

// For the former power-cycle card in an existing Homey Bridge watchdog.
// Keep its separate offline-alert branch; a cached availability flag must not
// dispatch physical power commands to a shared radio bridge.
async function observeBridge({ Homey, bridgeId, log = console.log }) {
  if (typeof bridgeId !== 'string' || !bridgeId) {
    throw new Error('A Bridge device ID is required');
  }
  const bridge = await Homey.devices.getDevice({ id: bridgeId });
  const status = bridge.available === true ? 'available' : 'unavailable';
  log(`Homey Bridge ${status}; automatic power cycling is disabled. Offline alerts remain with the existing alert watchdog.`);
  return { status, automaticPowerCycle: false };
}

if (typeof module !== 'undefined') module.exports = { observeBridge };
