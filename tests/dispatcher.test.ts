import { describe, expect, it } from 'vitest';
import { Dispatcher, depotRoute, measureLap, modeRoutes } from '../src/core/dispatcher';
import { Graph } from '../src/core/graph';
import { Sim } from '../src/core/sim';
import { NEKRASOVSKAYA } from '../src/lines';
import type { LineConfig } from '../src/lines/schema';
import { runMode } from './helpers/modeRun';

const MODES = ['nk-ng', 'nk-ok', 'nk-ks', 'lh-ng', 'lh-ok', 'lh-ks'];
const graph = () => new Graph(NEKRASOVSKAYA);

describe('режимы и маршруты', () => {
  it('в конфиге 6 режимов', () => {
    expect(NEKRASOVSKAYA.modes?.map((m) => m.id)).toEqual(MODES);
  });
  it.each(MODES)('%s: круг замкнут и непрерывен', (id) => {
    const g = graph();
    const r = modeRoutes(g, NEKRASOVSKAYA, id);
    for (let i = 0; i < r.loop.length; i++) {
      const a = g.edge(r.loop[i] as string);
      const b = g.edge(r.loop[(i + 1) % r.loop.length] as string);
      expect(a.to, `${a.id} → ${b.id}`).toBe(b.from);
    }
  });
  it.each(MODES)('%s: неиспользуемый участок не входит в круг и выпуск из депо', (id) => {
    const g = graph();
    const r = modeRoutes(g, NEKRASOVSKAYA, id);
    const used = new Set([...r.loop, ...depotRoute(g, NEKRASOVSKAYA, NEKRASOVSKAYA.depot!, r, 0)]);
    const [w, e] = id.split('-') as [string, string];
    const order = ['nk', 'lh', 'ud', 'ks', 'se', 'ok', 'st', 'ng'];
    const iw = order.indexOf(w);
    const ie = order.indexOf(e);
    for (const st of order.filter((_, i) => i < iw || i > ie)) {
      expect(used.has(`${st}-I`), `${st}-I`).toBe(false);
      expect(used.has(`${st}-II`), `${st}-II`).toBe(false);
    }
  });
  it('выпуск из депо — только на путь I в сторону конечной', () => {
    const g = graph();
    const r = modeRoutes(g, NEKRASOVSKAYA, 'nk-ng');
    const route = depotRoute(g, NEKRASOVSKAYA, NEKRASOVSKAYA.depot!, r, 1);
    expect(route.slice(0, 3)).toEqual(['dep-2', 'dep-exit', 'lh-ud-I']);
  });
  it('оборотное время растёт с длиной режима', () => {
    const g = graph();
    const lap = (id: string) => measureLap(g, NEKRASOVSKAYA, id);
    expect(lap('lh-ks')).toBeLessThan(lap('lh-ok'));
    expect(lap('lh-ok')).toBeLessThan(lap('lh-ng'));
    expect(lap('nk-ng')).toBeGreaterThan(lap('lh-ng'));
    expect(lap('nk-ng')).toBeGreaterThan(20 * 60);
    expect(lap('nk-ng')).toBeLessThan(90 * 60);
  });
});

describe('расчёт парка и депо', () => {
  it('парк = ceil(оборот / интервал)', () => {
    const sim = new Sim(graph(), { seed: 1 });
    const d = new Dispatcher(sim, NEKRASOVSKAYA, { mode: 'lh-ks', interval: 180, lapTime: 900 });
    expect(d.required).toBe(5);
    d.setInterval(120);
    expect(d.required).toBe(8);
    expect(d.status()).toEqual({ active: 0, required: 8, missing: 3 - 3, inDepot: 60 });
  });
  it('«не хватает», если парк депо меньше расчётного', () => {
    const cfg: LineConfig = { ...NEKRASOVSKAYA, depot: { ...NEKRASOVSKAYA.depot!, fleet: 3 } };
    const sim = new Sim(new Graph(cfg), { seed: 1 });
    const d = new Dispatcher(sim, cfg, { mode: 'lh-ks', interval: 120, lapTime: 900 });
    expect(d.status()).toMatchObject({ required: 8, missing: 5, inDepot: 3 });
    const r = runMode('lh-ks', () => 120, 3000, { seed: 1 });
    expect(r.disp.status().missing).toBe(0);
  });
  it('выпуск из депо не чаще интервала, пока парк набирается', () => {
    const r = runMode('lh-ok', () => 180, 2400);
    const t = r.disp.spawnLog.map((s) => s.t);
    expect(t.length).toBeGreaterThanOrEqual(8);
    for (let i = 1; i < t.length; i++) expect((t[i] as number) - (t[i - 1] as number)).toBeGreaterThanOrEqual(179);
    for (let i = 1; i < r.passes.length; i++) expect((r.passes[i] as number) - (r.passes[i - 1] as number)).toBeGreaterThan(170);
  });
  it('лишние составы возвращаются в депо при росте интервала', () => {
    const r = runMode('lh-ks', (t) => (t < 3000 ? 120 : 300), 3000 + 6000);
    expect(r.disp.required).toBe(Math.ceil(r.disp.lapTime / 300));
    expect(r.disp.active).toBe(r.disp.required);
    expect(r.disp.status().inDepot).toBe(NEKRASOVSKAYA.depot!.fleet - r.disp.required);
    expect(r.sim.il.violations).toEqual([]);
  });
});

