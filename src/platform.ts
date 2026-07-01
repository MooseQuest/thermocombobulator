import type {
  API, DynamicPlatformPlugin, Logger, PlatformAccessory, Service, Characteristic,
} from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import type { ThermocombobulatorConfig, ZoneConfig } from './types';
import { ZoneAccessory } from './zoneAccessory';
import { GroupAccessory } from './groupAccessory';

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
    // Note: we do NOT bail early when there are no zones — the reconcile pass below must still run so
    // that removing every thermostat/group actually unregisters the stale HomeKit accessories.
    if (!zones.length) this.log.info('No thermostats configured — removing any leftover accessories.');

    const seen = new Set<string>();
    const byName = new Map<string, ZoneAccessory>();
    const accessoryFor = (key: string, name: string): PlatformAccessory => {
      const uuid = this.api.hap.uuid.generate(key);
      seen.add(uuid);
      let accessory = this.accessories.get(uuid);
      if (!accessory) {
        accessory = new this.api.platformAccessory(name, uuid);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.set(uuid, accessory);
      }
      return accessory;
    };

    for (const zone of zones) {
      try {
        const za = new ZoneAccessory(this, accessoryFor(`thermocombobulator:${zone.name}`, zone.name), zone as ZoneConfig);
        this.zones.push(za);
        byName.set(zone.name, za);
      } catch (e) {
        this.log.error(`Thermostat "${zone.name}" failed to initialise: ${(e as Error).message}`);
      }
    }

    // Group thermostats fan out to their member room-thermostats (built after the zones exist).
    for (const group of this.cfg.groups ?? []) {
      const members = (group.members ?? []).map((n) => byName.get(n)).filter((m): m is ZoneAccessory => !!m);
      if (!members.length) { this.log.warn(`Group "${group.name}" has no valid members — skipping.`); continue; }
      try {
        new GroupAccessory(this, accessoryFor(`thermocombobulator:group:${group.name}`, group.name), group.name, members);
        this.log.info(`Group "${group.name}" steering ${members.length} thermostat(s).`);
      } catch (e) {
        this.log.error(`Group "${group.name}" failed to initialise: ${(e as Error).message}`);
      }
    }

    // Remove accessories for zones/groups that no longer exist in config.
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
