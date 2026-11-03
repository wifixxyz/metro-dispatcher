import { Dispatcher } from '../../src/core/dispatcher';
import { Graph } from '../../src/core/graph';
import { Sim, type SimOptions } from '../../src/core/sim';
import { NEKRASOVSKAYA } from '../../src/lines';

export interface ModeRunResult {
  sim: Sim;
  disp: Dispatcher;
  maxOverLimit: number;
  maxOverAllowed: number;
  maxWait: number;
  conflicts: number;
  emergencies: number;
  /** Интервалы между прибытиями на одну остановку: время и значение. */
  intervals: { t: number; key: string; dt: number }[];
  /** Момент, когда выпущен последний требуемый состав. */
  filledAt: number;
  required: number;
  active: number;
  /** Время прохождения контрольной точки поездами (для проверки интервала выпуска). */
  passes: number[];
  /** Макс. простой на перегоне по 10-секундным окнам: [время, с]. */
  waits: [number, number][];
  /** Начало установившегося режима: все составы выпущены + 1.25 оборота. */
  steadyAt: number;
}

const lapCache = new Map<string, number>();

export function runMode(
  mode: string,
  interval: (t: number) => number,
  duration: number,
  opts: SimOptions = {},
): ModeRunResult {
  const g = new Graph(NEKRASOVSKAYA);
  const sim = new Sim(g, { seed: 11, ...opts });
  const dkey = mode;
  const disp = new Dispatcher(sim, NEKRASOVSKAYA, {
    mode,
    interval: interval(0),
    ...(lapCache.has(dkey) ? { lapTime: lapCache.get(dkey) as number } : {}),
  });
  lapCache.set(dkey, disp.lapTime);
  const res: ModeRunResult = {
    sim, disp, maxOverLimit: 0, maxOverAllowed: 0, maxWait: 0, conflicts: 0, emergencies: 0,
    intervals: [], filledAt: Infinity, required: 0, active: 0, passes: [], waits: [], steadyAt: Infinity,
  };
  const last = new Map<string, number>();
  let seen = 0;
  while (sim.t < duration) {
    disp.setInterval(interval(sim.t));
    sim.step();
    disp.update();
    let w = 0;
    for (const tr of sim.trains) {
      res.maxOverLimit = Math.max(res.maxOverLimit, tr.speed - tr.limit);
      res.maxOverAllowed = Math.max(res.maxOverAllowed, tr.speed - tr.allowed);
      if (tr.phase === 'run') {
        res.maxWait = Math.max(res.maxWait, tr.waitT);
        w = Math.max(w, tr.waitT);
      }
    }
    if (w > 0 && (res.waits.length === 0 || sim.t - (res.waits.at(-1)?.[0] ?? 0) > 10)) res.waits.push([sim.t, w]);
    if (sim.il.routes.size > 0) res.conflicts += sim.il.conflicts().length;
    for (; seen < sim.events.length; seen++) {
      const e = sim.events[seen];
      if (!e) continue;
      if (e.type === 'arrive') {
        const key = e.edge;
        const prev = last.get(key);
        if (prev !== undefined) res.intervals.push({ t: e.t, key, dt: e.t - prev });
        last.set(key, e.t);
      } else if (e.type === 'emergency') res.emergencies++;
      else if (e.type === 'pass') res.passes.push(e.t);
    }
    if (res.filledAt === Infinity && disp.active >= disp.required && sim.t > 60) {
      res.filledAt = sim.t;
      res.steadyAt = sim.t + 1.25 * disp.lapTime;
    }
  }
  res.required = disp.required;
  res.active = disp.active;
  return res;
}
