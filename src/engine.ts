import type { Logger } from 'homebridge';
import { Adapter, makeAdapter } from './adapters';
import type { ZoneConfig, ZoneControlConfig, DeviceConfig } from './types';

export type Mode = 'off' | 'heat' | 'cool' | 'auto';
export type Active = 'idle' | 'heat' | 'cool';

export interface ClimateState {
  currentTempC: number | null;
  currentHumidity: number | null;
  outdoorTempC: number | null;
}

/** What every role should be doing right now. */
export interface Plan {
  active: Active;
  /** Whether heat/cool are permitted (mode + season). Regulating devices arm on these. */
  allowHeat: boolean;
  allowCool: boolean;
  /** Setpoints to program into regulating devices. */
  heatSetpointC: number;
  coolSetpointC: number;
  /** Bang-bang demand (temperature-driven) for DUMB on/off devices. */
  heat: boolean;
  heatSupplemental: boolean;
  cool: boolean;
  fan: boolean;
  humidify: boolean;
  dehumidify: boolean;
  reason: string;
}

interface RoleAdapters {
  heat: Adapter[];
  heatSupplemental: Adapter[];
  cool: Adapter[];
  fan: Adapter[];
  humidify: Adapter[];
  dehumidify: Adapter[];
}

const DEFAULTS = {
  tempBandC: 0.5,
  supplementalDeltaC: 2,
  circulateFans: false,
  freeCoolingMarginC: 0,
  humidityBandPct: 5,
};

/** Heating + cooling setpoints in °C (HomeKit's two HeaterCooler thresholds). */
export interface Setpoints {
  heatC: number;
  coolC: number;
}

/**
 * Seasonal changeover: which systems Auto is allowed to use. This is what stops the baseboard
 * from firing in summer just because the room dipped below setpoint. Explicit heat/cool modes
 * bypass this (the user is in charge); only Auto consults it.
 */
export function seasonalAllowance(
  control: ZoneControlConfig | undefined,
  outdoorTempC: number | null,
): { allowHeat: boolean; allowCool: boolean; note: string } {
  const season = control?.season ?? 'auto';
  if (season === 'heating') return { allowHeat: true, allowCool: false, note: 'heating season (forced)' };
  if (season === 'cooling') return { allowHeat: false, allowCool: true, note: 'cooling season (forced)' };
  if (season === 'both') return { allowHeat: true, allowCool: true, note: 'both allowed' };
  // 'auto': decide from the outdoor temperature if we have one + a changeover point.
  if (outdoorTempC != null && control?.changeoverTempC != null) {
    const dead = control.seasonDeadbandC ?? 3;
    const co = control.changeoverTempC;
    if (outdoorTempC > co + dead) return { allowHeat: false, allowCool: true, note: `cooling season (outdoor ${outdoorTempC.toFixed(0)}>${co}°C)` };
    if (outdoorTempC < co - dead) return { allowHeat: true, allowCool: false, note: `heating season (outdoor ${outdoorTempC.toFixed(0)}<${co}°C)` };
    return { allowHeat: true, allowCool: true, note: 'shoulder season' };
  }
  return { allowHeat: true, allowCool: true, note: 'no changeover configured' };
}

/**
 * The decision core. Pure function of (state, setpoints, mode, control, previous-active).
 * Implements the interlocks:
 *   - heat and cool are mutually exclusive (never both)
 *   - supplemental heat stages in on a large deficit
 *   - fans circulate during active heat/cool (and for free-cooling)
 *   - free-cooling prefers fans over the compressor when it's cooler outside
 *   - humidify when dry / dehumidify when moist, never simultaneously
 * Hysteresis uses `prevActive` so we don't short-cycle around the setpoint. In AUTO the gap
 * between heatC and coolC is the deadband (heat below heatC, cool above coolC, idle between).
 */
