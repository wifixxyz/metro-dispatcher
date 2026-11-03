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
  | { t: number; type: 'depart'; train: string; station: string; edge: string }
  | { t: number; type: 'pass'; train: string; edge: string }
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

export interface Stop {
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
  starts: number[] = [];
  stops: Stop[] = [];
  total = 0;
  /** Индексы участков маршрута под головой и под хвостом. */
  eh = 0;
  et = 0;
  /** Блок-участки вдоль маршрута и занимаемый диапазон [lo..hi]. */
  pb: PathBlock[] = [];
  lo = 0;
  hi = 0;
  /** Разрешённая скорость на шаге (с учётом АЛС-АРС и остановок), м/с. */
  allowed = 0;
  /** Время подряд без движения на перегоне, с. */
  waitT = 0;
  emergency = false;
  /** Игрок задержал поезд на станции. */
  hold = false;
  /** Игрок велел отправить поезд сейчас (без ожидания стоянки и удержания). */
  send = false;

  constructor(
    readonly id: string,
    public route: string[],
    readonly params: TrainParams,
  ) {}

  /** Участок, на котором находится голова. */
  headEdge(): string {
    return this.route[this.eh] as string;
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
  /** Решение «можно ли отправить поезд со станции» (регулировка интервала). */
  /** Множитель стоянки на станции (догон отставания). */
  dwellScale: ((tr: TrainState, stop: Stop, t: number) => number) | undefined;
  gate: ((tr: TrainState, stop: Stop, t: number) => boolean) | undefined;
  /** Участки, вход на которые порождает событие `pass`. */
  readonly watch = new Set<string>();
  /** Узлы, где маршруты ставит только игрок. */
  readonly manualNodes = new Set<string>();

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

  /** Пересчитать накопленные смещения, остановки и блок-участки маршрута. */
  private build(tr: TrainState): void {
    tr.starts = [];
    let acc = 0;
    for (const eid of tr.route) {
      tr.starts.push(acc);
      acc += this.graph.edge(eid).length;
    }
    tr.total = acc;
    tr.stops = [];
    for (let i = 0; i < tr.route.length; i++) {
      const eid = tr.route[i] as string;
      for (const st of this.graph.stations) {
        for (const stop of st.stops) {
          if (stop.edge === eid) tr.stops.push({ station: st.id, edge: eid, s: (tr.starts[i] as number) + stop.at });
        }
      }
    }
    tr.stops.sort((a, b) => a.s - b.s);
    tr.pb = this.il.pathBlocks(tr.route);
  }

  /**
   * Сменить маршрут поезда на ходу. Пройденная часть (до участка под головой включительно)
   * должна совпадать со старой.
   */
  setRoute(tr: TrainState, route: string[]): void {
    for (let i = 0; i <= tr.eh; i++) {
      if (route[i] !== tr.route[i]) throw new Error(`Маршрут ${tr.id}: изменена пройденная часть`);
    }
    tr.route = route;
    this.build(tr);
    tr.nextStop = tr.stops.filter((s) => s.s <= tr.pos + 0.5).length;
  }

  /**
   * Добавить поезд на маршрут `route` (список участков). Без `startAt` голова стоит
   * в первой точке остановки первого участка и начинает со стоянки; с `startAt` —
   * на указанном смещении первого участка (депо, перегон).
   */
  addTrain(id: string, route: string[], params: TrainParams = this.defaults, startAt?: number): TrainState {
    const tr = new TrainState(id, [...route], params);
    this.build(tr);
    if (startAt !== undefined) {
      tr.pos = startAt;
      tr.nextStop = tr.stops.filter((s) => s.s <= tr.pos + 0.5).length;
    } else {
      const initial = tr.stops.find((s) => s.edge === route[0]);
      if (!initial) throw new Error(`Маршрут ${id} не начинается на станции`);
      tr.pos = initial.s;
      tr.nextStop = tr.stops.indexOf(initial) + 1;
    }
    tr.dwellLeft = this.dwellTime();
    tr.limit = this.graph.edge(route[0] as string).limit;
    const tail = Math.max(0, tr.pos - params.lengthM);
    tr.lo = tr.pb.findIndex((b) => b.s1 > tail);
    for (let i = 0; i < tr.pb.length; i++) if ((tr.pb[i] as PathBlock).s0 <= tr.pos) tr.hi = i;
    for (let i = tr.lo; i <= tr.hi; i++) this.il.occupy((tr.pb[i] as PathBlock).block.id, id);
    this.advanceEdges(tr);
    this.trains.push(tr);
    return tr;
  }

  /** Убрать завершившие поезда из списка. */
  prune(): TrainState[] {
    const gone = this.trains.filter((t) => t.phase === 'done');
    if (gone.length > 0) {
      const keep = this.trains.filter((t) => t.phase !== 'done');
      this.trains.length = 0;
      this.trains.push(...keep);
    }
    return gone;
  }

  private advanceEdges(tr: TrainState): void {
    const n = tr.route.length;
    while (tr.eh + 1 < n && (tr.starts[tr.eh + 1] as number) <= tr.pos) tr.eh++;
    const tail = tr.pos - tr.params.lengthM;
    while (tr.et < tr.eh && (tr.starts[tr.et + 1] as number) <= tail) tr.et++;
  }

  private dwellTime(): number {
    return this.dwell + (this.rng() * 2 - 1) * this.jitter;
  }

  /** Ограничение для тела поезда: минимум по участкам под составом. */
  private bodyLimit(tr: TrainState): number {
    let lim = Infinity;
    for (let i = tr.et; i <= tr.eh; i++) lim = Math.min(lim, this.graph.edge(tr.route[i] as string).limit);
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
      this.advanceEdges(tr);
    }
  }

