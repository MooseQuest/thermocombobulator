import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { Logger } from 'homebridge';
import type { AdapterConfig } from './types';
import { HapAdapter } from './hapAdapter';

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
  /**
   * Regulating devices (thermostats, A/Cs) implement this: program the device to its configured
   * mode + fan at the given setpoint and arm it, then let its own thermostat hold the temperature.
   * Presence of this method is how the engine knows a device self-regulates (vs. dumb on/off).
   */
  program?(opts: { setpointC?: number }): Promise<void>;
}

export function makeAdapter(cfg: AdapterConfig, log: Logger, platformToken?: string): Adapter {
  switch (cfg.type) {
    case 'http': return new HttpAdapter(cfg, log);
    case 'command': return new CommandAdapter(cfg, log);
    case 'smartthings': return new SmartThingsAdapter(cfg, log, platformToken);
    case 'mysa': return new MysaAdapter(cfg, log);
    case 'midea': return new MideaAdapter(cfg, log);
    case 'nest': return new NestAdapter(cfg, log);
    case 'hap': {
      const a = new HapAdapter(cfg, log);
      // Dumb HomeKit accessories (switch/fan/purifier) don't self-regulate — hide program() so the
      // engine bang-bangs them instead of arming them with a setpoint.
      if (!cfg.hapRegulating) (a as unknown as { program?: unknown }).program = undefined;
      return a;
    }
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

  async program(opts: { setpointC?: number }): Promise<void> {
    await this.setOn(true);
    if (opts.setpointC != null) await this.setTargetTemperature(opts.setpointC);
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

// ---------------------------------------------------------------------------
// Native device adapters (optional dependencies, lazy-loaded so the core plugin
// stays light — users install only the SDK for hardware they actually own).
// ---------------------------------------------------------------------------

/** Shared, memoised Mysa clients keyed by account email (login is expensive; SDK caches session). */
const mysaClients = new Map<string, Promise<MysaClientLike>>();
interface MysaStatus { deviceId: string; temperature?: number; humidity?: number; setPoint?: number }
interface MysaClientLike {
  setDeviceState(deviceId: string, temperatureC: number | undefined, mode: 'heat' | 'off'): Promise<void>;
  getDevices(): Promise<Record<string, Record<string, unknown>>>;
  emitter: { on(event: string, handler: (...args: unknown[]) => void): void };
  startRealtimeUpdates(deviceId: string): Promise<void>;
}

// Live Mysa readings arrive via the realtime `statusChanged` feed (getDevices only returns config).
const mysaStatus = new Map<string, MysaStatus>();
const mysaRealtime = new Set<string>();
async function ensureMysaRealtime(client: MysaClientLike, deviceId: string): Promise<void> {
  if (mysaRealtime.has(deviceId)) return;
  mysaRealtime.add(deviceId);
  client.emitter.on('statusChanged', (s: unknown) => {
    const status = s as MysaStatus;
    if (status && status.deviceId) mysaStatus.set(status.deviceId, status);
  });
  try { await client.startRealtimeUpdates(deviceId); }
  catch (e) { mysaRealtime.delete(deviceId); throw e; }
}
function mysaClient(email: string, password: string): Promise<MysaClientLike> {
  let p = mysaClients.get(email);
  if (!p) {
    p = (async () => {
      let sdk: { MysaApiClient: new () => MysaClientLike & { login(e: string, pw: string): Promise<void> } };
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        sdk = require('mysa-js-sdk');
      } catch {
        throw new Error("mysa adapter needs the optional 'mysa-js-sdk' package — run: npm install mysa-js-sdk");
      }
      const client = new sdk.MysaApiClient();
      await client.login(email, password);
      return client;
    })();
    mysaClients.set(email, p);
  }
  return p;
}

class MysaAdapter implements Adapter {
  constructor(private cfg: AdapterConfig, private log: Logger) {
    if (!cfg.email || !cfg.password) throw new Error('mysa adapter: email and password are required');
    if (!cfg.deviceId) throw new Error('mysa adapter: deviceId is required');
  }
  private client() { return mysaClient(this.cfg.email!, this.cfg.password!); }

  async setOn(on: boolean): Promise<void> {
    const c = await this.client();
    await ensureMysaRealtime(c, this.cfg.deviceId!); // commands go over MQTT — make sure it's up first
    // Undefined temperature keeps the thermostat's current setpoint; mode drives on/off.
    await c.setDeviceState(this.cfg.deviceId!, undefined, on ? 'heat' : 'off');
  }

  async setTargetTemperature(celsius: number): Promise<void> {
    const c = await this.client();
    await ensureMysaRealtime(c, this.cfg.deviceId!);
    await c.setDeviceState(this.cfg.deviceId!, celsius, 'heat');
  }

  async program(opts: { setpointC?: number }): Promise<void> {
    const c = await this.client();
    await ensureMysaRealtime(c, this.cfg.deviceId!);
    await c.setDeviceState(this.cfg.deviceId!, opts.setpointC, 'heat');
  }

  async read(): Promise<number> {
    const c = await this.client();
    await ensureMysaRealtime(c, this.cfg.deviceId!);
    let status = mysaStatus.get(this.cfg.deviceId!);
    if (!status) { await new Promise((r) => setTimeout(r, 3000)); status = mysaStatus.get(this.cfg.deviceId!); }
    if (!status) throw new Error(`mysa read: no realtime status yet for ${this.cfg.deviceId} (warming up)`);
    const prop = this.cfg.sensorProperty ?? 'temperature';
    const v = prop === 'humidity' ? status.humidity : status.temperature;
    if (v == null) throw new Error(`mysa read: no ${prop} in status`);
    return Number(v);
  }
}

/** Shared, memoised Midea appliances keyed by host:deviceId. */
const mideaDevices = new Map<string, Promise<MideaApplianceLike>>();
interface MideaApplianceLike {
  initialize(): Promise<void>;
  getStatus(): Promise<Record<string, unknown>>;
  setStatus(props: Record<string, unknown>): Promise<void>;
}
const MIDEA_MODE: Record<string, number> = { auto: 1, cool: 2, dry: 3, heat: 4, fan_only: 5 };
const MIDEA_FAN: Record<string, number> = { auto: 102, silent: 20, low: 40, medium: 60, high: 80 };

function mideaAppliance(cfg: AdapterConfig): Promise<MideaApplianceLike> {
  const k = `${cfg.host}:${cfg.deviceId}`;
  let p = mideaDevices.get(k);
  if (!p) {
    p = (async () => {
      let sdk: { createAppliance: (o: Record<string, unknown>) => MideaApplianceLike };
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        sdk = require('node-mideahvac');
      } catch {
        throw new Error("midea adapter needs the optional 'node-mideahvac' package — run: npm install node-mideahvac");
      }
      const ac = sdk.createAppliance({ communicationMethod: 'sk103', host: cfg.host, id: cfg.deviceId, token: cfg.token, key: cfg.key });
      await ac.initialize();
      return ac;
    })();
    mideaDevices.set(k, p);
  }
  return p;
}

class MideaAdapter implements Adapter {
  constructor(private cfg: AdapterConfig, private log: Logger) {
    if (!cfg.host || !cfg.deviceId || !cfg.token || !cfg.key) {
      throw new Error('midea adapter: host, deviceId, token, and key are required (obtain via `midea-discover`)');
    }
  }

  async setOn(on: boolean): Promise<void> {
    const ac = await mideaAppliance(this.cfg);
    const props: Record<string, unknown> = { powerOn: on };
    if (on && this.cfg.mode) props.mode = MIDEA_MODE[this.cfg.mode];
    await ac.setStatus(props);
  }

  async setTargetTemperature(celsius: number): Promise<void> {
    const ac = await mideaAppliance(this.cfg);
    await ac.setStatus({ temperatureSetpoint: celsius });
  }

  /** Program the A/C to its configured mode + fan at the given setpoint, then leave it to self-regulate. */
  async program(opts: { setpointC?: number }): Promise<void> {
    const ac = await mideaAppliance(this.cfg);
    const props: Record<string, unknown> = { powerOn: true };
    if (this.cfg.mode) props.mode = MIDEA_MODE[this.cfg.mode];
    if (this.cfg.fanSpeed) props.fanSpeed = MIDEA_FAN[this.cfg.fanSpeed];
    if (opts.setpointC != null) props.temperatureSetpoint = Math.round(opts.setpointC);
    await ac.setStatus(props);
  }

  async read(): Promise<number> {
    const ac = await mideaAppliance(this.cfg);
    const s = await ac.getStatus();
    const prop = this.cfg.sensorProperty ?? 'temperature';
    const v = prop === 'humidity' ? s.humidity : (s.indoorTemperature ?? s.temperature);
    if (v == null) throw new Error(`midea read: no ${prop}`);
    return Number(v);
  }
}

/**
 * Nest — Google Smart Device Management (SDM) API. Requires a Device Access project
 * ($5 one-time) + OAuth (clientId/secret/refreshToken/projectId). No extra npm dep — plain REST.
 * Used as a heat OR cool member (cfg.mode), or as a temperature/humidity sensor.
 */
const nestTokens = new Map<string, { token: string; exp: number }>();
async function nestAccessToken(cfg: AdapterConfig): Promise<string> {
  const key = cfg.nestRefreshToken!;
  const cached = nestTokens.get(key);
  const now = Date.now();
  if (cached && cached.exp > now + 60_000) return cached.token;
  const body = new URLSearchParams({
    client_id: cfg.nestClientId!, client_secret: cfg.nestClientSecret!,
    refresh_token: cfg.nestRefreshToken!, grant_type: 'refresh_token',
  });
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body });
  if (!r.ok) throw new Error(`nest token refresh -> ${r.status}`);
  const j = await r.json() as { access_token: string; expires_in: number };
  nestTokens.set(key, { token: j.access_token, exp: now + j.expires_in * 1000 });
  return j.access_token;
}

