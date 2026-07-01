# Device Integrations & Onboarding

Thermocombobulator's goal for onboarding: **let people add whatever devices they have** by picking a
device *type* and signing in — instead of hand-writing generic HTTP/command adapters. This doc records
the SDK research behind the native adapters and the onboarding design.

## Native adapters (shipping)

### Mysa — `mysa` adapter → [`mysa-js-sdk`](https://github.com/bourquep/mysa-js-sdk)
- **Language/pkg:** TypeScript, `npm i mysa-js-sdk` (optional dependency).
- **Transport:** Cloud only. AWS Cognito auth + AWS IoT MQTT (realtime) + REST. No local control
  (devices use certificate pinning, so de-clouding isn't practical).
- **Client:** `MysaApiClient` — `login(email, password)` (session cached ~1 month), `getDevices()`,
  `setDeviceState(deviceId, temperatureC, 'heat'|'off')`, `startRealtimeUpdates(deviceId)`,
  `emitter.on('statusChanged', …)` (temperature / humidity / setPoint).
- **Caveat:** undocumented/unofficial API (reverse-engineered from the app; based on @dlenski's
  [`mysotherm`](https://github.com/dlenski/mysotherm)). May break without notice.
- **Durable alternative:** newer Mysa models support **Matter** (multi-admin — Apple Home + Google +
  Alexa simultaneously). Where available, adding via Matter to HomeKit/SmartThings is the stable path,
  and Thermocombobulator can then drive it through the `smartthings` adapter.

### Midea — `midea` adapter → [`node-mideahvac`](https://github.com/reneklootwijk/node-mideahvac)
- **Language/pkg:** Node.js, `npm i node-mideahvac` (optional dependency).
- **Transport:** **Local LAN** via the SK103 WiFi module (firmware 3.0.8+), or a TCP-serial bridge.
- **Credentials:** `deviceId` + `token` + `key`, obtained **once** via the bundled `midea-discover`
  CLI using an **MSmartHome** account (legacy Midea Air / NetHome Plus accounts no longer return
  token/key). After capture, control is fully local.
- **API:** `createAppliance({communicationMethod:'sk103', host, id, token, key})` →
  `initialize()`, `getStatus()` (power, indoorTemperature, humidity, mode, fan, errors),
  `setStatus({ powerOn, temperatureSetpoint, mode, fanSpeed })`, `getCapabilities()`.
- **Caveat:** Midea is sunsetting the v1 cloud token API for a v2 control API; discovery may change,
  though captured token/key keep working locally.
- **Other libs (reference):** Python `msmart-ng`, `midea-beautiful-air`; HA `midea_ac_lan`.

## Onboarding design (the vision)

Adding a device should be: **pick the brand → sign in → pick which unit → assign it to a zone role.**

1. **Device-type picker** in the Homebridge UI: `Mysa`, `Midea`, `SmartThings`, `HTTP`, `Command`
   (more brands over time). Each type knows its own credential + discovery flow.
2. **Discovery step** per type:
   - *Mysa:* `login(email,password)` → `getDevices()` → list thermostats → user picks one → store
     `deviceId` (+ cached session, not the raw password where possible).
   - *Midea:* run discovery with the MSmartHome account → list A/Cs with `host`/`deviceId`/`token`/`key`
     → user picks → store them.
   - *SmartThings:* list devices via the platform token → pick by `deviceId` + capability.
3. **Role assignment:** the chosen device is dropped into a zone role (`heat`, `cool`, `fan`,
   `humidify`, `dehumidify`) — the same zone model the engine already uses.

The adapter layer already abstracts read/actuate, so **adding a new brand = one new adapter class +
one discovery flow.** Optional-dependency + lazy-load keeps the core plugin light: users only install
the SDK for hardware they own.

### Adapter authoring checklist (for contributors)
- Implement `Adapter`: `setOn(bool)`, optional `setTargetTemperature(°C)`, `read(): number`.
- Lazy-`require` the vendor SDK inside the adapter; throw a friendly "run npm install X" if missing.
- Memoise expensive clients/sessions (see the Mysa/Midea shared-client maps).
- Add the type to `AdapterType`, the `makeAdapter` switch, `config.schema.json`, and this doc.
