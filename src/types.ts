import type { PlatformConfig } from 'homebridge';

/**
 * Config shapes for Thermocombobulator. These mirror config.schema.json.
 * Temperatures are in CELSIUS internally (HomeKit's native unit); the schema lets users
 * pick a display unit, but conversion happens at the edges.
 */

export type AdapterType = 'http' | 'command' | 'smartthings' | 'mysa' | 'midea' | 'nest' | 'hap';

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
  /** Fan speed to use when engaged (regulating devices like A/Cs). */
  fanSpeed?: 'auto' | 'low' | 'medium' | 'high' | 'silent';
  /** For an A/C: run its own fan (fan-only mode) to circulate air when it isn't actively cooling. */
  circulateWithFan?: boolean;
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

  // --- hap (control an accessory already in HomeKit, via hap-controller IP transport) ---
  hapDeviceId?: string;
  hapAddress?: string;
  hapPort?: number;
  /** Long-term pairing keys from pairSetup (persisted). */
  hapPairing?: Record<string, unknown>;
  /** 'aid.iid' of each function this device exposes. */
  hapChars?: { on?: string; current?: string; currentHumidity?: string; targetState?: string; setpoint?: string };
  /** Value to write to the targetState characteristic when arming (e.g. AUTO). */
  hapTargetStateValue?: number;
  /** True for HeaterCooler/Thermostat accessories (self-regulating); enables program(). */
  hapRegulating?: boolean;
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
  /**
   * Seasonal changeover — which systems Auto mode is allowed to use, so heat never fires in
   * summer (and A/C never fires in winter). 'auto' decides from the outdoor temperature via
   * changeoverTempC; 'heating'/'cooling' force a season; 'both' disables the lockout.
   */
  season?: 'auto' | 'heating' | 'cooling' | 'both';
  /** Outdoor °C above which it's cooling season (heat locked out); below is heating season. */
  changeoverTempC?: number;
  /** Shoulder band (°C) around changeoverTempC where BOTH heat and cool are allowed (default 3). */
  seasonDeadbandC?: number;
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
  /** Run air purifiers whenever the thermostat is on (year-round). Default true. */
  purify?: boolean;
  /** Bring in fresh air whenever the thermostat is on (year-round). Default false (opt-in). */
  freshAir?: boolean;
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
  /** Air purifiers — run year-round (independent of heat/cool), not season-gated. */
  purify?: DeviceConfig[];
  /** Fresh-air / ventilation (e.g. an A/C's fresh-air intake, an ERV) — year-round when enabled. */
  freshAir?: DeviceConfig[];
}

export interface ZoneConfig {
  name: string;
  sensors: ZoneSensors;
  devices: ZoneDevices;
  control?: ZoneControlConfig;
}

/**
 * A group thermostat: a HeaterCooler that fans its setting out to member room-thermostats (by name),
 * so you can steer the whole house from one dial. It commands the member thermostats (not their raw
 * devices), so nothing fights — members still delegate to their own devices.
 */
export interface GroupConfig {
  name: string;
  members: string[];
}

export interface ThermocombobulatorConfig extends PlatformConfig {
  /** Shared SmartThings token for any smartthings adapters that don't set their own. */
  smartThingsToken?: string;
  /** How often (seconds) the control loop re-evaluates each zone (default 30). */
  pollIntervalSeconds?: number;
  zones: ZoneConfig[];
  /** Optional whole-home / area group thermostats that steer member room-thermostats. */
  groups?: GroupConfig[];
}
