# Climate Model — the four independent layers

A Thermocombobulator zone is not just a thermostat — it's a small climate controller with **four
independent layers**. Only the first is gated by season; the rest run year-round. This separation is
what lets you (for example) pull in **fresh air** or run the **air purifier** in the dead of winter
while heat is the active temperature system.

## The layers

| Layer | Job | HomeKit service | Season-gated? | Roles / devices |
|---|---|---|---|---|
| **1. Temperature** | Hold the setpoint | `HeaterCooler` | **Yes** — seasonal changeover locks out heat in summer, the A/C compressor in winter | `heat`, `heatSupplemental`, `cool` |
| **2. Ventilation / fresh air** | Move/refresh air | `Fanv2` | No — year-round | `fan` (circulation) + A/C **vent/fresh-air mode** |
| **3. Air purification** | Clean the air (air quality) | `AirPurifier` | No — year-round | `purify` (VeSync, etc.) |
| **4. Humidity** | Hold target RH | `HumidifierDehumidifier` | No — humidity-driven | `humidify`, `dehumidify` |

## Key principles

- **Seasonal changeover only gates temperature.** Fresh air, purification, and humidity never get
  locked out by season. (Bug to avoid: don't let "cooling season" or "heating season" stop the fan,
  the fresh-air vent, or the purifier.)
- **A device can serve multiple layers.** A window A/C is a **`cool`** device (compressor) *and* a
  **`fan`/fresh-air** device (vent mode). The Midea adapter's `mode` picks which function is invoked:
  `cool` for the compressor, `fan_only` for ventilation/fresh air. So the same unit can be added to
  both the `cool` role (temperature layer) and the `fan` role (ventilation layer).
- **Independent HomeKit controls.** Each active layer surfaces its own service on the zone accessory,
  so you can run the purifier or bring in fresh air without touching the thermostat mode.
- **Fresh air vs. free-cooling.** Free-cooling (fans/vent instead of the compressor when it's cooler
  outside) is a *temperature-layer* optimization. Plain fresh-air ventilation is a *ventilation-layer*
  function the user can turn on any time, cooling or not.

## Control philosophy: delegate, don't force

The plugin **coordinates**; it does not micro-manage temperature. How a device is driven depends on
whether it can regulate itself:

- **Regulating devices** (`supportsSetpoint`: Mysa, Nest, Midea A/C) — the plugin **sets mode +
  setpoint and arms** the device, then lets the device's own thermostat hold the temperature. It does
  **not** poll-and-toggle to force a number. Example: target 72°F, room 70°F, summer → arm the A/C at
  72 and leave it; its own thermoregulation won't chill to 70.
- **Dumb devices** (no setpoint: a space heater on a smart plug, a basic fan) — the plugin does the
  regulating itself, bang-bang against the room sensor with hysteresis, because the device can't.

### Auto = a comfort range (Nest-style)
Auto is a **range**, not a point: a heat floor (e.g. 68°F) and a cool ceiling (e.g. 78°F). Heat only
defends the floor; cool only defends the ceiling; between them, idle. These are HomeKit's two
HeaterCooler thresholds. A real deadband (floor ≪ ceiling) means heat and cool **physically cannot
run at once**, so the range itself prevents competing devices; season then disarms a whole side (no
baseboard armed in deep summer). Regulating devices get programmed to the relevant bound (heat→floor,
cool→ceiling); dumb devices bang-bang around it.

## Build status
- ✅ Layer 1 temperature: heat⊕cool interlock, supplemental staging, hysteresis, **seasonal changeover**,
  free-cooling, capability-aware modes, Nest-style range (two thresholds).
- ⏳ **Delegate-don't-force revision:** regulating devices (supportsSetpoint) get programmed
  (mode+setpoint+arm) instead of bang-banged; only dumb devices are bang-banged. (Engine currently
  bang-bangs everything — to revise before any regulating device is driven live.)
- ✅ Layer 4 humidity: auto humidify/dehumidify when configured (display-only otherwise).
- ⏳ Layer 2 ventilation/fresh-air as an independent `Fanv2` (incl. A/C vent mode) — not season-gated.
- ⏳ Layer 3 air purification: VeSync adapter + `purify` role → `AirPurifier` service.
- ⏳ Multi-service zone accessory exposing each active layer as its own HomeKit control.
