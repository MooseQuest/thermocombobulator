import type {
  API, DynamicPlatformPlugin, Logger, PlatformAccessory, Service, Characteristic,
} from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import type { ThermocombobulatorConfig, ZoneConfig } from './types';
import { ZoneAccessory } from './zoneAccessory';

export class ThermocombobulatorPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly smartThingsToken?: string;

  private readonly accessories: Map<string, PlatformAccessory> = new Map();
  private readonly zones: ZoneAccessory[] = [];
  private readonly cfg: ThermocombobulatorConfig;
  private timer?: NodeJS.Timeout;

  constructor(public readonly log: Logger, config: ThermocombobulatorConfig, public readonly api: API) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.cfg = config;
    this.smartThingsToken = config.smartThingsToken;

    api.on('didFinishLaunching', () => this.discoverZones());
    api.on('shutdown', () => { if (this.timer) clearInterval(this.timer); });
  }

  /** Restore cached accessories. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.set(accessory.UUID, accessory);
  }

  private discoverZones(): void {
    const zones = this.cfg.zones ?? [];
    if (!zones.length) { this.log.warn('No zones configured — nothing to do.'); return; }

    const seen = new Set<string>();
    for (const zone of zones) {
      const uuid = this.api.hap.uuid.generate(`thermocombobulator:${zone.name}`);
      seen.add(uuid);
      let accessory = this.accessories.get(uuid);
      if (accessory) {
        this.log.info(`Restoring zone "${zone.name}"`);
      } else {
        this.log.info(`Adding zone "${zone.name}"`);
        accessory = new this.api.platformAccessory(zone.name, uuid);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.set(uuid, accessory);
      }
      try {
        this.zones.push(new ZoneAccessory(this, accessory, zone as ZoneConfig));
      } catch (e) {
        this.log.error(`Zone "${zone.name}" failed to initialise: ${(e as Error).message}`);
      }
    }

    // Remove accessories for zones that no longer exist in config.
    for (const [uuid, accessory] of this.accessories) {
      if (!seen.has(uuid)) {
        this.log.info(`Removing stale zone "${accessory.displayName}"`);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.delete(uuid);
      }
    }

    const interval = Math.max(5, this.cfg.pollIntervalSeconds ?? 30) * 1000;
    const runAll = () => this.zones.forEach((z) => z.update().catch((e) =>
      this.log.debug(`zone update error: ${(e as Error).message}`)));
    runAll();
    this.timer = setInterval(runAll, interval);
    this.log.info(`Thermocombobulator running ${this.zones.length} zone(s), polling every ${interval / 1000}s.`);
  }
}
