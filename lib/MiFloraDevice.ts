import Homey, { Device } from 'homey';
import { ThresholdMap } from '../types/MeasureCapabilityMap';
import HomeyMiFloraApp from '../app';
import MiFloraDriver from './MiFloraDriver';
import { CombinedCapabilities } from '../types/Capabilities';

/**
 * Where a sensor value came from: a direct connected read, or a passively
 * received BLE advertisement.
 */
export type ValueSource = 'connected' | 'advertised';

/**
 * Probe readings where a 0 needs checking before it replaces a non-zero value,
 * each paired with the reading that shows whether the probe was in contact.
 * measure_humidity mirrors measure_moisture, so it's covered too.
 */
const PROBE_PARTNER: Record<string, string> = {
  measure_moisture: 'measure_nutrition',
  measure_nutrition: 'measure_moisture',
};

/** Consecutive 0 readings needed before a plausible 0 is believed. */
const ZERO_CONFIRMATIONS = 3;

/** How recent the partner reading must be to count as the same moment. */
const PROBE_FAULT_WINDOW_MS = 60 * 60_000;

/**
 * Longest a probe fault may hide a 0. After this the 0 is shown, so a probe
 * that has really been pulled out doesn't show a stale value forever.
 */
const PROBE_FAULT_MAX_HOLD_MS = 24 * 3_600_000;

export default class MiFloraDevice extends Homey.Device {
  private _id: string = '';
  private _retry: number = 0;

  /**
   * on init the device
   */
  async onInit() {
    const settings = this.getSettings();
    const version = settings['app_version'];

    if (!version) {
      if (!this.hasCapability('measure_moisture')) {
        await this.addCapability('measure_moisture');
        const min = settings['flora_measure_moisture_min'];
        const max = settings['flora_measure_moisture_max'];
        await this.setSettings({
          measure_moisture_min: min,
          measure_moisture_max: max,
        });
      }
      if (!this.hasCapability('measure_nutrition')) {
        await this.addCapability('measure_nutrition');
        const min = settings['flora_measure_fertility_min'];
        const max = settings['flora_measure_fertility_max'];
        await this.setSettings({
          measure_nutrition_min: min,
          measure_nutrition_max: max,
        });
      }

      if (this.hasCapability('flora_measure_moisture')) {
        await this.removeCapability('flora_measure_moisture');
      }
      if (this.hasCapability('flora_measure_fertility')) {
        await this.removeCapability('flora_measure_fertility');
      }

      await this.setSettings({ app_version: '4.0.0' });
    }

    this._id = await this.getDeviceData('id');

    const defaultSettings: ThresholdMap = {
      measure_temperature: {
        min: 10,
        max: 30,
      },
      measure_luminance: {
        min: 500,
        max: 2000,
      },
      measure_nutrition: {
        min: 350,
        max: 1500,
      },
      measure_moisture: {
        min: 15,
        max: 30,
      },
      measure_battery: {
        min: 20,
        max: 100,
      },
    };

    const app = this.getApp();
    if (app && app.thresholdMapping) {
      for (const capability in app.thresholdMapping) {
        if (app.thresholdMapping.hasOwnProperty(capability) && defaultSettings.hasOwnProperty(capability)) {
          const capabilityAlias = capability as keyof ThresholdMap;
          const mapping = app.thresholdMapping[capabilityAlias];
          const defaults = defaultSettings[capabilityAlias];
          if (this.getSetting(mapping.min) === '0') {
            await this.setSettings({
              [mapping.min]: defaults.min,
            });
          }
          if (this.getSetting(mapping.max) === '0') {
            await this.setSettings({
              [mapping.max]: defaults.max,
            });
          }
        }
      }
    }

    app.registerDevice(this);

    if (this.getDriver().getSupportedCapabilities().includes('alarm_temperature') && !this.hasCapability('alarm_temperature')) {
      await this.addCapability('alarm_temperature');
    }
    if (this.getDriver().getSupportedCapabilities().includes('alarm_luminance') && !this.hasCapability('alarm_luminance')) {
      await this.addCapability('alarm_luminance');
    }
    if (this.getDriver().getSupportedCapabilities().includes('alarm_nutrition') && !this.hasCapability('alarm_nutrition')) {
      await this.addCapability('alarm_nutrition');
    }
    if (this.getDriver().getSupportedCapabilities().includes('alarm_moisture') && !this.hasCapability('alarm_moisture')) {
      await this.addCapability('alarm_moisture');
    }

    // Apple Home bridges recognise Homey's standard humidity capability, while
    // `measure_moisture` remains the correct plant/soil measurement for Homey
    // Flows. Mirror the value instead of replacing the existing capability.
    if (this.getDriver().getSupportedCapabilities().includes('measure_humidity') && !this.hasCapability('measure_humidity')) {
      await this.addCapability('measure_humidity');
      const moisture = this.getCapabilityValue('measure_moisture');
      if (typeof moisture === 'number') {
        await this.setCapabilityValue('measure_humidity', moisture);
      }
    }

    await super.onInit();
  }