export function decide(
  state: ClimateState,
  sp: Setpoints,
  mode: Mode,
  control: ZoneControlConfig | undefined,
  prevActive: Active,
): Plan {
  const c = { ...DEFAULTS, ...(control ?? {}) };
  const off: Plan = {
    active: 'idle', allowHeat: false, allowCool: false, heatSetpointC: sp.heatC, coolSetpointC: sp.coolC,
    heat: false, heatSupplemental: false, cool: false, fan: false, humidify: false, dehumidify: false, reason: '',
  };

  // Humidity is independent of heat/cool and runs in every mode except fully off.
  const humidityPlan = (): Pick<Plan, 'humidify' | 'dehumidify'> => {
    if (control?.humidityTarget == null || state.currentHumidity == null) return { humidify: false, dehumidify: false };
    const t = control.humidityTarget, band = c.humidityBandPct;
    if (state.currentHumidity < t - band) return { humidify: true, dehumidify: false };
    if (state.currentHumidity > t + band) return { humidify: false, dehumidify: true };
    return { humidify: false, dehumidify: false };
  };

  if (mode === 'off') return { ...off, reason: 'mode off' };

  // Which systems are permitted (mode + seasonal changeover) — independent of the current temp,
  // so regulating devices stay armed even if our sensor blips. Explicit heat/cool obey the user.
  let wantHeat = mode === 'heat';
  let wantCool = mode === 'cool';
  let seasonNote = '';
  if (mode === 'auto') {
    const a = seasonalAllowance(control, state.outdoorTempC);
    wantHeat = a.allowHeat; wantCool = a.allowCool; seasonNote = ` [${a.note}]`;
  }
  const base: Plan = { ...off, allowHeat: wantHeat, allowCool: wantCool, ...humidityPlan() };

  const temp = state.currentTempC;
  if (temp == null) return { ...base, reason: `no sensor reading — regulating devices self-regulate; dumb devices held off${seasonNote}` };

  const below = temp < sp.heatC - c.tempBandC; // clearly too cold
  const above = temp > sp.coolC + c.tempBandC; // clearly too warm
  const atOrAboveHeat = temp >= sp.heatC;       // reached heat target (stop heating)
  const atOrBelowCool = temp <= sp.coolC;       // reached cool target (stop cooling)

  let active: Active = 'idle';
  if (prevActive === 'heat') active = atOrAboveHeat ? 'idle' : 'heat';   // keep heating until heat target
  else if (prevActive === 'cool') active = atOrBelowCool ? 'idle' : 'cool'; // keep cooling until cool target
  else { // was idle: only (re)start past the band
    if (wantHeat && below) active = 'heat';
    else if (wantCool && above) active = 'cool';
  }
  if (active === 'heat' && !wantHeat) active = 'idle';
  if (active === 'cool' && !wantCool) active = 'idle';

  const plan: Plan = { ...base, active };

  if (active === 'heat') {
    plan.heat = true;
    plan.heatSupplemental = (sp.heatC - temp) > c.supplementalDeltaC;
    plan.fan = c.circulateFans;
    plan.reason = `heating: ${temp.toFixed(1)}<${sp.heatC}°C` + (plan.heatSupplemental ? ' (+supplemental)' : '');
  } else if (active === 'cool') {
    const freeCooling = c.freeCoolingMarginC > 0 && state.outdoorTempC != null && state.outdoorTempC < temp - c.freeCoolingMarginC;
    if (freeCooling) {
      plan.cool = false;
      plan.fan = true;
      plan.reason = `free-cooling: outdoor ${state.outdoorTempC!.toFixed(1)}°C < indoor ${temp.toFixed(1)}°C — fans, no A/C`;
    } else {
      plan.cool = true;
      plan.fan = c.circulateFans;
      plan.reason = `cooling: ${temp.toFixed(1)}>${sp.coolC}°C`;
    }
  } else {
    plan.reason = `idle at ${temp.toFixed(1)}°C (heat ${sp.heatC} / cool ${sp.coolC}°C)`;
  }

  plan.reason += seasonNote;
  return plan;
}

/** Binds a zone's config to live adapters and applies plans to real devices. */
export class ClimateEngine {
  readonly roles: RoleAdapters;
  readonly tempSensor: Adapter;
  readonly humiditySensor?: Adapter;
  readonly outdoorSensor?: Adapter;
  private prevActive: Active = 'idle';
  private lastReason = '';

