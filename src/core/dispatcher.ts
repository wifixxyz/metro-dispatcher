import type { Graph } from './graph';
import { Sim, type SimEvent, type TrainState } from './sim';
import type { DepotConfig, LineConfig, ModeConfig } from '../lines/schema';

export interface ModeRoutes {
  mode: ModeConfig;
  /** Путь I западной станции (откуда начинается круг). */
  westI: string;
  /** Один круг: западная I → восточная I → съезд → восточная II → западная II → съезд. */
  loop: string[];
  /** То же без последнего съезда (для разового пробега). */
  oneWay: string[];
}

function trackEdges(cfg: LineConfig, station: string): { I: string; II: string } {
  const st = cfg.stations.find((s) => s.id === station);
  const I = st?.stops[0]?.edge;
  const II = st?.stops[1]?.edge;
  if (!I || !II) throw new Error(`Станция ${station}: нужны пути I и II`);
  return { I, II };
}

export function getMode(cfg: LineConfig, id: string): ModeConfig {
  const m = cfg.modes?.find((x) => x.id === id);
  if (!m) throw new Error(`Нет режима ${id}`);
  return m;
}

/** Маршрут круга для режима. */
export function modeRoutes(graph: Graph, cfg: LineConfig, modeId: string): ModeRoutes {
  const mode = getMode(cfg, modeId);
  const w = trackEdges(cfg, mode.west);
  const e = trackEdges(cfg, mode.east);
  const toEast = graph.findPath(w.I, e.I);
  const toWest = graph.findPath(e.II, w.II);
  const oneWay = [...toEast, mode.turnEast, ...toWest];
  return { mode, westI: w.I, loop: [...oneWay, mode.turnWest], oneWay };
}

/** Маршрут выпуска из депо: деповский путь → выход → дальше по кругу режима до восточной конечной. */
export function depotRoute(graph: Graph, cfg: LineConfig, depot: DepotConfig, r: ModeRoutes, trackIdx: number): string[] {
  const track = depot.tracks[trackIdx % depot.tracks.length];
  if (!track) throw new Error('В депо нет путей');
  const e = trackEdges(cfg, r.mode.east);
  const toEast = graph.findPath(depot.join, e.I);
  const i = r.loop.indexOf(e.I);
  return [track.edge, depot.exit, ...toEast, ...r.loop.slice(i + 1), ...r.loop];
}

/** Ориентировочное время от выпуска из депо до контрольной точки, с. */
const EXIT_TIME = 80;
/** Минимальная доля обычной стоянки при догоне отставания. */
const MIN_DWELL_SCALE = 0.4;

export interface DispatcherStatus {
  /** Составов в работе (не возвращающихся в депо). */
  active: number;
  /** Расчётный парк при заданном интервале. */
  required: number;
  /** Не хватает составов (если парк депо исчерпан). */
  missing: number;
  /** Составов в депо. */
  inDepot: number;
}

export interface DispatcherOptions {
  mode: string;
  /** Целевой интервал, с. */
  interval: number;
  /** Период принятия решений, с. */
  tick?: number;
  /** Оборотное время, с (если не задано — измеряется пробным прогоном). */
  lapTime?: number;
}

/** Пробный прогон одного поезда по кругу: оборотное время режима, с. */
export function measureLap(graph: Graph, cfg: LineConfig, modeId: string, simOpts: { dwell?: number } = {}): number {
  const r = modeRoutes(graph, cfg, modeId);
  const sim = new Sim(graph, { dwellJitter: 0, ...simOpts });
  sim.addTrain('probe', [...r.loop, ...r.loop]);
  const key = r.westI;
  const departs: number[] = [];
  let seen = 0;
  while (departs.length < 2 && sim.t < 4 * 3600) {
    sim.step();
    for (; seen < sim.events.length; seen++) {
      const ev = sim.events[seen] as SimEvent;
      if (ev.type === 'depart' && ev.edge === key) departs.push(ev.t);
    }
  }
  if (departs.length < 2) throw new Error(`Режим ${modeId}: круг не замкнулся`);
  return (departs[1] as number) - (departs[0] as number);
}

/**
 * Автодиспетчер: считает парк, выпускает составы из депо в безопасные окна,
 * возвращает лишние, держит интервал отправлением не раньше чем через `interval`.
 */
export class Dispatcher {
  readonly routes: ModeRoutes;
  readonly depot: DepotConfig;
  interval: number;
  readonly lapTime: number;
  private readonly tickLen: number;
  private nextTick = 0;
  private seen = 0;
  private spawned = 0;
  private lastSpawn = -Infinity;
  private lastPass = -Infinity;
  private trackToggle = 0;
  private readonly baseDwell = 30;
  private exitDelay = EXIT_TIME;
  private readonly spawnedAt = new Map<string, number>();
  private stored: number;
  private readonly lastDepart = new Map<string, number>();
  private readonly returning = new Set<string>();
  readonly spawnLog: { t: number; train: string }[] = [];

