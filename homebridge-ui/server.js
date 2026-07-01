const { HomebridgePluginUiServer, RequestError } = require('@homebridge/plugin-ui-utils');
const { exec } = require('child_process');
const path = require('path');

/**
 * Custom-UI server for Thermocombobulator onboarding. It runs the vendor logins/discovery
 * SERVER-SIDE (inside Homebridge), so the user's credentials go from their browser straight to
 * their own Homebridge instance — never anywhere else. Each handler returns a list of discovered
 * devices plus the adapter `config` fragment the UI stores against a zone role.
 */
class UiServer extends HomebridgePluginUiServer {
  constructor() {
    super();

    this.onRequest('/mysa/discover', (p) => this.wrap(() => this.mysa(p)));
    this.onRequest('/midea/discover', (p) => this.wrap(() => this.midea(p)));
    this.onRequest('/nest/discover', (p) => this.wrap(() => this.nest(p)));
    this.onRequest('/smartthings/discover', (p) => this.wrap(() => this.smartthings(p)));

    this.ready();
  }

  async wrap(fn) {
    try { return await fn(); }
    catch (e) { throw new RequestError(e.message || String(e), { status: 400 }); }
  }

  requireDep(name, hint) {
    try { return require(path.join(this.homebridgeStoragePath ? '' : '', name)); }
    catch { throw new Error(`This device type needs the optional '${name}' package on the Homebridge server. ${hint || ''}`); }
  }

  // --- Mysa: SDK login + list thermostats ---
  async mysa({ email, password }) {
    if (!email || !password) throw new Error('Mysa email and password are required.');
    let MysaApiClient;
    try { ({ MysaApiClient } = require('mysa-js-sdk')); }
    catch { throw new Error("Install 'mysa-js-sdk' on the Homebridge server to onboard Mysa."); }
    const client = new MysaApiClient();
    await client.login(email, password);
    const devices = await client.getDevices();
    return Object.entries(devices).map(([id, d]) => ({
      id,
      name: d.Name || d.name || `Mysa ${id.slice(-4)}`,
      model: d.Model || d.model || 'Mysa Thermostat',
      role: 'heat',
      config: { type: 'mysa', deviceId: id, email, password },
    }));
  }

  // --- Midea: run the bundled midea-discover CLI, parse devices (host/id/token/key) ---
  async midea({ user, password }) {
    if (!user || !password) throw new Error('Midea (MSmartHome) email and password are required.');
    const bin = path.join(__dirname, '..', 'node_modules', '.bin', 'midea-discover');
    const cmd = `${JSON.stringify(process.execPath)} ${JSON.stringify(bin)} -U ${JSON.stringify(user)} -P ${JSON.stringify(password)}`;
    const stdout = await new Promise((resolve, reject) => {
      exec(cmd, { timeout: 90000, maxBuffer: 1 << 20 }, (err, out, errout) =>
        (out && out.length) ? resolve(out) : reject(new Error(errout || (err && err.message) || 'no output')));
    });
    // The CLI prints one JSON object per discovered appliance; collect them defensively.
    const devices = [];
    for (const m of stdout.matchAll(/\{[\s\S]*?\}/g)) {
      try {
        const o = JSON.parse(m[0]);
        const id = o.id || o.deviceId; const host = o.host || o.ip || o.address;
        const token = o.token; const key = o.key;
        if (id && token && key) devices.push({
          id, name: o.name || `Midea ${String(id).slice(-4)}`, model: o.type || 'Midea A/C',
          role: 'cool',
          config: { type: 'midea', host, deviceId: id, token, key, mode: 'cool' },
        });
      } catch { /* skip non-JSON lines */ }
    }
    if (!devices.length) throw new Error('No Midea devices parsed. Raw output:\n' + stdout.slice(0, 800));
    return devices;
  }

  // --- Nest: mint an SDM access token and list thermostats ---
  async nest({ nestProjectId, nestClientId, nestClientSecret, nestRefreshToken }) {
    for (const [k, v] of Object.entries({ nestProjectId, nestClientId, nestClientSecret, nestRefreshToken })) {
      if (!v) throw new Error(`Nest ${k} is required (from your Device Access project).`);
    }
    const body = new URLSearchParams({ client_id: nestClientId, client_secret: nestClientSecret, refresh_token: nestRefreshToken, grant_type: 'refresh_token' });
    const tr = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body });
    if (!tr.ok) throw new Error(`Nest token refresh failed (${tr.status}). Check client id/secret/refresh token.`);
    const { access_token } = await tr.json();
    const dr = await fetch(`https://smartdevicemanagement.googleapis.com/v1/enterprises/${nestProjectId}/devices`, { headers: { Authorization: `Bearer ${access_token}` } });
    if (!dr.ok) throw new Error(`Nest device list failed (${dr.status}). Check the project id.`);
    const { devices = [] } = await dr.json();
    return devices
      .filter((d) => (d.type || '').includes('THERMOSTAT'))
      .map((d) => {
        const id = d.name.split('/').pop();
        const label = d.traits?.['sdm.devices.traits.Info']?.customName || `Nest ${id.slice(-4)}`;
        return {
          id, name: label, model: 'Nest Thermostat', role: 'heat',
          config: { type: 'nest', deviceId: id, mode: 'heat', nestProjectId, nestClientId, nestClientSecret, nestRefreshToken },
        };
      });
  }

  // --- SmartThings: list devices via the shared platform token ---
  async smartthings({ token }) {
    if (!token) throw new Error('A SmartThings token is required.');
    const r = await fetch('https://api.smartthings.com/v1/devices', { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`SmartThings device list failed (${r.status}).`);
    const { items = [] } = await r.json();
    return items.map((d) => ({
      id: d.deviceId,
      name: d.label || d.name,
      model: d.deviceManufacturerCode || 'SmartThings',
      role: 'heat',
      config: { type: 'smartthings', deviceId: d.deviceId, token, capability: 'switch' },
    }));
  }
}

(() => new UiServer())();
