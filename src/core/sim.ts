import type { Graph } from './graph';
import { DEFAULT_TRAIN, speedForDistance, tractionAccel, type TrainParams } from './physics';

/** Детерминированный ГСЧ (mulberry32). */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type SimEvent =
  | { t: number; type: 'arrive'; train: string; station: string; edge: string; error: number }
  | { t: number; type: 'depart'; train: string; station: string }
  | { t: number; type: 'finish'; train: string };

export interface SimOptions {
  seed?: number;
  /** Шаг, с. */
  dt?: number;
  /** Стоянка на станции, с (базовая). */
  dwell?: number;
  /** Разброс стоянки ±, с. */
  dwellJitter?: number;
  train?: TrainParams;
}

interface Stop {
  station: string;
  edge: string;
  /** Смещение точки остановки вдоль маршрута, м. */
  s: number;
}

type Phase = 'dwell' | 'run' | 'done';

export class TrainState {
  /** Положение головы поезда вдоль маршрута, м. */
  pos = 0;
  speed = 0;
  phase: Phase = 'dwell';
  dwellLeft = 0;
  nextStop = 0;
  /** Текущее ограничение скорости, м/с (для проверок). */
  limit = 0;
  readonly starts: number[] = [];
  readonly stops: Stop[] = [];
  total = 0;

  constructor(
    readonly id: string,
    readonly route: string[],
    readonly params: TrainParams,
  ) {}

  /** Участок, на котором находится голова. */
  headEdge(): string {
    let idx = 0;
    for (let i = 0; i < this.starts.length; i++) if ((this.starts[i] as number) <= this.pos) idx = i;
    return this.route[idx] as string;
  }
}

/** Симуляция с фиксированным шагом. Ядро без DOM. */
export class Sim {
  t = 0;
  readonly events: SimEvent[] = [];
  readonly trains: TrainState[] = [];
  readonly dt: number;
  private readonly rng: () => number;
  private readonly dwell: number;
  private readonly jitter: number;
  private readonly defaults: TrainParams;

  constructor(
    readonly graph: Graph,
    opts: SimOptions = {},
  ) {
    this.rng = createRng(opts.seed ?? 1);
    this.dt = opts.dt ?? 0.05;
    this.dwell = opts.dwell ?? 30;
    this.jitter = opts.dwellJitter ?? 5;
    this.defaults = opts.train ?? DEFAULT_TRAIN;
  }

  /**
   * Добавить поезд на маршрут `route` (список участков). Голова стоит
   * в первой точке остановки первого участка и начинает со стоянки.
   */
  addTrain(id: string, route: string[], params: TrainParams = this.defaults): TrainState {
    const tr = new TrainState(id, route, params);
    let acc = 0;
    for (const eid of route) {
      tr.starts.push(acc);
      acc += this.graph.edge(eid).length;
    }
    tr.total = acc;
    for (const st of this.graph.stations) {
      for (const stop of st.stops) {
        const i = route.indexOf(stop.edge);
        if (i >= 0) tr.stops.push({ station: st.id, edge: stop.edge, s: (tr.starts[i] as number) + stop.at });
      }
    }
    tr.stops.sort((a, b) => a.s - b.s);
    const initial = tr.stops.find((s) => s.edge === route[0]);
    if (!initial) throw new Error(`Маршрут ${id} не начинается на станции`);
    tr.pos = initial.s;
    tr.nextStop = tr.stops.indexOf(initial) + 1;
    tr.dwellLeft = this.dwellTime();
    tr.limit = this.graph.edge(route[0] as string).limit;
    this.trains.push(tr);
    return tr;
  }

  private dwellTime(): number {
    return this.dwell + (this.rng() * 2 - 1) * this.jitter;
  }

  /** Ограничение для тела поезда: минимум по участкам под составом. */
  private bodyLimit(tr: TrainState): number {
    const tail = tr.pos - tr.params.lengthM;
    let lim = Infinity;
    for (let i = 0; i < tr.route.length; i++) {
      const s0 = tr.starts[i] as number;
      const e = this.graph.edge(tr.route[i] as string);
      if (s0 > tr.pos) break;
      if (s0 + e.length >= tail) lim = Math.min(lim, e.limit);
    }
    return lim;
  }

  step(): void {
    const dt = this.dt;
    for (const tr of this.trains) this.stepTrain(tr, dt);
    this.t += dt;
  }

  runUntil(time: number): void {
    while (this.t < time) this.step();
  }

  private stepTrain(tr: TrainState, dt: number): void {
    if (tr.phase === 'done') return;
    const p = tr.params;
    if (tr.phase === 'dwell') {
      tr.dwellLeft -= dt;
      if (tr.dwellLeft > 0) return;
      if (tr.nextStop > tr.stops.length) {
        tr.phase = 'done';
        this.events.push({ t: this.t, type: 'finish', train: tr.id });
        return;
      }
      tr.phase = 'run';
      const prev = tr.stops[tr.nextStop - 1];
      if (prev) this.events.push({ t: this.t, type: 'depart', train: tr.id, station: prev.station });
    }

    // Ограничение под составом сейчас.
    tr.limit = Math.min(this.bodyLimit(tr), p.maxSpeed);
    let allowed = tr.limit;
    const brake = p.serviceDecel * 0.85; // запас на дискретизацию
    // Ограничения впереди (с учётом длины состава: новое ограничение действует, пока хвост не съехал).
    for (let i = 0; i < tr.route.length; i++) {
      const s0 = tr.starts[i] as number;
      if (s0 <= tr.pos) continue;
      const lim = this.graph.edge(tr.route[i] as string).limit;
      allowed = Math.min(allowed, speedForDistance(s0 - tr.pos, lim, brake));
    }
    // Остановка на ближайшей станции / в конце маршрута.
    const stop = tr.stops[tr.nextStop];
    const target = stop ? stop.s : tr.total;
    const dStop = target - tr.pos;
    allowed = Math.min(allowed, speedForDistance(dStop, 0, brake));

    let v = tr.speed;
    if (v < allowed) v = Math.min(allowed, v + tractionAccel(p, v) * dt);
    else v = Math.max(allowed, v - p.serviceDecel * dt);

    tr.pos += ((tr.speed + v) / 2) * dt;
    tr.speed = v;

    if (target - tr.pos <= 0.3 && tr.speed < 1) {
      const error = target - tr.pos;
      tr.pos = target;
      tr.speed = 0;
      if (stop) {
        tr.nextStop += 1;
        tr.phase = 'dwell';
        tr.dwellLeft = this.dwellTime();
        this.events.push({ t: this.t, type: 'arrive', train: tr.id, station: stop.station, edge: stop.edge, error });
      } else {
        tr.phase = 'done';
        this.events.push({ t: this.t, type: 'finish', train: tr.id });
      }
    }
  }
}