  constructor(
    readonly sim: Sim,
    readonly cfg: LineConfig,
    opts: DispatcherOptions,
  ) {
    if (!cfg.depot) throw new Error('В конфиге нет депо');
    this.depot = cfg.depot;
    this.stored = cfg.depot.fleet;
    this.routes = modeRoutes(sim.graph, cfg, opts.mode);
    this.interval = opts.interval;
    this.tickLen = opts.tick ?? 1;
    this.lapTime = opts.lapTime ?? measureLap(sim.graph, cfg, opts.mode);
    sim.watch.add(this.depot.join);
    const before = trackEdges(cfg, this.depot.station).I;
    sim.dwellScale = (_tr, stop, t) => {
      const gap = t - (this.lastDepart.get(stop.edge) ?? -Infinity);
      if (!Number.isFinite(gap)) return 1;
      // Догон: стоим ровно столько, чтобы отправиться через интервал после предыдущего (не меньше 60% стоянки).
      return Math.max(MIN_DWELL_SCALE, Math.min(1, (this.interval - gap) / this.baseDwell));
    };
    sim.gate = (_tr, stop, t) => {
      if (t - (this.lastDepart.get(stop.edge) ?? -Infinity) < this.interval - 1) return false;
      // Перед выходом состава из депо на путь I держим окно в контрольной точке.
      return stop.edge !== before || t - this.effLastPass() >= this.interval - 1;
    };
  }

  /** Последнее (или ожидаемое для только что выпущенного состава) прохождение контрольной точки. */
  private effLastPass(): number {
    return Math.max(this.lastPass, this.lastSpawn + this.exitDelay);
  }

  setInterval(sec: number): void {
    this.interval = sec;
  }

  get required(): number {
    return Math.ceil(this.lapTime / this.interval);
  }

  get active(): number {
    return this.sim.trains.filter((t) => !this.returning.has(t.id)).length;
  }

  status(): DispatcherStatus {
    const required = this.required;
    const active = this.active;
    return { active, required, missing: Math.max(0, required - active - this.stored), inDepot: this.stored };
  }

  /** Вызывать после каждого шага `sim.step()`. */
  update(): void {
    const sim = this.sim;
    for (; this.seen < sim.events.length; this.seen++) {
      const e = sim.events[this.seen] as SimEvent;
      if (e.type === 'depart') this.lastDepart.set(e.edge, e.t);
      else if (e.type === 'pass' && e.edge === this.depot.join) {
        this.lastPass = e.t;
        const born = this.spawnedAt.get(e.train);
        if (born !== undefined) {
          this.exitDelay = e.t - born;
          this.spawnedAt.delete(e.train);
        }
      }
    }
    if (sim.t < this.nextTick) return;
    this.nextTick = sim.t + this.tickLen;
    for (const g of sim.prune()) {
      if (this.returning.delete(g.id)) this.stored++;
    }
    for (const tr of sim.trains) if (!this.returning.has(tr.id)) this.extend(tr);
    const active = this.active;
    const required = this.required;
    if (active > required) this.sendToDepot();
    else if (active < required && this.stored > 0) this.trySpawn();
    // События копятся без ограничений; в долгих прогонах сворачиваем их читателем (this.seen).
  }

  /** Дописать круг, если впереди осталось мало остановок. */
  private extend(tr: TrainState): void {
    if (tr.stops.length - tr.nextStop >= 4) return;
    this.sim.setRoute(tr, [...tr.route, ...this.routes.loop]);
  }

  private trySpawn(): void {
    const sim = this.sim;
    const t = sim.t;
    if (t + this.exitDelay - this.effLastPass() < this.interval) return;
    const route = depotRoute(sim.graph, this.cfg, this.depot, this.routes, this.trackToggle);
    const track = this.depot.tracks[this.trackToggle % this.depot.tracks.length];
    if (!track || !sim.canPlace(route)) {
      this.trackToggle++;
      return;
    }
    const id = `S${++this.spawned}`;
    sim.addTrain(id, route, undefined, track.at);
    this.stored--;
    this.lastSpawn = t;
    this.trackToggle++;
    this.spawnLog.push({ t, train: id });
    this.spawnedAt.set(id, t);
  }

  /** Отправить в депо состав, который раньше всех подойдёт к станции депо по пути II. */
  private sendToDepot(): void {
    const sim = this.sim;
    const II = trackEdges(this.cfg, this.depot.station).II;
    let best: { tr: TrainState; idx: number; dist: number } | undefined;
    for (const tr of sim.trains) {
      if (this.returning.has(tr.id)) continue;
      let idx = -1;
      for (let i = tr.eh + 1; i < tr.route.length; i++) {
        if (tr.route[i] === II) { idx = i; break; }
      }
      if (idx < 0) continue;
      const dist = (tr.starts[idx] as number) - tr.pos;
      if (!best || dist < best.dist) best = { tr, idx, dist };
    }
    if (!best) return;
    const track = this.depot.tracks[this.trackToggle++ % this.depot.tracks.length];
    if (!track) return;
    const route = [...best.tr.route.slice(0, best.idx + 1), this.depot.entry, track.edge];
    sim.setRoute(best.tr, route);
    this.returning.add(best.tr.id);
  }
}
