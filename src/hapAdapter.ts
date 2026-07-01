import type { Logger } from 'homebridge';
import type { AdapterConfig } from './types';
import type { Adapter } from './adapters';

/**
 * Control a device that is ALREADY in HomeKit — regardless of which plugin exposes it — by acting
 * as a HomeKit controller over the local network (hap-controller, IP transport only). This is the
 * universal reuse path: instead of re-implementing each vendor's cloud/LAN protocol, Thermocombobulator
 * pairs with the local Homebridge bridge once and reads/writes the accessory's characteristics.
 *
 * We require the IP submodule directly (lazily) so the BLE transport (native `noble`) never loads
 * and so the plugin still boots if the optional `hap-controller` package isn't installed.
 */
type HapClient = {
  getCharacteristics(c: string[]): Promise<{ characteristics: Array<{ aid: number; iid: number; value: unknown }> }>;
  setCharacteristics(c: Record<string, unknown>): Promise<unknown>;
};

function HttpClientCtor(): new (id: string, addr?: string, port?: number, pairing?: unknown) => HapClient {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('hap-controller/lib/transport/ip/http-client').default;
  } catch {
    throw new Error("HomeKit control needs the optional 'hap-controller' package on the Homebridge server.");
  }
}

const clients = new Map<string, HapClient>();
function hapClient(cfg: AdapterConfig): HapClient {
  const id = cfg.hapDeviceId!;
  let c = clients.get(id);
  if (!c) {
    c = new (HttpClientCtor())(id, cfg.hapAddress, cfg.hapPort, cfg.hapPairing);
    clients.set(id, c);
  }
  return c;
}

export class HapAdapter implements Adapter {
  constructor(private cfg: AdapterConfig, private log: Logger) {}

  private async readChar(key: string): Promise<number> {
    const r = await hapClient(this.cfg).getCharacteristics([key]);
    const [aid, iid] = key.split('.').map(Number);
    const c = r.characteristics.find((x) => x.aid === aid && x.iid === iid) ?? r.characteristics[0];
    if (c == null || c.value == null) throw new Error(`hap: no value for ${key}`);
    return Number(c.value);
  }

  async read(): Promise<number> {
    const chars = this.cfg.hapChars ?? {};
    const key = this.cfg.sensorProperty === 'humidity' ? chars.currentHumidity : chars.current;
    if (!key) throw new Error(`hap: this device exposes no ${this.cfg.sensorProperty ?? 'temperature'} reading`);
    return this.readChar(key);
  }

  async setOn(on: boolean): Promise<void> {
    const chars = this.cfg.hapChars ?? {};
    if (chars.on) {
      await hapClient(this.cfg).setCharacteristics({ [chars.on]: on ? 1 : 0 });
    } else if (chars.targetState) {
      // Thermostats have no Active char — "off" is target-state 0; "on" restores the armed state.
      await hapClient(this.cfg).setCharacteristics({ [chars.targetState]: on ? (this.cfg.hapTargetStateValue ?? 1) : 0 });
    }
  }

  // Only present for regulating accessories (HeaterCooler/Thermostat) — set in makeAdapter.
  async program(opts: { setpointC?: number }): Promise<void> {
    const chars = this.cfg.hapChars ?? {};
    const tv = this.cfg.hapTargetStateValue;
    const w: Record<string, unknown> = {};
    if (chars.on) w[chars.on] = 1;
    if (chars.targetState && tv != null) w[chars.targetState] = tv;
    if (opts.setpointC != null) {
      // Write to the setpoint characteristic that matches the arm mode: cooling (2) → cooling
      // threshold, heating (1) → heating threshold, else a single target / whatever exists.
      const key = tv === 2 ? (chars.coolSetpoint || chars.setpoint)
        : tv === 1 ? (chars.heatSetpoint || chars.setpoint)
          : (chars.setpoint || chars.coolSetpoint || chars.heatSetpoint);
      if (key) w[key] = opts.setpointC;
    }
    if (Object.keys(w).length) await hapClient(this.cfg).setCharacteristics(w);
  }
}
