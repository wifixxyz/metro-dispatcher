import { codeSpeed } from './alsars';
import type { Graph } from './graph';
import { Interlocking, type PathBlock } from './interlocking';
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
  | { t: number; type: 'finish'; train: string }
  | { t: number; type: 'emergency'; train: string; block: string };

export interface SimOptions {
  seed?: number;
  /** Шаг, с. */
  dt?: number;
  /** Стоянка на станции, с (базовая). */
  dwell?: number;
  /** Разброс стоянки ±, с. */
  dwellJitter?: number;
  train?: TrainParams;
  /** Макс. длина блок-участка, м. */
  maxBlock?: number;
  /** Запас до границы разрешённого пути (светофора), м. */
  margin?: number;
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
  /** Блок-участки вдоль маршрута и занимаемый диапазон [lo..hi]. */
  pb: PathBlock[] = [];
  lo = 0;
  hi = 0;
  /** Разрешённая скорость на шаге (с учётом АЛС-АРС и остановок), м/с. */
  allowed = 0;
  /** Время подряд без движения на перегоне, с. */
  waitT = 0;
  emergency = false;

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
  private readonly margin: number;
  readonly il: Interlocking;

  constructor(
    readonly graph: Graph,
    opts: SimOptions = {},
  ) {
    this.rng = createRng(opts.seed ?? 1);
    this.dt = opts.dt ?? 0.05;
    this.dwell = opts.dwell ?? 30;
    this.jitter = opts.dwellJitter ?? 5;
    this.defaults = opts.train ?? DEFAULT_TRAIN;
    this.margin = opts.margin ?? 5;
    this.il = new Interlocking(graph, opts.maxBlock !== undefined ? { maxBlock: opts.maxBlock } : {});
  }

  /** Свободен ли первый блок-участок маршрута для постановки поезда. */
  canPlace(route: string[]): boolean {
    const first = this.il.pathBlocks([route[0] as string])[0];
    return !!first && !this.il.isOccupied(first.block.id);
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
    tr.pb = this.il.pathBlocks(route);
    const tail = Math.max(0, tr.pos - params.lengthM);
    tr.lo = tr.pb.findIndex((b) => b.s1 > tail);
    for (let i = 0; i < tr.pb.length; i++) if ((tr.pb[i] as PathBlock).s0 <= tr.pos) tr.hi = i;
    for (let i = tr.lo; i <= tr.hi; i++) this.il.occupy((tr.pb[i] as PathBlock).block.id, id);
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
    this.il.update(this.t);
  }

  runUntil(time: number): void {
    while (this.t < time) this.step();
  }

  private stepTrain(tr: TrainState, dt: number): void {
    if (tr.phase === 'done') return;
    this.stepTrainInner(tr, dt);
    if ((tr.phase as Phase) === 'done') {
      for (let i = tr.lo; i <= tr.hi; i++) this.il.vacate((tr.pb[i] as PathBlock).block.id, tr.id);
      tr.lo = tr.hi + 1;
    } else {
      this.updateOccupancy(tr);
    }
  }

  private updateOccupancy(tr: TrainState): void {
    const pb = tr.pb;
    while (tr.hi + 1 < pb.length && (pb[tr.hi + 1] as PathBlock).s0 <= tr.pos) {
      tr.hi++;
      this.il.occupy((pb[tr.hi] as PathBlock).block.id, tr.id);
    }
    const tail = tr.pos - tr.params.lengthM;
    while (tr.lo < tr.hi && (pb[tr.lo] as PathBlock).s1 <= tail) {
      this.il.vacate((pb[tr.lo] as PathBlock).block.id, tr.id);
      tr.lo++;
    }
  }

  /** Блок-участок k по ходу поезда недоступен (занят или маршрутный светофор закрыт). */
  private isBlocked(tr: TrainState, k: number): boolean {
    const pb = tr.pb[k] as PathBlock;
    if (this.il.isOccupied(pb.block.id, tr.id)) return true;
    if (!pb.block.controlled || this.il.lockedBy(pb.block.id) === tr.id) return false;
    if (pb.s0 - tr.pos > 700) return true;
    // Автомат ставит маршрут от этого светофора до следующего маршрутного.
    const ids: string[] = [];
    for (let j = k; j < tr.pb.length && ids.length < 4; j++) {
      const b = (tr.pb[j] as PathBlock).block;
      if (j > k && b.controlled) break;
      ids.push(b.id);
    }
    return !this.il.setRoute(`${tr.id}@${pb.block.id}`, ids, tr.id).ok;
  }

  private stepTrainInner(tr: TrainState, dt: number): void {
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
    // АЛС-АРС: границы разрешённого пути и коды скорости по свободным блокам впереди.
    let maEnd = Infinity;
    let blocked = -1;
    for (let k = tr.hi + 1; k < tr.pb.length && k <= tr.hi + 8; k++) {
      if (this.isBlocked(tr, k)) {
        blocked = k;
        maEnd = (tr.pb[k] as PathBlock).s0 - this.margin;
        break;
      }
    }
    for (let k = tr.hi; k < tr.pb.length && k <= tr.hi + 3; k++) {
      const cap = codeSpeed(blocked < 0 ? 99 : Math.max(0, blocked - k - 1));
      if (k === tr.hi) allowed = Math.min(allowed, cap);
      else allowed = Math.min(allowed, speedForDistance((tr.pb[k] as PathBlock).s0 - tr.pos, cap, brake));
    }
    allowed = Math.min(allowed, speedForDistance(maEnd - tr.pos, 0, brake));
    // Остановка на ближайшей станции / в конце маршрута.
    const stop = tr.stops[tr.nextStop];
    const target = stop ? stop.s : tr.total;
    const dStop = target - tr.pos;
    allowed = Math.min(allowed, speedForDistance(dStop, 0, brake));

    tr.allowed = allowed;
    let v = tr.speed;
    if (tr.speed > speedForDistance(maEnd - tr.pos, 0, p.emergencyDecel) + 0.3) {
      // Экстренное торможение: граница пути ближе, чем позволяет служебное.
      v = Math.max(0, v - p.emergencyDecel * dt);
      if (!tr.emergency) {
        tr.emergency = true;
        this.events.push({ t: this.t, type: 'emergency', train: tr.id, block: (tr.pb[blocked] as PathBlock).block.id });
      }
    } else if (v < allowed) {
      tr.emergency = false;
      v = Math.min(allowed, v + tractionAccel(p, v) * dt);
    } else {
      tr.emergency = false;
      v = Math.max(allowed, v - p.serviceDecel * dt);
    }

    tr.pos += ((tr.speed + v) / 2) * dt;
    tr.speed = v;
    if (tr.pos > maEnd) {
      tr.pos = maEnd;
      tr.speed = 0;
    }
    tr.waitT = tr.speed < 0.05 ? tr.waitT + dt : 0;

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
