import type { PlatformAccessory, Service, CharacteristicValue } from 'homebridge';
import type { ThermocombobulatorPlatform } from './platform';
import type { ZoneConfig } from './types';
import { ClimateEngine, Mode, Setpoints, Plan } from './engine';

/**
 * One Homebridge accessory per zone, exposing a HeaterCooler service (heat/cool/auto + setpoints +
 * current temp + humidity readout) and an optional outdoor TemperatureSensor. The Home app drives
 * Active / mode / thresholds; the ClimateEngine actuates the underlying devices on each poll tick.
 */
export class ZoneAccessory {
  private service: Service;
  private outdoorService?: Service;
  private engine: ClimateEngine;

  constructor(
    private platform: ThermocombobulatorPlatform,
    private accessory: PlatformAccessory,
    private zone: ZoneConfig,
  ) {
    const { Service, Characteristic } = this.platform;
    this.engine = new ClimateEngine(zone, platform.log, platform.smartThingsToken);

    this.accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Thermocombobulator')
      .setCharacteristic(Characteristic.Model, 'Virtual Climate Zone')
      .setCharacteristic(Characteristic.SerialNumber, `zone-${zone.name}`);

    this.service = this.accessory.getService(Service.HeaterCooler)
      || this.accessory.addService(Service.HeaterCooler, zone.name);
    this.service.setCharacteristic(Characteristic.Name, zone.name);

    // Persisted desired state (survives restarts via accessory.context).
    const ctx = this.accessory.context as { active?: number; mode?: number; heatC?: number; coolC?: number };
    if (ctx.active === undefined) {
      const def = zone.control?.defaultMode ?? 'off';
      ctx.active = def === 'off' ? 0 : 1;
      ctx.mode = def === 'cool' ? Characteristic.TargetHeaterCoolerState.COOL
        : def === 'heat' ? Characteristic.TargetHeaterCoolerState.HEAT
          : Characteristic.TargetHeaterCoolerState.AUTO;
      ctx.heatC = 20;
      ctx.coolC = 24;
    }

    // Active (on/off)
    this.service.getCharacteristic(Characteristic.Active)
      .onGet(() => ctx.active!)
      .onSet((v) => { ctx.active = Number(v); this.kick(); });

    // Target mode (auto/heat/cool) — only offer modes the zone can actually do.
    const S = Characteristic.TargetHeaterCoolerState;
    const hasHeat = !!zone.devices.heat?.length;
    const hasCool = !!zone.devices.cool?.length;
    const validModes: number[] = [];
    if (hasHeat || hasCool) validModes.push(S.AUTO);   // "let the plugin manage it"
    if (hasHeat) validModes.push(S.HEAT);
    if (hasCool) validModes.push(S.COOL);
    if (!validModes.length) validModes.push(S.AUTO);
    this.service.getCharacteristic(S)
      .setProps({ validValues: validModes })
      .onGet(() => ctx.mode!)
      .onSet((v) => { ctx.mode = Number(v); this.kick(); });

    // Current state (reported by the engine)
    this.service.getCharacteristic(Characteristic.CurrentHeaterCoolerState)
      .onGet(() => this.currentState);

    // Current temperature (reported by the engine)
    this.service.getCharacteristic(Characteristic.CurrentTemperature)
      .onGet(() => this.currentTempC ?? 20);

    // Setpoints
    this.service.getCharacteristic(Characteristic.HeatingThresholdTemperature)
      .setProps({ minValue: 0, maxValue: 30, minStep: 0.5 })
      .onGet(() => ctx.heatC!)
      .onSet((v) => { ctx.heatC = Number(v); this.kick(); });
    this.service.getCharacteristic(Characteristic.CoolingThresholdTemperature)
      .setProps({ minValue: 10, maxValue: 35, minStep: 0.5 })
      .onGet(() => ctx.coolC!)
      .onSet((v) => { ctx.coolC = Number(v); this.kick(); });

    if (zone.sensors.humidity) {
      this.service.getCharacteristic(Characteristic.CurrentRelativeHumidity)
        .onGet(() => this.currentHumidity ?? 50);
    }

    if (zone.sensors.outdoorTemperature) {
      this.outdoorService = this.accessory.getService('Outdoor')
        || this.accessory.addService(Service.TemperatureSensor, 'Outdoor', 'outdoor');
      this.outdoorService.getCharacteristic(Characteristic.CurrentTemperature)
        .onGet(() => this.outdoorTempC ?? 20);
    }
  }

