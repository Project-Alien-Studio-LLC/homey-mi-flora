# ALI-182: intermittent Bridge Bluetooth discovery

Status: unresolved. Disruptive automatic recovery was removed; Bluetooth reads
recovered temporarily after a Homey software restart and subsequently failed again.

## Environment

- Homey Pro mini, Homey 13.5.0; configured update channel: beta.
- Homey Bridge firmware build 106, connected to Homey.
- Mi Flora app 4.5.0, five paired sensors, 15-minute polling interval.
- No newer update was offered by Homey's update API during this investigation.

## Reproduction and evidence

All times below are UTC on September 20, 2026.

1. A prior scan at approximately 13:15 returned 117 BLE advertisements, with
   successful plant reads. By 13:27, discovery returned zero advertisements and
   sensor reads failed with `Peripheral Not Found`.
2. Outlet Insights confirmed that HomeyScript switched the Bridge power off at
   13:24:00.345 and back on at 13:24:20.535. This preceded that failure, but is
   insufficient to establish the underlying cause.
3. Restarting Mi Flora did not restore discovery. Discovery also returned zero
   while Mi Flora was temporarily disabled; the app was then re-enabled.
4. One Homey software restart at approximately 14:45 restored discovery:
   subsequent scans returned 125 and 137 advertisements. Four sensors produced
   actual new readings between 14:48 and 14:50, including the sensor whose prior
   reading was from September 16. The fifth sensor's bounded reads still failed.
5. At 15:49, discovery was empty again and all five devices carried failed-read
   warnings. Outlet history showed no further power cycle after 13:24. Therefore
   automatic power cycling is not a complete explanation of the recurring fault.

## Mitigation deployed

The existing Advanced Flow contained two branches: a five-minute offline alert
and a two-minute action that could power-cycle the Bridge from its availability
flag. The latter card now runs `tools/bridge-watchdog-observe.cjs`, which only
reads the Bridge and reports its state. The existing offline-alert branch remains.

The live Flow and every card ID, trigger, connection and enabled state were
preserved. Only the former power-cycle card's source changed. A full local backup
of the original Advanced Flow was saved before deployment. The older local Flow
template was also updated to prevent accidental reintroduction of power cycling.

Validation: four regression tests cover available, unavailable, unknown, and
failed-read states without actuator access. The live card ran successfully, and
its saved source matched the intended replacement exactly. All 184 device
contracts and all 21 standard Flows matched their pre-change hashes; all 98
Advanced Flows remain present, with only the intended card changed.

The Device Watchdog's 24-hour stale list was empty following the temporary
recovery. This is not a passing BLE acceptance test: the fresh failed-read warnings
and empty BLE discovery demonstrate that the failure returned within that window.

## Remaining acceptance and support request

This remains open until all five devices produce new readings and complete a
subsequent automatic polling cycle without another shared discovery failure.

For Athom support: please investigate the Homey BLE manager / Bridge discovery
path on Homey 13.5.0 with Bridge build 106. It reports BLE available and Bridge
connected while DISCOVER followed by REFRESH returns zero advertisements. The
behavior persists with the Mi Flora app stopped. A Homey software restart restores
many advertisements and successful reads temporarily, but the fault returns
without another Bridge power cycle. No device re-pairing or factory reset has
been performed. Can diagnostic logging identify the stalled scan state, and is a
firmware fix or Bridge hardware check required?

Submitted through the signed-in Homey Pro mini support form on September 20 at
17:15 UTC, with the user's approval for the report and automatically included
Homey diagnostics. Homey displayed “Thanks for your message! Your e-mail
confirmation is on its way.” No case number was displayed at submission.

## Follow-up evidence, September 21–22

Times are local (EDT).

1. **The HomeKit Controller app (`com.verbem.Hhomekiy`) accelerates the stall.** With
   it stopped, discovery returned 94–131 advertisements for over 3 hours. After it
   was re-enabled, discovery degraded within about 20 minutes and returned zero by
   about 50 minutes. Stopping it again, with no reboot, restored 117–133
   advertisements within 2.5 minutes. It has since been uninstalled.
2. **The stall recurs without it.** After a user-initiated Homey restart at 10:50 on
   September 22 (Homey 13.5.1-rc.5, updated overnight by OTA), BLE plant readings
   continued until about 16:41 and then stopped. At 19:30, DISCOVER took 16–20 s
   and returned zero advertisements. The Bridge was available.
3. **No remaining app holds the stall.** Each of the three apps with BLE permission
   (SwitchBot, Govee, Mi Flora) was stopped for about 4 minutes, one at a time, with
   discovery checked every 45–55 s. Discovery stayed at zero throughout, and each
   app was re-enabled afterwards. Unlike HomeKit Controller, removing any one of
   them does not release the stall.
4. **Memory pressure is high and rising.** With 956 MB total, free memory was
   80–140 MB and swap grew from 632 MB (September 21) to 736 MB (September 22).
   This is recorded as context only. Freeing about 110 MB by stopping apps did not
   restore BLE on September 21, so memory has not been shown to cause the stall.

Three of the five plant sensors were replaced with Zigbee sensors on September 21
and are unaffected. The two remaining BLE sensors are Calathea and Marble Green
Pothos.

For Athom: the stall now appears to be time-dependent within a single boot (about
6 hours on 13.5.1-rc.5), and it is not tied to any one app. HomeKit Controller
made it much faster, which may point to a resource that BLE clients exhaust but
never release.
