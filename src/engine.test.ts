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