class NestAdapter implements Adapter {
  private base = 'https://smartdevicemanagement.googleapis.com/v1';
  constructor(private cfg: AdapterConfig, private log: Logger) {
    for (const f of ['nestProjectId', 'nestClientId', 'nestClientSecret', 'nestRefreshToken', 'deviceId'] as const) {
      if (!cfg[f]) throw new Error(`nest adapter: ${f} is required (from the Device Access setup)`);
    }
  }
  private devicePath() { return `enterprises/${this.cfg.nestProjectId}/devices/${this.cfg.deviceId}`; }
  private async auth() { return { Authorization: `Bearer ${await nestAccessToken(this.cfg)}` }; }

  private async cmd(command: string, params: Record<string, unknown>): Promise<void> {
    const r = await fetch(`${this.base}/${this.devicePath()}:executeCommand`, {
      method: 'POST', headers: { ...(await this.auth()), 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, params }),
    });
    if (!r.ok) throw new Error(`nest ${command} -> ${r.status}`);
  }

  async setOn(on: boolean): Promise<void> {
    const mode = on ? (this.cfg.mode === 'cool' ? 'COOL' : 'HEAT') : 'OFF';
    await this.cmd('sdm.devices.commands.ThermostatMode.SetMode', { mode });
  }

  async setTargetTemperature(celsius: number): Promise<void> {
    const cool = this.cfg.mode === 'cool';
    await this.cmd(`sdm.devices.commands.ThermostatTemperatureSetpoint.Set${cool ? 'Cool' : 'Heat'}`,
      cool ? { coolCelsius: celsius } : { heatCelsius: celsius });
  }

  async program(opts: { setpointC?: number }): Promise<void> {
    await this.setOn(true);
    if (opts.setpointC != null) await this.setTargetTemperature(opts.setpointC);
  }

  async read(): Promise<number> {
    const r = await fetch(`${this.base}/${this.devicePath()}`, { headers: await this.auth() });
    if (!r.ok) throw new Error(`nest read -> ${r.status}`);
    const j = await r.json() as { traits: Record<string, Record<string, number>> };
    const t = j.traits;
    const v = this.cfg.sensorProperty === 'humidity'
      ? t['sdm.devices.traits.Humidity']?.ambientHumidityPercent
      : t['sdm.devices.traits.Temperature']?.ambientTemperatureCelsius;
    if (v == null) throw new Error(`nest read: no ${this.cfg.sensorProperty ?? 'temperature'}`);
    return Number(v);
  }
}