  private updateOccupancy(tr: TrainState): void {
    const pb = tr.pb;
    while (tr.hi + 1 < pb.length && (pb[tr.hi + 1] as PathBlock).s0 <= tr.pos) {
      tr.hi++;
      const nb = (pb[tr.hi] as PathBlock).block;
      this.il.occupy(nb.id, tr.id);
      if (nb.index === 0 && this.watch.has(nb.edge)) this.events.push({ t: this.t, type: 'pass', train: tr.id, edge: nb.edge });
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
    if (!pb.block.controlled || this.il.permits(pb.block.id, tr.id)) return false;
    if (this.manualNodes.has(pb.block.fromNode)) return true;
    if (pb.s0 - tr.pos > 700) return true;
    // Не резервируем стрелку заранее, если до неё ещё остановка: иначе замок висит всю стоянку.
    const stop = tr.stops[tr.nextStop];
    if (stop && stop.s < pb.s0 - 1) return true;
    // Автомат замыкает маршрут через светофор: достаточно первого блок-участка за ним
    // (стрелка замыкается на его входе, дальше поезд защищён занятостью).
    const ids = [pb.block.id];
    return !this.il.setRoute(`${tr.id}@${Math.round(pb.s0)}`, ids, tr.id).ok;
  }

  private stepTrainInner(tr: TrainState, dt: number): void {
    const p = tr.params;
    if (tr.phase === 'dwell') {
      if (tr.send) tr.dwellLeft = 0;
      else tr.dwellLeft -= dt;
      if (tr.dwellLeft > 0) return;
      if (tr.hold) return;
      if (tr.nextStop > tr.stops.length) {
        tr.phase = 'done';
        this.events.push({ t: this.t, type: 'finish', train: tr.id });
        return;
      }
      const prev = tr.stops[tr.nextStop - 1];
      if (prev && !tr.send && this.gate && !this.gate(tr, prev, this.t)) {
        tr.dwellLeft = 0;
        return;
      }
      tr.phase = 'run';
      tr.send = false;
      if (prev) this.events.push({ t: this.t, type: 'depart', train: tr.id, station: prev.station, edge: prev.edge });
    }

    // Ограничение под составом сейчас.
    tr.limit = Math.min(this.bodyLimit(tr), p.maxSpeed);
    let allowed = tr.limit;
    const brake = p.serviceDecel * 0.85; // запас на дискретизацию
    // Ограничения впереди (с учётом длины состава: новое ограничение действует, пока хвост не съехал).
    for (let i = tr.eh + 1; i < tr.route.length; i++) {
      const s0 = tr.starts[i] as number;
      if (s0 - tr.pos > 600) break;
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
        tr.dwellLeft = this.dwellTime() * (this.dwellScale ? this.dwellScale(tr, stop, this.t) : 1);
        this.events.push({ t: this.t, type: 'arrive', train: tr.id, station: stop.station, edge: stop.edge, error });
      } else {
        tr.phase = 'done';
        this.events.push({ t: this.t, type: 'finish', train: tr.id });
      }
    }
  }
}
