import type { PlatformAccessory, Service } from 'homebridge';
import type { ThermocombobulatorPlatform } from './platform';
import type { ZoneAccessory } from './zoneAccessory';

/**
 * A group (whole-home / area) thermostat. Exposes a single HeaterCooler that FANS its setting out
 * to member room-thermostats — it commands the members (their mode + setpoints), not their raw
 * devices, so nothing fights. Its current temperature is the average of the members' rooms.
 */
export class GroupAccessory {
  private service: Service;

  constructor(
    private platform: ThermocombobulatorPlatform,
    private accessory: PlatformAccessory,
    private name: string,
    private members: ZoneAccessory[],
  ) {
    const { Service, Characteristic } = this.platform;

    this.accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Thermocombobulator')
      .setCharacteristic(Characteristic.Model, 'Group Thermostat')
      .setCharacteristic(Characteristic.SerialNumber, `group-${name}`);

    this.service = this.accessory.getService(Service.HeaterCooler)
      || this.accessory.addService(Service.HeaterCooler, name);
    this.service.setCharacteristic(Characteristic.Name, name);

    const ctx = this.accessory.context as { active?: number; mode?: number; heatC?: number; coolC?: number };
    if (ctx.active === undefined) {
      ctx.active = 0; ctx.mode = Characteristic.TargetHeaterCoolerState.AUTO; ctx.heatC = 20; ctx.coolC = 24;
    }

    this.service.getCharacteristic(Characteristic.Active)
      .onGet(() => ctx.active!).onSet((v) => { ctx.active = Number(v); this.fanOut(); });
    this.service.getCharacteristic(Characteristic.TargetHeaterCoolerState)
      .onGet(() => ctx.mode!).onSet((v) => { ctx.mode = Number(v); this.fanOut(); });
    this.service.getCharacteristic(Characteristic.CurrentHeaterCoolerState)
      .onGet(() => ctx.active ? Characteristic.CurrentHeaterCoolerState.IDLE : Characteristic.CurrentHeaterCoolerState.INACTIVE);
    this.service.getCharacteristic(Characteristic.CurrentTemperature).onGet(() => this.avgTemp());
    this.service.getCharacteristic(Characteristic.HeatingThresholdTemperature)
      .setProps({ minValue: 0, maxValue: 30, minStep: 0.5 })
      .onGet(() => ctx.heatC!).onSet((v) => { ctx.heatC = Number(v); this.fanOut(); });
    this.service.getCharacteristic(Characteristic.CoolingThresholdTemperature)
      .setProps({ minValue: 10, maxValue: 35, minStep: 0.5 })
      .onGet(() => ctx.coolC!).onSet((v) => { ctx.coolC = Number(v); this.fanOut(); });
  }

  private avgTemp(): number {
    const ts = this.members.map((m) => m.roomTempC).filter((t): t is number => t != null);
    return ts.length ? ts.reduce((a, b) => a + b, 0) / ts.length : 20;
  }

  /** Push this group's setting to every member thermostat. */
  private fanOut(): void {
    const ctx = this.accessory.context as { active: number; mode: number; heatC: number; coolC: number };
    this.platform.log.info(`[Group ${this.name}] setting ${this.members.length} thermostat(s)`);
    for (const m of this.members) m.applyGroupSetting({ active: ctx.active, mode: ctx.mode, heatC: ctx.heatC, coolC: ctx.coolC });
  }
}