  /**
   * Timestamp of the last successful connected read, per capability.
   */
  private _lastConnectedUpdate: Map<string, number> = new Map();

  /**
   * Timestamp of the last value written from any source.
   */
  private _lastValueUpdate: number = 0;

  /**
   * Consecutive 0 readings seen per capability while a non-zero value is shown.
   */
  private _zeroStreak: Map<string, number> = new Map();

  /**
   * Latest value the sensor reported per probe capability, whether or not it
   * was shown, used to tell a probe fault from a real reading.
   */
  private _rawProbe: Map<string, { value: number; at: number }> = new Map();

  /** When the current probe fault began, or null when the probe is reading. */
  private _probeFaultSince: number | null = null;

  /**
   * True when some reading arrived recently, whether by connecting or by
   * broadcast. A failed connection only means the readings are stale if
   * nothing else has reported in the meantime.
   */
  hasRecentReading(): boolean {
    if (this._lastValueUpdate === 0) {
      return false;
    }

    const minutes = Number(this.homey.settings.get('updateInterval')) || 15;
    return (Date.now() - this._lastValueUpdate) < (minutes * 2 * 60 * 1000);
  }

  /**
   * True when a connected read set this capability recently enough that an
   * advertised value should not replace it. The window is two polling
   * intervals, so a single missed poll still lets advertised data through.
   */
  private hasFreshConnectedValue(capability: string): boolean {
    const last = this._lastConnectedUpdate.get(capability);
    if (last === undefined) {
      return false;
    }

    const minutes = Number(this.homey.settings.get('updateInterval')) || 15;
    return (Date.now() - last) < (minutes * 2 * 60 * 1000);
  }

  /**
   * update the detected sensor values and emit the triggers
   */
  async updateCapabilityValue(capability: string, value: number | string, source: ValueSource = 'connected'): Promise<boolean> {
    // A connected read talks to the sensor directly and is authoritative. The
    // advertised broadcast only carries one measurement per frame and can
    // disagree with the connected read on some units, so it must not overwrite
    // a fresh connected value — otherwise the two sources flap against each
    // other. Advertised data still fills the gap for sensors that are in range
    // to broadcast but too weak or intermittent to connect.
    if (source === 'advertised' && this.hasFreshConnectedValue(capability)) {
      return false;
    }

    // A 0 from the soil probe is not always a reading. Marble Green Pothos's
    // RoPot drops from ~70% straight to moisture 0 AND conductivity 0, sometimes
    // for hours: the probe isn't reading the soil. Soil that really dries out
    // declines gradually and keeps some conductivity (Jade Jewel read 0% at
    // 197 µS/cm). So:
    //   - moisture 0 with conductivity 0 (or the reverse) is a probe fault: keep
    //     the last good value, for up to PROBE_FAULT_MAX_HOLD_MS;
    //   - any other 0 must repeat ZERO_CONFIRMATIONS times in a row first.
    // Held-back readings change nothing: not the value, the mirrored humidity,
    // the alarms or the Flow triggers. This runs before the reading is marked
    // fresh, so a held-back 0 can't block the good broadcasts that follow.
    const partner = PROBE_PARTNER[capability];
    if (partner && typeof value === 'number') {
      const now = Date.now();
      this._rawProbe.set(capability, { value, at: now });
      const current = this.getCapabilityValue(capability);

      if (value === 0 && typeof current === 'number' && current > 0) {
        const other = this._rawProbe.get(partner);
        const probeFault = other !== undefined && other.value === 0 && now - other.at < PROBE_FAULT_WINDOW_MS;
        if (probeFault) {
          this._probeFaultSince ??= now;
          if (now - this._probeFaultSince < PROBE_FAULT_MAX_HOLD_MS) {
            this.log(`${ capability } read 0 with ${ partner } also 0: probe not reading soil; keeping ${ current }`);
            return false;
          }
        } else {
          const streak = (this._zeroStreak.get(capability) ?? 0) + 1;
          this._zeroStreak.set(capability, streak);
          if (streak < ZERO_CONFIRMATIONS) {
            this.log(`${ capability } read 0 (${ streak }/${ ZERO_CONFIRMATIONS }); keeping ${ current } until confirmed`);
            return false;
          }
        }
      }

      this._zeroStreak.delete(capability);
      if (value > 0) this._probeFaultSince = null;
    }

    if (source === 'connected') {
      this._lastConnectedUpdate.set(capability, Date.now());
    }

    this._lastValueUpdate = Date.now();

    const currentValue = this.getCapabilityValue(capability);

    this.getApp()?.globalSensorUpdated?.trigger({
      deviceName: this.getName(),
      sensor: this.homey.__(`capability.${ capability }.name`),
      report: this.homey.__(`capability.${ capability }.device_updated`, {
        value,
        plant: this.getName(),
      }),
      value: `${ value }`,
      numeric: value,
    })
      .then(() => {
        // console.log('Successful triggered flow card globalSensorUpdated global.');
      })
      .catch(error => {
        console.log('Cannot trigger flow card globalSensorUpdated global: %s.', error);
      });

    this.getApp()?.globalSensorChanged?.trigger({
      deviceName: this.getName(),
      sensor: this.homey.__(`capability.${ capability }.name`),
      report: this.homey.__(`capability.${ capability }.device_changed`, {
        value,
        plant: this.getName(),
      }),
      value: `${ value }`,
      numeric: value,
    })
      .then(() => {
        // console.log('Successful triggered flow card globalSensorChanged.');
      })
      .catch(error => {
        console.error('Cannot trigger flow card globalSensorChanged device: %s.', error);
      });

    await this._checkThresholdTrigger(capability, value);

    this.setCapabilityValue(capability, value).catch(console.error);

    // Expose soil moisture through Homey's standard humidity capability for
    // HomeKit-compatible bridges. Keep the native moisture capability intact
    // so existing Homey Flows and thresholds continue to work as-is.
    if (capability === 'measure_moisture' && this.hasCapability('measure_humidity')) {
      this.setCapabilityValue('measure_humidity', value).catch(console.error);
    }

    if (currentValue !== value) {

      this.getApp().deviceSensorUpdated?.trigger(this as Device, {
        sensor: this.homey.__(`capability.${ capability }.name`),
        report: this.homey.__(`capability.${ capability }.device_updated`, {
          value,
          plant: this.getName(),
        }),
        value: `${ value }`,
        numeric: value,
      })
        .then(() => {
          // console.log('Successful triggered flow deviceSensorUpdated sensor_changed.');
        })
        .catch(error => {
          console.error('Cannot trigger flow card deviceSensorUpdated device: %s.', error);
        });

      this.getApp().deviceSensorChanged?.trigger(this as Device, {
        sensor: this.homey.__(`capability.${ capability }.name`),
        report: this.homey.__(`capability.${ capability }.device_changed`, {
          value,
          plant: this.getName(),
        }),
        value: `${ value }`,
        numeric: value,
      })
        .then(() => {
          // console.log('Successful triggered flow card deviceSensorChanged global.');
        })
        .catch(error => {
          console.error('Cannot trigger flow card deviceSensorChanged global: %s.', error);
        });
    }

    return true;
  }