describe.each(MODES)('сценарий режима %s, 3 ч, seed 11', (mode) => {
  describe.each([120, 180, 300])('интервал %i с', (iv) => {
    const r = runMode(mode, () => iv, 3 * 3600);
    it('парк набран', () => {
      expect(r.active).toBe(r.required);
      expect(r.disp.status().missing).toBe(0);
    });
    it('никогда два поезда в одном блок-участке; нет конфликтующих маршрутов', () => {
      expect(r.sim.il.violations).toEqual([]);
      expect(r.conflicts).toBe(0);
    });
    it('нет дедлока: простой на перегоне в установившемся режиме < 2 интервала + 2 мин', () => {
      const w = r.waits.filter(([t]) => t > r.steadyAt).map(([, v]) => v);
      expect(Math.max(0, ...w)).toBeLessThan(2 * iv + 120);
      expect(r.maxWait).toBeLessThan(900);
    });
    it('скорость не выше ограничений (и кода АЛС-АРС с допуском 0.05 м/с); нет экстренных торможений', () => {
      expect(r.maxOverLimit).toBeLessThanOrEqual(1e-9);
      expect(r.maxOverAllowed).toBeLessThan(0.05);
      expect(r.emergencies).toBe(0);
    });
    it('интервал на станциях ±15% после выхода на режим', () => {
      const d = r.intervals.filter((i) => i.t > r.steadyAt).map((i) => i.dt);
      expect(d.length).toBeGreaterThan(100);
      expect(Math.min(...d)).toBeGreaterThanOrEqual(iv * 0.85);
      expect(Math.max(...d)).toBeLessThanOrEqual(iv * 1.15);
    });
  });
});

describe('смена интервала на ходу 2 → 5 → 2 мин (режим lh-ks)', () => {
  const sched = (t: number) => (t < 4000 ? 120 : t < 8000 ? 300 : 120);
  const r = runMode('lh-ks', sched, 13000);
  it('безопасность соблюдена', () => {
    expect(r.sim.il.violations).toEqual([]);
    expect(r.conflicts).toBe(0);
    expect(r.emergencies).toBe(0);
    expect(r.maxOverLimit).toBeLessThanOrEqual(1e-9);
  });
  it('на последнем этапе парк и интервал соответствуют 2 мин', () => {
    expect(r.disp.required).toBe(Math.ceil(r.disp.lapTime / 120));
    expect(r.active).toBe(r.required);
    const d = r.intervals.filter((i) => i.t > 11500).map((i) => i.dt);
    expect(d.length).toBeGreaterThan(20);
    expect(Math.min(...d)).toBeGreaterThanOrEqual(120 * 0.85);
    expect(Math.max(...d)).toBeLessThanOrEqual(120 * 1.15);
  });
  it('в середине (5 мин) интервал не короче заданного', () => {
    const d = r.intervals.filter((i) => i.t > 6500 && i.t < 8000).map((i) => i.dt);
    expect(d.length).toBeGreaterThan(20);
    expect(Math.min(...d)).toBeGreaterThanOrEqual(300 * 0.85);
    expect(Math.max(...d)).toBeLessThanOrEqual(300 * 1.15);
  });
});