  constructor(private zone: ZoneConfig, private log: Logger, platformToken?: string) {
    const build = (devs?: DeviceConfig[]) => (devs ?? []).map((d) => makeAdapter(d.adapter, log, platformToken));
    this.roles = {
      heat: build(zone.devices.heat),
      heatSupplemental: build(zone.devices.heatSupplemental),
      cool: build(zone.devices.cool),
      fan: build(zone.devices.fan),
      humidify: build(zone.devices.humidify),
      dehumidify: build(zone.devices.dehumidify),
    };
    this.tempSensor = makeAdapter(zone.sensors.temperature.adapter, log, platformToken);
    if (zone.sensors.humidity) this.humiditySensor = makeAdapter(zone.sensors.humidity.adapter, log, platformToken);
    if (zone.sensors.outdoorTemperature) this.outdoorSensor = makeAdapter(zone.sensors.outdoorTemperature.adapter, log, platformToken);
  }

  async readState(): Promise<ClimateState> {
    const safeRead = async (a?: Adapter): Promise<number | null> => {
      if (!a) return null;
      try { return await a.read(); } catch (e) { this.log.warn(`[${this.zone.name}] sensor read failed: ${(e as Error).message}`); return null; }
    };
    return {
      currentTempC: await safeRead(this.tempSensor),
      currentHumidity: await safeRead(this.humiditySensor),
      outdoorTempC: await safeRead(this.outdoorSensor),
    };
  }

  private async setRole(adapters: Adapter[], on: boolean): Promise<void> {
    await Promise.all(adapters.map(async (a) => {
      try { await a.setOn(on); } catch (e) { this.log.warn(`[${this.zone.name}] device setOn(${on}) failed: ${(e as Error).message}`); }
    }));
  }

  /**
   * Drive one temperature role. Regulating devices (those with `program`) are handed their mode +
   * setpoint and armed when the system is allowed, then left to self-regulate — we don't force them.
   * Dumb on/off devices are bang-banged on the temperature demand.
   */
  private async driveRole(adapters: Adapter[], allowed: boolean, demand: boolean, setpointC: number): Promise<void> {
    await Promise.all(adapters.map(async (a) => {
      try {
        if (a.program) { if (allowed) await a.program({ setpointC }); else await a.setOn(false); }
        else await a.setOn(demand);
      } catch (e) { this.log.warn(`[${this.zone.name}] device drive failed: ${(e as Error).message}`); }
    }));
  }

  async apply(plan: Plan): Promise<void> {
    await Promise.all([
      this.driveRole(this.roles.heat, plan.allowHeat, plan.heat, plan.heatSetpointC),
      this.driveRole(this.roles.cool, plan.allowCool, plan.cool, plan.coolSetpointC),
      this.setRole(this.roles.heatSupplemental, plan.heatSupplemental),
      this.setRole(this.roles.fan, plan.fan),
      this.setRole(this.roles.humidify, plan.humidify),
      this.setRole(this.roles.dehumidify, plan.dehumidify),
    ]);
  }

  /** Full cycle: read sensors, decide, actuate. Returns state+plan for HomeKit reflection. */
  async tick(sp: Setpoints, mode: Mode): Promise<{ state: ClimateState; plan: Plan }> {
    const state = await this.readState();
    const plan = decide(state, sp, mode, this.zone.control, this.prevActive);
    this.prevActive = plan.active;
    await this.apply(plan);
    const now = state.currentTempC != null
      ? ` — now ${state.currentTempC.toFixed(1)}°C${state.currentHumidity != null ? `, ${Math.round(state.currentHumidity)}% RH` : ''}`
      : '';
    const running = [plan.heat && 'heat', plan.heatSupplemental && 'aux-heat', plan.cool && 'cool', plan.fan && 'fan', plan.humidify && 'humidify', plan.dehumidify && 'dehumidify']
      .filter(Boolean).join('+') || 'nothing';
    const line = `[${this.zone.name}] ${plan.reason}${now} → running: ${running}`;
    // Log at info when the situation changes (visible), debug otherwise (avoids per-tick spam).
    if (plan.reason !== this.lastReason) { this.log.info(line); this.lastReason = plan.reason; }
    else this.log.debug(line);
    return { state, plan };
  }
}
