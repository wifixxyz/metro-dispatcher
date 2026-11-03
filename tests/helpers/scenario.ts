import { Graph } from '../../src/core/graph';
import { Sim, type SimOptions, type TrainState } from '../../src/core/sim';
import { NEKRASOVSKAYA } from '../../src/lines';

export interface ScenarioResult {
  sim: Sim;
  launched: number;
  launchTimes: number[];
  /** Макс. превышение статического ограничения, м/с. */
  maxOverLimit: number;
  /** Макс. превышение кода АЛС-АРС на шаге, м/с. */
  maxOverAllowed: number;
  /** Макс. время простоя на перегоне, с. */
  maxWait: number;
  conflicts: number;
  /** Интервалы между прибытиями по (станция/путь), с, с временем прибытия. */
  intervals: { t: number; key: string; dt: number }[];
}

/**
 * Прогон: поезда выпускаются с Некрасовки I пути по расписанию `interval(t)`.
 * Каждый идёт до Некрасовки II пути (один оборот) и уходит с линии.
 */
export function runScenario(
  interval: (t: number) => number,
  duration: number,
  opts: SimOptions = {},
): ScenarioResult {
  const g = new Graph(NEKRASOVSKAYA);
  const sim = new Sim(g, { seed: 42, ...opts });
  const route = g.findPath('nk-I', 'nk-II');
  const launchTimes: number[] = [];
  let next = 0;
  let n = 0;
  const res: ScenarioResult = {
    sim, launched: 0, launchTimes, maxOverLimit: 0, maxOverAllowed: 0, maxWait: 0, conflicts: 0, intervals: [],
  };
  const lastArrive = new Map<string, number>();
  let seen = 0;
  const live: TrainState[] = [];
  while (sim.t < duration) {
    if (sim.t >= next && sim.canPlace(route)) {
      live.push(sim.addTrain(`T${++n}`, route));
      launchTimes.push(sim.t);
      next = sim.t + interval(sim.t);
    }
    sim.step();
    for (const tr of live) {
      if (tr.phase === 'done') continue;
      res.maxOverLimit = Math.max(res.maxOverLimit, tr.speed - tr.limit);
      res.maxOverAllowed = Math.max(res.maxOverAllowed, tr.speed - tr.allowed);
      if (tr.phase === 'run') res.maxWait = Math.max(res.maxWait, tr.waitT);
    }
    res.conflicts += sim.il.conflicts().length;
    for (; seen < sim.events.length; seen++) {
      const e = sim.events[seen];
      if (e && e.type === 'arrive') {
        const key = `${e.station}/${e.edge}`;
        const prev = lastArrive.get(key);
        if (prev !== undefined) res.intervals.push({ t: e.t, key, dt: e.t - prev });
        lastArrive.set(key, e.t);
      }
    }
  }
  res.launched = n;
  return res;
}
