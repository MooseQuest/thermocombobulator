import { test } from 'node:test';
import assert from 'node:assert';
import { decide, ClimateState, Setpoints } from './engine';

const sp: Setpoints = { heatC: 20, coolC: 24 };
const st = (t: number | null, h: number | null = null, o: number | null = null): ClimateState =>
  ({ currentTempC: t, currentHumidity: h, outdoorTempC: o });

test('off mode does nothing', () => {
  const p = decide(st(10), sp, 'off', {}, 'idle');
  assert.equal(p.heat, false); assert.equal(p.cool, false); assert.equal(p.active, 'idle');
});

test('heat engages when clearly below heat setpoint', () => {
  const p = decide(st(17), sp, 'heat', { tempBandC: 0.5 }, 'idle');
  assert.equal(p.active, 'heat'); assert.equal(p.heat, true); assert.equal(p.cool, false);
});

test('supplemental heat stages in on large deficit', () => {
  const p = decide(st(16), sp, 'heat', { supplementalDeltaC: 2 }, 'idle'); // 20-16=4 > 2
  assert.equal(p.heatSupplemental, true);
});

test('heat and cool are never both on (auto)', () => {
  const hot = decide(st(26), sp, 'auto', {}, 'idle');
  assert.equal(hot.cool, true); assert.equal(hot.heat, false);
  const cold = decide(st(17), sp, 'auto', {}, 'idle');
  assert.equal(cold.heat, true); assert.equal(cold.cool, false);
});

test('auto deadband: idle between setpoints', () => {
  const p = decide(st(22), sp, 'auto', { tempBandC: 0.5 }, 'idle');
  assert.equal(p.active, 'idle'); assert.equal(p.heat, false); assert.equal(p.cool, false);
});

test('hysteresis: keep heating until heat setpoint reached', () => {
  const p = decide(st(19.7), sp, 'heat', { tempBandC: 0.5 }, 'heat'); // below 20, was heating
  assert.equal(p.active, 'heat');
  const p2 = decide(st(20.1), sp, 'heat', { tempBandC: 0.5 }, 'heat'); // reached target
  assert.equal(p2.active, 'idle');
});

test('free-cooling uses fans instead of A/C when outdoor is cooler', () => {
  const p = decide(st(26, null, 18), sp, 'cool', { freeCoolingMarginC: 2 }, 'idle');
  assert.equal(p.cool, false); assert.equal(p.fan, true);
});

test('humidify when dry, dehumidify when moist, never both', () => {
  const dry = decide(st(22, 35), sp, 'auto', { humidityTarget: 45, humidityBandPct: 5 }, 'idle');
  assert.equal(dry.humidify, true); assert.equal(dry.dehumidify, false);
  const moist = decide(st(22, 60), sp, 'auto', { humidityTarget: 45, humidityBandPct: 5 }, 'idle');
  assert.equal(moist.dehumidify, true); assert.equal(moist.humidify, false);
});

test('no temperature reading holds heat/cool off but still manages humidity', () => {
  const p = decide(st(null, 30), sp, 'heat', { humidityTarget: 45 }, 'idle');
  assert.equal(p.heat, false); assert.equal(p.humidify, true);
});

// --- seasonal changeover (the "don't heat in summer" logic) ---
const season = { season: 'auto' as const, changeoverTempC: 16, seasonDeadbandC: 3 };

test('SUMMER: room below setpoint but hot outside → heat locked out, idle (no baseboard)', () => {
  // 70°F room (21.1°C), target heat 22 / cool 22.2, 100°F outside (37.8°C).
  const p = decide(st(21.1, null, 37.8), { heatC: 22, coolC: 22.2 }, 'auto', season, 'idle');
  assert.equal(p.heat, false);         // never heats in summer
  assert.equal(p.active, 'idle');      // nothing to do until it rises past the cool setpoint
});

test('SUMMER: room above cool setpoint → A/C engages', () => {
  const p = decide(st(24, null, 37.8), { heatC: 22, coolC: 22.2 }, 'auto', season, 'idle');
  assert.equal(p.cool, true); assert.equal(p.heat, false);
});

test('WINTER: room above setpoint but cold outside → cool locked out (no A/C)', () => {
  const p = decide(st(24, null, -5), { heatC: 22, coolC: 22.2 }, 'auto', season, 'idle');
  assert.equal(p.cool, false); assert.equal(p.active, 'idle');
});

test('WINTER: room below heat setpoint → heat engages', () => {
  const p = decide(st(20, null, -5), { heatC: 22, coolC: 22.2 }, 'auto', season, 'idle');
  assert.equal(p.heat, true); assert.equal(p.cool, false);
});

test('explicit HEAT ignores season (user is boss)', () => {
  const p = decide(st(20, null, 37.8), { heatC: 22, coolC: 24 }, 'heat', season, 'idle');
  assert.equal(p.heat, true); // hot outside, but user forced heat
});

test('shoulder season allows both', () => {
  const cold = decide(st(20, null, 16), { heatC: 22, coolC: 24 }, 'auto', season, 'idle');
  assert.equal(cold.heat, true);
  const warm = decide(st(25, null, 16), { heatC: 22, coolC: 24 }, 'auto', season, 'idle');
  assert.equal(warm.cool, true);
});

// --- delegate-don't-force: allow flags arm regulating devices; setpoints carried through ---
test('delegate: allow flags + setpoints exposed for regulating devices', () => {
  const p = decide(st(22), sp, 'auto', {}, 'idle'); // deadband, but both systems permitted
  assert.equal(p.allowHeat, true); assert.equal(p.allowCool, true);
  assert.equal(p.heatSetpointC, 20); assert.equal(p.coolSetpointC, 24);
  assert.equal(p.heat, false); assert.equal(p.cool, false); // no dumb demand in the deadband
});

test('SUMMER (Cool mode): heat disallowed so heat devices are turned off', () => {
  const p = decide(st(18), sp, 'cool', {}, 'idle'); // cold room, but cooling-only
  assert.equal(p.allowHeat, false); // Mysa gets set OFF
  assert.equal(p.allowCool, true);
});

test('regulating devices stay armed even when the room sensor blips', () => {
  const p = decide(st(null), sp, 'cool', {}, 'idle'); // no reading
  assert.equal(p.allowCool, true);   // A/C still armed at its setpoint (it self-regulates)
  assert.equal(p.coolSetpointC, 24);
  assert.equal(p.cool, false);       // but no dumb bang-bang without a reading
});

// --- independent, year-round layers (purify / fresh-air), not season- or temp-gated ---
test('purify runs year-round when on, stops when the thermostat is off', () => {
  assert.equal(decide(st(22), sp, 'auto', {}, 'idle').purify, true);   // default on
  assert.equal(decide(st(22), sp, 'auto', {}, 'idle').freshAir, false); // opt-in
  assert.equal(decide(st(22), sp, 'off', {}, 'idle').purify, false);    // off = everything off
  assert.equal(decide(st(22), sp, 'cool', { purify: false }, 'idle').purify, false); // can disable
});

test('fresh-air is opt-in and independent of season/temperature', () => {
  const p = decide(st(null, null, 37.8), sp, 'auto', { freshAir: true, season: 'cooling' }, 'idle');
  assert.equal(p.freshAir, true);  // runs even with no reading, hot outside, cooling season
  assert.equal(p.purify, true);
});
