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
  const off: Plan = { active: 'idle', heat: false, heatSupplemental: false, cool: false, fan: false, humidify: false, dehumidify: false, reason: '' };

  // Humidity is independent of heat/cool and runs in every mode except fully off.
  const humidityPlan = (): Pick<Plan, 'humidify' | 'dehumidify'> => {
    if (control?.humidityTarget == null || state.currentHumidity == null) return { humidify: false, dehumidify: false };
    const t = control.humidityTarget, band = c.humidityBandPct;
    if (state.currentHumidity < t - band) return { humidify: true, dehumidify: false };
    if (state.currentHumidity > t + band) return { humidify: false, dehumidify: true };
    return { humidify: false, dehumidify: false };
  };

  if (mode === 'off') return { ...off, reason: 'mode off' };

  const temp = state.currentTempC;
  if (temp == null) return { ...off, ...humidityPlan(), reason: 'no temperature reading; heat/cool held off' };

  // Determine desired active state with hysteresis.
  const wantHeat = mode === 'heat' || mode === 'auto';
  const wantCool = mode === 'cool' || mode === 'auto';
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

  const plan: Plan = { ...off, active, ...humidityPlan() };

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

  return plan;
}

/** Binds a zone's config to live adapters and applies plans to real devices. */
export class ClimateEngine {
  readonly roles: RoleAdapters;
  readonly tempSensor: Adapter;
  readonly humiditySensor?: Adapter;
  readonly outdoorSensor?: Adapter;
  private prevActive: Active = 'idle';

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

  async apply(plan: Plan): Promise<void> {
    // Safety ordering: turn OFF the opposing system before turning ON, so we never overlap.
    if (!plan.heat) await this.setRole(this.roles.heat, false);
    if (!plan.heatSupplemental) await this.setRole(this.roles.heatSupplemental, false);
    if (!plan.cool) await this.setRole(this.roles.cool, false);
    await Promise.all([
      this.setRole(this.roles.heat, plan.heat),
      this.setRole(this.roles.heatSupplemental, plan.heatSupplemental),
      this.setRole(this.roles.cool, plan.cool),
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
    this.log.debug(`[${this.zone.name}] ${plan.reason}`);
    return { state, plan };
  }
}
