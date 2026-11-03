import type { SimEvent } from './core/sim';
import type { LineConfig } from './lines/schema';

export interface StationStat {
  id: string;
  name: string;
  /** Прибытия: время и интервал до предыдущего состава на той же платформе. */
  points: { t: number; dt: number }[];
  mean: number;
  min: number;
  max: number;
  count: number;
}

export interface Failure {
  t: number;
  text: string;
}

const KEEP = 400;
/** Простой на перегоне дольше этого считаем сбоем (застревание), с. */
export const STUCK_AFTER = 120;

/** Статистика смены. Считается из событий и состояния ядра — поэтому точно воспроизводится при восстановлении. */
export class Stats {
  private readonly last = new Map<string, number>();
  private readonly byEdge = new Map<string, { t: number; dt: number }[]>();
  readonly fleet: { t: number; active: number; required: number }[] = [];
  /** Прибытия с интервалом больше целевого на 15%. */
  delays = 0;
  arrivals = 0;
  readonly failures: Failure[] = [];
  private readonly stuck = new Set<string>();
  private nextFleet = 0;

  constructor(private readonly cfg: LineConfig) {}

  onEvent(e: SimEvent, interval: number): Failure | undefined {
    if (e.type === 'arrive') {
      const prev = this.last.get(e.edge);
      this.last.set(e.edge, e.t);
      this.arrivals++;
      if (prev === undefined) return undefined;
      const dt = e.t - prev;
      const list = this.byEdge.get(e.edge) ?? [];
      list.push({ t: e.t, dt });
      if (list.length > KEEP) list.shift();
      this.byEdge.set(e.edge, list);
      if (dt > interval * 1.15) this.delays++;
    } else if (e.type === 'emergency') {
      const f = { t: e.t, text: `${e.train}: экстренное торможение перед ${e.block}` };
      this.failures.push(f);
      return f;
    }
    return undefined;
  }

  /** Раз в секунду модельного времени: простои и выборка парка. */
  sample(t: number, active: number, required: number, trains: { id: string; phase: string; waitT: number }[]): Failure | undefined {
    let fresh: Failure | undefined;
    for (const tr of trains) {
      if (tr.phase === 'run' && tr.waitT > STUCK_AFTER) {
        if (!this.stuck.has(tr.id)) {
          this.stuck.add(tr.id);
          fresh = { t, text: `${tr.id}: стоит на перегоне более ${STUCK_AFTER} с` };
          this.failures.push(fresh);
        }
      } else this.stuck.delete(tr.id);
    }
    if (t >= this.nextFleet) {
      this.nextFleet = t + 60;
      this.fleet.push({ t, active, required });
      if (this.fleet.length > 600) this.fleet.shift();
    }
    if (this.failures.length > 200) this.failures.splice(0, this.failures.length - 200);
    return fresh;
  }

  /** Выполнение парка, 0..1: доля времени, когда в работе было не меньше расчётного. */
  fleetFulfilment(): number {
    if (this.fleet.length === 0) return 1;
    let sum = 0;
    for (const f of this.fleet) sum += f.required === 0 ? 1 : Math.min(1, f.active / f.required);
    return sum / this.fleet.length;
  }

  stations(): StationStat[] {
    return this.cfg.stations.map((st) => {
      const points = st.stops.flatMap((s) => this.byEdge.get(s.edge) ?? []).sort((a, b) => a.t - b.t);
      const dts = points.map((p) => p.dt);
      const count = dts.length;
      return {
        id: st.id,
        name: st.name,
        points,
        count,
        mean: count ? dts.reduce((a, b) => a + b, 0) / count : 0,
        min: count ? Math.min(...dts) : 0,
        max: count ? Math.max(...dts) : 0,
      };
    });
  }
}