  /**
   * wrapper for make the app backwards compatible
   */
  getAddress() {
    const data = this.getData();
    if (data.uuid) {
      return data.uuid;
    }
    if (data.address) {
      return data.address;
    }
  }

  /**
   * on settings change
   */
  async onSettings({ newSettings }: {
    oldSettings: { [key: string]: boolean | string | number | undefined | null };
    newSettings: { [key: string]: boolean | string | number | undefined | null };
    changedKeys: string[];
  }): Promise<string | void> {
    for (const capability in this.getApp().thresholdMapping) {
      if (this.getApp().thresholdMapping.hasOwnProperty(capability)) {
        const capabilityAlias = capability as keyof ThresholdMap;
        const mapping = this.getApp().thresholdMapping[capabilityAlias];
        if (newSettings.hasOwnProperty(mapping.min) && newSettings.hasOwnProperty(mapping.max)) {
          const minValue = newSettings[mapping.min];
          const maxValue = newSettings[mapping.max];
          if (minValue && maxValue && minValue >= maxValue) {
            return this.homey.__('settings.error.threshold', { capability: this.homey.__(`capability.${ capability }.name`) });
          }
        }
      }
    }

    return;
  }

  /**
   * emit the registered triggers
   */
  async _checkThresholdTrigger(capability: string, value: string | number) {
    const capabilityAlias = capability as CombinedCapabilities;
    const minValue = this.getSetting(this.getApp().thresholdMapping[capabilityAlias].min);
    const maxValue = this.getSetting(this.getApp().thresholdMapping[capabilityAlias].max);

    let hasError = false;

    if (!value || !minValue || !maxValue) {
      return;
    }

    if (value < minValue) {
      hasError = true;

      const report = this.homey.__(`capability.${ capability }.threshold.min`, {
        value,
        min: minValue,
        plant: this.getName(),
      });

      this.getApp()?.globalSensorOutsideThreshold?.trigger({
        deviceName: this.getName(),
        sensor: this.homey.__(`capability.${ capability }.name`),
        report,
        value: `${ value }`,
        numeric: value,
      })
        .then(() => {
          // console.log('Successful triggered flow card globalSensorOutsideThreshold.');
        })
        .catch(error => {
          console.error('Cannot trigger flow card globalSensorOutsideThreshold: %s.', error);
        });

      this.getApp().deviceSensorOutsideThreshold?.trigger(this, {
        sensor: this.homey.__(`capability.${ capability }.name`),
        report,
        value: `${ value }`,
        numeric: value,
      })
        .then(() => {
          // console.log('Successful triggered flow card deviceSensorOutsideThreshold.');
        })
        .catch(error => {
          console.error('Cannot trigger flow card deviceSensorOutsideThreshold: %s.', error);
        });

      this.getApp()?.globalSensorThresholdMinExceeds?.trigger({
        deviceName: this.getName(),
        sensor: this.homey.__(`capability.${ capability }.name`),
        report,
        value: `${ value }`,
        numeric: value,
      })
        .then(() => {
          // console.log('Successful triggered flow card globalSensorThresholdMinExceeds.');
        })
        .catch(error => {
          console.error('Cannot trigger flow card globalSensorThresholdMinExceeds: %s.', error);
        });

      this.getApp().deviceSensorThresholdMinExceeds?.trigger(this, {
        sensor: this.homey.__(`capability.${ capability }.name`),
        report,
        value: `${ value }`,
        numeric: value,
      })
        .then(() => {
          // console.log('Successful triggered flow card deviceSensorThresholdMinExceeds.');
        })
        .catch(error => {
          console.error('Cannot trigger flow card deviceSensorThresholdMinExceeds: %s.', error);
        });
    }
    if (value > maxValue) {
      hasError = true;

      const report = this.homey.__(`capability.${ capability }.threshold.max`, {
        value,
        max: maxValue,
        plant: this.getName(),
      });

      this.getApp()?.globalSensorOutsideThreshold?.trigger({
        deviceName: this.getName(),
        report,
        sensor: this.homey.__(`capability.${ capability }.name`),
        value: `${ value }`,
        numeric: value,
      })
        .then(() => {
          // console.log('Successful triggered flow card globalSensorOutsideThreshold.');
        })
        .catch(error => {
          console.error('Cannot trigger flow card globalSensorOutsideThreshold: %s.', error);
        });

      this.getApp().deviceSensorOutsideThreshold?.trigger(this, {
        sensor: this.homey.__(`capability.${ capability }.name`),
        report,
        value: `${ value }`,
        numeric: value,
      })
        .then(() => {
          // console.log('Successful triggered flow card deviceSensorOutsideThreshold.');
        })
        .catch(error => {
          console.error('Cannot trigger flow card deviceSensorOutsideThreshold: %s.', error);
        });

      this.getApp()?.globalSensorThresholdMaxExceeds?.trigger({
        deviceName: this.getName(),
        sensor: this.homey.__(`capability.${ capability }.name`),
        report,
        value: `${ value }`,
        numeric: value,
      })
        .then(() => {
          // console.log('Successful triggered flow card globalSensorThresholdMaxExceeds.');
        })
        .catch(error => {
          console.error('Cannot trigger flow card globalSensorThresholdMaxExceeds: %s.', error);
        });

      this.getApp().deviceSensorThresholdMaxExceeds?.trigger(this, {
        sensor: this.homey.__(`capability.${ capability }.name`),
        report,
        value: `${ value }`,
        numeric: value,
      })
        .then(() => {
          // console.log('Successful triggered flow card deviceSensorThresholdMaxExceeds.');
        })
        .catch(error => {
          console.error('Cannot trigger flow card deviceSensorThresholdMaxExceeds: %s.', error);
        });
    }

    if (this.hasCapability(capability.replace('measure_', 'alarm_'))) {
      await this.setCapabilityValue(capability.replace('measure_', 'alarm_'), hasError);
    }
  }

  /**
   * Update the device on add
   */
  async onAdded() {
    this.getApp().registerDevice(this);

    try {
      await this.getApp().updateDevice(this);
    } catch (error) {
      console.log(error);
    }
  }

  /**
   * Unregister device
   */
  onDeleted() {
    this.getApp().unregisterDevice(this);
  }

  async getDeviceData(property: string): Promise<any> {
    const deviceData = await this.getData();
    if (Object.prototype.hasOwnProperty.call(deviceData, property)) {
      return deviceData[property];
    }
  }

  get id(): string {
    return this._id;
  }

  get retry(): number {
    return this._retry;
  }

  set retry(value: number) {
    this._retry = value;
  }

  getApp(): HomeyMiFloraApp {
    return this.homey.app as HomeyMiFloraApp;
  }

  getDriver(): MiFloraDriver {
    return this.driver as MiFloraDriver;
  }
}

module.exports = MiFloraDevice;
