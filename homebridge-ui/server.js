const { HomebridgePluginUiServer, RequestError } = require('@homebridge/plugin-ui-utils');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

/** Reject a promise if it doesn't settle in `ms` — so a stuck cloud call can't hang the UI forever. */
function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timed out after ${ms / 1000}s — try again in a minute.`)), ms); }),
  ]);
}

// Cache the (credential-free) local Midea scan so repeat clicks reuse it instead of re-scanning/hanging.
let _mideaScan = { at: 0, ipById: {} };
async function mideaLocalScan(bin) {
  if (Date.now() - _mideaScan.at < 60000 && Object.keys(_mideaScan.ipById).length) return _mideaScan.ipById;
  const out = await new Promise((resolve) => {
    exec(`${JSON.stringify(process.execPath)} ${JSON.stringify(bin)}`, { timeout: 25000, killSignal: 'SIGKILL', maxBuffer: 1 << 20 }, (_e, so) => resolve(so || ''));
  });
  const ipById = {};
  for (const b of out.split(/Appliance\s+\d+:/i).slice(1)) {
    const id = (/-\s*Id:\s*(.+)/i.exec(b)?.[1] || '').trim();
    const host = (/-\s*Host:\s*(.+)/i.exec(b)?.[1] || '').trim();
    if (id && host) ipById[id] = host;
  }
  _mideaScan = { at: Date.now(), ipById };
  return ipById;
}

/**
 * Custom-UI server for Thermocombobulator onboarding. It runs the vendor logins/discovery
 * SERVER-SIDE (inside Homebridge), so the user's credentials go from their browser straight to
 * their own Homebridge instance — never anywhere else. Each handler returns a list of discovered
 * devices plus the adapter `config` fragment the UI stores against a zone role.
 */
class UiServer extends HomebridgePluginUiServer {
  constructor() {
    super();

    this.onRequest('/mysa/discover', (p) => this.wrap('mysa', () => this.mysa(p)));
    this.onRequest('/midea/existing', (p) => this.wrap('midea-existing', () => this.mideaExisting(p)));
    this.onRequest('/midea/discover', (p) => this.wrap('midea', () => this.midea(p)));
    this.onRequest('/nest/discover', (p) => this.wrap('nest', () => this.nest(p)));
    this.onRequest('/smartthings/discover', (p) => this.wrap('smartthings', () => this.smartthings(p)));

    console.log('[thermocombobulator-ui] onboarding server started');
    this.ready();
  }

  async wrap(label, fn) {
    const t = Date.now();
    console.log(`[thermocombobulator-ui] → ${label} discover`);
    try {
      const r = await withTimeout(Promise.resolve().then(fn), 45000, `${label} discovery`);
      const n = Array.isArray(r) ? `${r.length} device(s)` : 'ok';
      console.log(`[thermocombobulator-ui] ✓ ${label}: ${n} in ${Date.now() - t}ms`);
      return r;
    } catch (e) {
      console.error(`[thermocombobulator-ui] ✗ ${label}: ${e.message} (after ${Date.now() - t}ms)`);
      throw new RequestError(e.message || String(e), { status: 400 });
    }
  }

  requireDep(name, hint) {
    try { return require(path.join(this.homebridgeStoragePath ? '' : '', name)); }
    catch { throw new Error(`This device type needs the optional '${name}' package on the Homebridge server. ${hint || ''}`); }
  }

  // --- Mysa: reuse a persisted session (refresh token) so we don't re-login (Cognito throttles that) ---
  async mysa({ email, password }) {
    if (!email || !password) throw new Error('Mysa email and password are required.');
    let MysaApiClient;
    try { ({ MysaApiClient } = require('mysa-js-sdk')); }
    catch { throw new Error("Install 'mysa-js-sdk' on the Homebridge server to onboard Mysa."); }

    const dir = this.homebridgeStoragePath || '/tmp';
    const file = path.join(dir, `.tcb-mysa-${Buffer.from(email).toString('hex').slice(0, 20)}.json`);
    let saved;
    try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet */ }

    const client = new MysaApiClient(saved);
    // Persist the session whenever it changes (login + token refreshes) so future runs skip the password login.
    if (typeof client.on === 'function') {
      client.on('sessionChanged', (s) => {
        try { s ? fs.writeFileSync(file, JSON.stringify(s)) : fs.existsSync(file) && fs.unlinkSync(file); } catch { /* best effort */ }
      });
    }
    if (!client.isAuthenticated) {
      console.log('[thermocombobulator-ui] Mysa: no saved session, logging in…');
      await withTimeout(client.login(email, password), 25000, 'Mysa login');
    } else {
      console.log('[thermocombobulator-ui] Mysa: reusing saved session');
    }
    const raw = await withTimeout(client.getDevices(), 20000, 'Mysa device list');
    try { if (client.session) fs.writeFileSync(file, JSON.stringify(client.session)); } catch { /* best effort */ }
    // The SDK wraps the map in a `DevicesObj` (also seen as `Devices`); descend into it.
    const devMap = (raw && typeof raw === 'object' && (raw.DevicesObj || raw.Devices || raw.devices)) || raw || {};
    return Object.entries(devMap)
      .filter(([, d]) => d && typeof d === 'object')
      .map(([id, d]) => ({
        id: d.Id || d.id || id,
        name: d.Name || d.name || d.RoomName || `Mysa ${String(id).slice(-4)}`,
        model: d.Model || d.model || 'Mysa Thermostat',
        role: 'heat',
        config: { type: 'mysa', deviceId: d.Id || d.id || id, email, password },
      }));
  }

  // --- Midea (EASY PATH): reuse the A/Cs you already set up in homebridge-midea-platform ---
  // Reads that plugin's cached id/token/key, then does a credential-free LOCAL scan for each IP.
  async mideaExisting() {
    const accDir = path.join(this.homebridgeStoragePath || '/var/lib/homebridge', 'accessories');
    const byId = new Map();
    let files = [];
    try { files = fs.readdirSync(accDir).filter((f) => f.startsWith('cachedAccessories') && !f.includes('backup')); } catch { /* none */ }
    for (const f of files) {
      let arr;
      try { arr = JSON.parse(fs.readFileSync(path.join(accDir, f), 'utf8')); } catch { continue; }
      if (!Array.isArray(arr)) continue;
      for (const a of arr) {
        const c = a && a.context;
        if (a && a.plugin === 'homebridge-midea-platform' && c && c.token && c.key && c.id) {
          const id = String(c.id);
          if (!byId.has(id)) byId.set(id, { id, name: a.displayName || `Midea ${id.slice(-4)}`, token: c.token, key: c.key, model: c.model });
        }
      }
    }
    if (!byId.size) throw new Error('No Midea A/Cs found. Set them up in the homebridge-midea-platform plugin first, then come back.');

    const bin = path.join(__dirname, '..', 'node_modules', '.bin', 'midea-discover');
    const ipById = await mideaLocalScan(bin);
    const out = [...byId.values()]
      .filter((d) => ipById[d.id])
      .map((d) => ({
        id: d.id, name: d.name, model: d.model || 'Midea A/C', role: 'cool',
        config: { type: 'midea', host: ipById[d.id], deviceId: d.id, token: d.token, key: d.key, mode: 'cool' },
      }));
    if (!out.length) throw new Error('Found your Midea A/Cs in the other plugin, but none answered on the network right now.');
    return out;
  }

  // --- Midea (cloud sign-in fallback): run midea-discover with MSmartHome creds ---
  async midea({ user, password }) {
    if (!user || !password) throw new Error('Midea (MSmartHome) email and password are required.');
    const bin = path.join(__dirname, '..', 'node_modules', '.bin', 'midea-discover');
    const cmd = `${JSON.stringify(process.execPath)} ${JSON.stringify(bin)} -U ${JSON.stringify(user)} -P ${JSON.stringify(password)}`;
    const out = await new Promise((resolve, reject) => {
      exec(cmd, { timeout: 60000, maxBuffer: 1 << 20 }, (err, so, se) => {
        const combined = `${so || ''}${se || ''}`;
        combined.trim() ? resolve(combined) : reject(new Error((err && err.message) || 'midea-discover produced no output'));
      });
    });
    console.log(`[thermocombobulator-ui] midea-discover output:\n${out.slice(0, 1500)}`);

    // midea-discover prints a human-readable block per appliance: "- Id: …", "- Authentication Key: …", etc.
    const devices = [];
    const g = (b, re) => (re.exec(b)?.[1] || '').trim();
    for (const b of out.split(/Appliance\s+\d+:/i).slice(1)) {
      const id = g(b, /-\s*Id:\s*(.+)/i);
      const host = g(b, /-\s*Host:\s*(.+)/i);
      const type = g(b, /-\s*Appliance Type:\s*(.+)/i);
      const key = g(b, /-\s*Authentication Key:\s*(.+)/i);
      const token = g(b, /-\s*Authentication Token:\s*(.+)/i);
      if (id && key && token && !/no midea cloud|error|invalid/i.test(key)) {
        devices.push({
          id, name: `Midea ${type || 'A/C'} ${String(id).slice(-4)}`, model: type || 'Midea A/C', role: 'cool',
          config: { type: 'midea', host, deviceId: id, token, key, mode: 'cool' },
        });
      }
    }
    if (!devices.length) {
      const found = /Found\s+(\d+)\s+appliance/i.exec(out)?.[1];
      if (found === '0') throw new Error('No Midea A/Cs found on the local network — the A/C and Homebridge must be on the same Wi-Fi/subnet.');
      throw new Error('Found Midea appliance(s) but could not read their credentials (login may have failed). Check the log for the raw output.');
    }
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
