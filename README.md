# Thermocombobulator

> Fuse baseboard heat, window A/C, space heaters, fans, and humidifiers into **one virtual
> central-climate zone** for HomeKit — with the interlocks a real central system would have.

[![npm](https://img.shields.io/npm/v/homebridge-thermocombobulator.svg)](https://www.npmjs.com/package/homebridge-thermocombobulator)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Lots of homes don't have central HVAC — they have a pile of *independent* devices: electric
baseboard in one corner, a window A/C in the window, a space heater for the cold snap, a fan for
airflow, a humidifier in winter and a dehumidifier in summer. Each shows up in HomeKit as its own
dumb switch, and nothing stops you from running the heat and the A/C at the same time.

**Thermocombobulator** turns that pile into a single HomeKit thermostat per room (a `HeaterCooler`
accessory) and runs the logic a thermostat *should*: you set a temperature, it decides what to run,
and it enforces the rules so the devices cooperate instead of fighting.

## What it does

- **One thermostat per zone.** Set heat/cool/auto + target temperature in the Home app (or by voice).
- **Heat ⊕ Cool interlock.** It will *never* run heating and cooling at the same time. Turn on cool,
  the heat is forced off, and vice-versa.
- **Staged / supplemental heat.** When the room is far below target, it stages in space heaters on
  top of the baseboard, then drops them once you're close.
- **Airflow.** Optionally circulate fans whenever it's actively heating or cooling.
- **Free cooling (economizer).** If it's cooler *outside* than in, it'll prefer running fans over
  firing up the A/C compressor.
- **Humidity.** Give it a target RH and it humidifies when dry / dehumidifies when moist — never both.
- **Outside temperature.** Show an outdoor reading and use it for free-cooling decisions.
- **Vendor-neutral.** Any device reachable by HTTP, a shell command, or SmartThings can be a member.

## How it works

Each **zone** has:
- **Sensors** — a temperature source (required), optional humidity, optional outdoor temperature.
- **Devices** grouped by **role** — `heat`, `heatSupplemental`, `cool`, `fan`, `humidify`, `dehumidify`.
- **Control** settings — hysteresis band, supplemental delta, fan circulation, free-cooling margin,
  humidity target.

Every `pollIntervalSeconds` (and immediately on any Home-app change), the engine reads the sensors,
decides what each role should do, and actuates the member devices. The decision logic lives in
[`src/engine.ts`](src/engine.ts) as a pure function (`decide`) — easy to read and unit-tested.

## Install

```bash
npm install -g homebridge-thermocombobulator
```

Or in the Homebridge UI, search for **Thermocombobulator**.

## Configuration

Add a `Thermocombobulator` platform block. Deep device config is easiest in the JSON config editor.
A full example is in [`examples/config.json`](examples/config.json).

```jsonc
{
  "platform": "Thermocombobulator",
  "smartThingsToken": "optional-shared-token",
  "pollIntervalSeconds": 30,
  "zones": [
    {
      "name": "Rear Bedroom",
      "control": {
        "defaultMode": "auto",
        "tempBandC": 0.5,
        "supplementalDeltaC": 2,
        "circulateFans": true,
        "freeCoolingMarginC": 2,
        "humidityTarget": 45
      },
      "sensors": {
        "temperature": { "adapter": { "type": "smartthings", "deviceId": "...", "capability": "temperatureMeasurement" } },
        "humidity":    { "adapter": { "type": "smartthings", "deviceId": "...", "capability": "relativeHumidityMeasurement" } }
      },
      "devices": {
        "heat":  [ { "name": "Baseboard", "adapter": { "type": "smartthings", "deviceId": "...", "capability": "switch" } } ],
        "cool":  [ { "name": "Window AC", "adapter": { "type": "command", "onCommand": "...", "offCommand": "..." } } ],
        "fan":   [ { "name": "Fan",       "adapter": { "type": "http", "onUrl": "http://.../on", "offUrl": "http://.../off" } } ]
      }
    }
  ]
}
```

### Control settings

| Key | Default | Meaning |
|---|---|---|
| `defaultMode` | `off` | Mode at first launch: `off`/`heat`/`cool`/`auto`. |
| `tempBandC` | `0.5` | Hysteresis band (°C) around setpoints to prevent short-cycling. |
| `supplementalDeltaC` | `2` | Deficit (°C) below the heat setpoint at which supplemental heaters stage in. |
| `circulateFans` | `false` | Run `fan` devices whenever actively heating/cooling. |
| `freeCoolingMarginC` | `0` | If `>0` and outdoor is this many °C below indoor while cooling, use fans instead of A/C. |
| `humidityTarget` | — | Target RH %. Omit to disable humidity control. |
| `humidityBandPct` | `5` | Hysteresis band (%) around the humidity target. |

In **auto**, the gap between the Heating and Cooling thresholds (set in the Home app) is the deadband:
heat below the heating threshold, cool above the cooling threshold, idle in between.

## Device adapters

Each device/sensor specifies an `adapter`. Adapters are how Thermocombobulator reads and actuates
real hardware — pick whatever your device speaks.

### `http`
| Field | Use |
|---|---|
| `onUrl`, `offUrl` | URLs hit to turn the device on / off. |
| `method`, `headers`, `body` | Optional request shaping (default `GET`). |
| `readUrl`, `readJsonPath`, `readScale` | For sensors: fetch a value, dig into JSON (`"main.temp"`), optionally scale. |

### `command`
| Field | Use |
|---|---|
| `onCommand`, `offCommand` | Shell commands to switch the device. |
| `readCommand`, `readScale` | For sensors: a command that prints a number. |

### `smartthings`
| Field | Use |
|---|---|
| `deviceId` | SmartThings device ID. |
| `capability` | `switch` for on/off; `temperatureMeasurement` / `relativeHumidityMeasurement` for sensors. |
| `token` | Per-adapter token (else the platform `smartThingsToken`). |
| `component` | Defaults to `main`. |

> **Roadmap:** a `hap` adapter to control any existing HomeKit accessory directly, and an `mqtt` adapter.

## Safety & behavior notes

- On every change the **opposing system is turned off before the other turns on**, so heat and cool
  never overlap even momentarily.
- If the temperature sensor can't be read, heating/cooling is **held off** (fail-safe), while humidity
  control (which has its own sensor) continues.
- Per-device actuation errors are logged and isolated — one flaky device won't stop the zone.

## Develop

```bash
npm install
npm run build      # compile TypeScript to dist/
npm test           # run the engine decision tests
npm run watch      # rebuild on change
```

## License

MIT © Kristerpher Henderson / MooseQuest. See [LICENSE](LICENSE).
