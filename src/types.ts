import type { PlatformConfig } from 'homebridge';

/**
 * Config shapes for Thermocombobulator. These mirror config.schema.json.
 * Temperatures are in CELSIUS internally (HomeKit's native unit); the schema lets users
 * pick a display unit, but conversion happens at the edges.
 */

export type AdapterType = 'http' | 'command' | 'smartthings' | 'mysa' | 'midea' | 'nest';

/** How to actuate (on/off, optionally setpoint) and/or read a single physical device. */
export interface AdapterConfig {
  type: AdapterType;

  // --- mysa (cloud, via mysa-js-sdk) ---
  // deviceId + email/password below. When turned on, drives the thermostat in heat mode.

  // --- midea (local LAN, via node-mideahvac) ---
  host?: string;
  /** Local auth key from `midea-discover` (paired with token + deviceId). */
  key?: string;
  /** Mode to set when the device is turned on (e.g. 'cool' for a window A/C). */
  mode?: 'cool' | 'heat' | 'auto' | 'fan_only' | 'dry';
  /** Which reading a sensor returns: 'temperature' | 'humidity' (adapter-specific default). */
  sensorProperty?: 'temperature' | 'humidity';

  // --- account credentials (mysa; midea discovery) ---
  email?: string;
  password?: string;

  // --- nest (Google Smart Device Management API) ---
  nestProjectId?: string;
  nestClientId?: string;
  nestClientSecret?: string;
  nestRefreshToken?: string;

  // --- http ---
  onUrl?: string;
  offUrl?: string;
  method?: 'GET' | 'POST' | 'PUT';
  headers?: Record<string, string>;
  body?: string;
  /** URL returning a numeric reading (temp °C or humidity %); parsed via readJsonPath. */
  readUrl?: string;
  /** Dot-path into the JSON response, e.g. "main.temp" or "0.value". Empty = whole body is the number. */
  readJsonPath?: string;
  /** Multiply the read value (e.g. 0.1 if the device reports tenths). */
  readScale?: number;

  // --- command ---
  onCommand?: string;
  offCommand?: string;
  readCommand?: string;

  // --- smartthings ---
  /** PAT/OAuth token; falls back to the platform-level smartThingsToken. */
  token?: string;
  deviceId?: string;
  /** Capability used for on/off, default "switch". */
  capability?: string;
  component?: string;
}

/** A controllable device that belongs to a role in a zone. */
export interface DeviceConfig {
  name: string;
  adapter: AdapterConfig;
  /** Optional: this device can accept a target temperature (a real thermostat/AC), in °C. */
  supportsSetpoint?: boolean;
}

/** A read-only sensor source. */
export interface SensorConfig {
  name?: string;
  adapter: AdapterConfig;
}

export interface ZoneControlConfig {
  /** Default HeaterCooler mode at startup: 'off' | 'heat' | 'cool' | 'auto'. */
  defaultMode?: 'off' | 'heat' | 'cool' | 'auto';
  /** Hysteresis band in °C around the setpoint to avoid short-cycling (default 0.5). */
  tempBandC?: number;
  /** Extra °C below setpoint at which supplemental heat (space heaters) is staged in (default 2). */
  supplementalDeltaC?: number;
  /** Run fans to circulate air whenever heating or cooling is active (default false). */
  circulateFans?: boolean;
  /** Prefer fans over A/C when the outdoor temp is below indoor by this margin °C (0 = disabled). */
  freeCoolingMarginC?: number;
  /** Target relative humidity %; omit to disable humidity control. */
  humidityTarget?: number;
  /** Hysteresis band around humidity target in % (default 5). */
  humidityBandPct?: number;
}

export interface ZoneSensors {
  temperature: SensorConfig;
  humidity?: SensorConfig;
  outdoorTemperature?: SensorConfig;
}

export interface ZoneDevices {
  heat?: DeviceConfig[];
  /** Supplemental/booster heat (space heaters) staged on large deltas. */
  heatSupplemental?: DeviceConfig[];
  cool?: DeviceConfig[];
  fan?: DeviceConfig[];
  humidify?: DeviceConfig[];
  dehumidify?: DeviceConfig[];
}

export interface ZoneConfig {
  name: string;
  sensors: ZoneSensors;
  devices: ZoneDevices;
  control?: ZoneControlConfig;
}

export interface ThermocombobulatorConfig extends PlatformConfig {
  /** Shared SmartThings token for any smartthings adapters that don't set their own. */
  smartThingsToken?: string;
  /** How often (seconds) the control loop re-evaluates each zone (default 30). */
  pollIntervalSeconds?: number;
  zones: ZoneConfig[];
}
