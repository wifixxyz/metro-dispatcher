import { describe, expect, it } from 'vitest';
import { runScenario } from './helpers/scenario';

const HOURS = 2.5 * 3600;
const WARMUP = 600;

describe.each([120, 180, 300])('сценарий: интервал %i с, 2.5 ч модельного времени', (iv) => {
  // Без разброса стоянок интервал определяется только интерлокингом и АЛС-АРС.
  const clean = runScenario(() => iv, HOURS, { dwellJitter: 0 });
  // С разбросом стоянок ±5 с проверяем только безопасность.
  const noisy = runScenario(() => iv, HOURS, { dwellJitter: 5, seed: 7 });

  it('выпущено ожидаемое число поездов', () => {
    expect(clean.launched).toBe(Math.floor((HOURS - 1) / iv) + 1);
  });
  for (const [name, r] of [['без разброса', clean], ['с разбросом стоянок', noisy]] as const) {
    it(`${name}: никогда два поезда в одном блок-участке`, () => {
      expect(r.sim.il.violations).toEqual([]);
    });
    it(`${name}: нет конфликтующих маршрутов`, () => {
      expect(r.conflicts).toBe(0);
    });
    it(`${name}: нет дедлока (простой на перегоне < 120 с)`, () => {
      expect(r.maxWait).toBeLessThan(120);
    });
    it(`${name}: скорость в пределах ограничений и кода АЛС-АРС`, () => {
      expect(r.maxOverLimit).toBeLessThanOrEqual(1e-9);
      expect(r.maxOverAllowed).toBeLessThanOrEqual(1e-9);
    });
    it(`${name}: нет экстренных торможений`, () => {
      expect(r.sim.events.filter((e) => e.type === 'emergency')).toEqual([]);
    });
  }
  it('интервал на станциях в пределах ±15% (без разброса стоянок)', () => {
    const dts = clean.intervals.filter((i) => i.t > WARMUP).map((i) => i.dt);
    expect(dts.length).toBeGreaterThan(100);
    expect(Math.min(...dts)).toBeGreaterThanOrEqual(iv * 0.85);
    expect(Math.max(...dts)).toBeLessThanOrEqual(iv * 1.15);
  });
});

describe('смена интервала на ходу 2 → 5 → 2 мин', () => {
  const sched = (t: number) => (t < 2400 ? 120 : t < 4800 ? 300 : 120);
  const r = runScenario(sched, 3 * 3600, { dwellJitter: 0 });
  it('безопасность соблюдена', () => {
    expect(r.sim.il.violations).toEqual([]);
    expect(r.conflicts).toBe(0);
    expect(r.maxWait).toBeLessThan(120);
    expect(r.maxOverLimit).toBeLessThanOrEqual(1e-9);
  });
  it('выпуск следует расписанию на каждом участке', () => {
    const gaps = r.launchTimes.slice(1).map((t, i) => t - (r.launchTimes[i] as number));
    expect(gaps.filter((g) => g < 119.9).length).toBe(0);
    expect(gaps.some((g) => Math.abs(g - 300) < 1)).toBe(true);
    expect(gaps.at(-1)).toBeCloseTo(120, 0);
  });
  it('фактические интервалы на станции после перехода сходятся к заданному', () => {
    // Последние 30 мин — снова 2 мин, ещё через 60 мин после смены (поезд идёт ~55 мин).
    const last = r.intervals.filter((i) => i.key === 'ng/ng-I' && i.t > 4800 + 3600);
    expect(last.length).toBeGreaterThan(3);
    for (const i of last) expect(Math.abs(i.dt - 120)).toBeLessThanOrEqual(120 * 0.15);
  });
});
