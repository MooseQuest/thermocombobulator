import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { Logger } from 'homebridge';
import type { AdapterConfig } from './types';

const execAsync = promisify(exec);

/**
 * An Adapter knows how to turn one physical device on/off, optionally set a target
 * temperature, and/or read a numeric value (temperature °C or humidity %).
 * Adapters are intentionally simple and vendor-neutral so any device with an HTTP
 * endpoint, a shell command, or a SmartThings entry can participate in a zone.
 */
export interface Adapter {
  setOn(on: boolean): Promise<void>;
  setTargetTemperature?(celsius: number): Promise<void>;
  read(): Promise<number>;
}

export function makeAdapter(cfg: AdapterConfig, log: Logger, platformToken?: string): Adapter {
  switch (cfg.type) {
    case 'http': return new HttpAdapter(cfg, log);
    case 'command': return new CommandAdapter(cfg, log);
    case 'smartthings': return new SmartThingsAdapter(cfg, log, platformToken);
    default: throw new Error(`Unknown adapter type: ${(cfg as AdapterConfig).type}`);
  }
}

/** Walk a dot-path ("main.temp", "0.value") into a parsed JSON object. */
function pluck(obj: unknown, path?: string): unknown {
  if (!path) return obj;
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

function toNumber(v: unknown, scale = 1): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  if (Number.isNaN(n)) throw new Error(`Sensor value is not numeric: ${JSON.stringify(v)}`);
  return n * scale;
}

class HttpAdapter implements Adapter {
  constructor(private cfg: AdapterConfig, private log: Logger) {}

  private async hit(url?: string): Promise<Response> {
    if (!url) throw new Error('http adapter: missing URL for this action');
    return fetch(url, {
      method: this.cfg.method ?? 'GET',
      headers: this.cfg.headers,
      body: this.cfg.body,
    });
  }

  async setOn(on: boolean): Promise<void> {
    const r = await this.hit(on ? this.cfg.onUrl : this.cfg.offUrl);
    if (!r.ok) throw new Error(`http setOn(${on}) -> ${r.status}`);
  }

  async read(): Promise<number> {
    const r = await this.hit(this.cfg.readUrl);
    if (!r.ok) throw new Error(`http read -> ${r.status}`);
    const text = await r.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* plain number body */ }
    return toNumber(pluck(parsed, this.cfg.readJsonPath), this.cfg.readScale);
  }
}

class CommandAdapter implements Adapter {
  constructor(private cfg: AdapterConfig, private log: Logger) {}

  async setOn(on: boolean): Promise<void> {
    const cmd = on ? this.cfg.onCommand : this.cfg.offCommand;
    if (!cmd) throw new Error('command adapter: missing on/off command');
    await execAsync(cmd);
  }

  async read(): Promise<number> {
    if (!this.cfg.readCommand) throw new Error('command adapter: missing readCommand');
    const { stdout } = await execAsync(this.cfg.readCommand);
    return toNumber(stdout.trim(), this.cfg.readScale);
  }
}

class SmartThingsAdapter implements Adapter {
  private token: string;
  private base = 'https://api.smartthings.com/v1';

  constructor(private cfg: AdapterConfig, private log: Logger, platformToken?: string) {
    const t = cfg.token ?? platformToken;
    if (!t) throw new Error('smartthings adapter: no token (set adapter.token or platform smartThingsToken)');
    if (!cfg.deviceId) throw new Error('smartthings adapter: missing deviceId');
    this.token = t;
  }

  private headers() {
    return { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' };
  }

  private async command(capability: string, command: string, args: unknown[] = []): Promise<void> {
    const body = JSON.stringify({ commands: [{ component: this.cfg.component ?? 'main', capability, command, arguments: args }] });
    const r = await fetch(`${this.base}/devices/${this.cfg.deviceId}/commands`, { method: 'POST', headers: this.headers(), body });
    if (!r.ok) throw new Error(`smartthings ${capability}.${command} -> ${r.status}`);
  }

  async setOn(on: boolean): Promise<void> {
    await this.command(this.cfg.capability ?? 'switch', on ? 'on' : 'off');
  }

  async setTargetTemperature(celsius: number): Promise<void> {
    // thermostatCoolingSetpoint / heatingSetpoint expect the location's unit; assume °C devices.
    await this.command('thermostatHeatingSetpoint', 'setHeatingSetpoint', [celsius]);
  }

  async read(): Promise<number> {
    // Reads the first numeric value of the configured capability's status.
    const cap = this.cfg.capability ?? 'temperatureMeasurement';
    const r = await fetch(`${this.base}/devices/${this.cfg.deviceId}/components/${this.cfg.component ?? 'main'}/capabilities/${cap}/status`, { headers: this.headers() });
    if (!r.ok) throw new Error(`smartthings read ${cap} -> ${r.status}`);
    const json = await r.json() as Record<string, { value: unknown }>;
    const first = Object.values(json)[0];
    return toNumber(first?.value, this.cfg.readScale);
  }
}