  private currentTempC: number | null = null;
  private currentHumidity: number | null = null;
  private outdoorTempC: number | null = null;
  private currentState = 0; // INACTIVE

  private get setpoints(): Setpoints {
    const ctx = this.accessory.context as { heatC: number; coolC: number };
    return { heatC: ctx.heatC, coolC: ctx.coolC };
  }

  private get mode(): Mode {
    const { Characteristic } = this.platform;
    const ctx = this.accessory.context as { active: number; mode: number };
    if (!ctx.active) return 'off';
    switch (ctx.mode) {
      case Characteristic.TargetHeaterCoolerState.HEAT: return 'heat';
      case Characteristic.TargetHeaterCoolerState.COOL: return 'cool';
      default: return 'auto';
    }
  }

  /** Re-run the loop promptly after a user change (debounced by the platform's poll otherwise). */
  private kick(): void {
    this.update().catch((e) => this.platform.log.warn(`[${this.zone.name}] update failed: ${(e as Error).message}`));
  }

  private reflect(plan: Plan): void {
    const { Characteristic } = this.platform;
    const C = Characteristic.CurrentHeaterCoolerState;
    this.currentState = this.mode === 'off' ? C.INACTIVE
      : plan.active === 'heat' ? C.HEATING
        : plan.active === 'cool' ? C.COOLING
          : C.IDLE;
    this.service.updateCharacteristic(Characteristic.CurrentHeaterCoolerState, this.currentState);
    if (this.currentTempC != null) this.service.updateCharacteristic(Characteristic.CurrentTemperature, this.currentTempC);
    if (this.zone.sensors.humidity && this.currentHumidity != null) {
      this.service.updateCharacteristic(Characteristic.CurrentRelativeHumidity, this.currentHumidity);
    }
    if (this.outdoorService && this.outdoorTempC != null) {
      this.outdoorService.updateCharacteristic(Characteristic.CurrentTemperature, this.outdoorTempC);
    }
  }

  /** Called on every poll tick by the platform. */
  async update(): Promise<void> {
    const { state, plan } = await this.engine.tick(this.setpoints, this.mode);
    this.currentTempC = state.currentTempC;
    this.currentHumidity = state.currentHumidity;
    this.outdoorTempC = state.outdoorTempC;
    this.reflect(plan);
  }

  /** Latest room temperature (for a group thermostat to average across members). */
  get roomTempC(): number | null { return this.currentTempC; }

  /** Applied by a group thermostat: overwrite this thermostat's mode + setpoints, reflect, re-run. */
  applyGroupSetting(o: { active: number; mode: number; heatC: number; coolC: number }): void {
    const ctx = this.accessory.context as { active: number; mode: number; heatC: number; coolC: number };
    ctx.active = o.active; ctx.mode = o.mode; ctx.heatC = o.heatC; ctx.coolC = o.coolC;
    const C = this.platform.Characteristic;
    this.service.updateCharacteristic(C.Active, o.active);
    this.service.updateCharacteristic(C.TargetHeaterCoolerState, o.mode);
    this.service.updateCharacteristic(C.HeatingThresholdTemperature, o.heatC);
    this.service.updateCharacteristic(C.CoolingThresholdTemperature, o.coolC);
    this.update().catch((e) => this.platform.log.warn(`[${this.zone.name}] group update failed: ${(e as Error).message}`));
  }
}
