import type { Graph } from '../core/graph';
import type { TrainState } from '../core/sim';
import type { LineConfig } from '../lines/schema';
import { buildLayout, pointOnLine, type Layout, type Line } from '../render/layout';

export type Structure = 'tunnel' | 'viaduct' | 'ground';

/** Высота рельсов над землёй, м, для каждого типа сооружения. */
export const LEVEL: Record<Structure, number> = { viaduct: 11, ground: 0, tunnel: -9 };

export interface P3 {
  x: number;
  y: number;
  z: number;
}

export interface Layout3d {
  /** Схема в метрах: x вдоль линии, y (поперёк) → z в 3D. */
  plan: Layout;
  structure: Map<string, Structure>;
  /** Высота начала и конца участка. */
  heights: Map<string, [number, number]>;
}

/** Реальная 3D-геометрия линии из того же конфига. Ядро не используется, кроме графа. */
export function buildLayout3d(cfg: LineConfig, graph: Graph): Layout3d {
  const plan = buildLayout(cfg, graph, { metric: true });
  const structure = new Map<string, Structure>();
  for (const e of cfg.edges) structure.set(e.id, e.structure ?? 'ground');

  // Высоты узлов: платформы плоские; остальные узлы — среднее по примыкающим участкам.
  const nodeH = new Map<string, number>();
  for (const st of cfg.stations) {
    for (const s of st.stops) {
      const e = graph.edge(s.edge);
      const h = LEVEL[structure.get(e.id) ?? 'ground'];
      nodeH.set(e.from, h);
      nodeH.set(e.to, h);
    }
  }
  for (const n of cfg.nodes) {
    if (nodeH.has(n)) continue;
    const hs = [...graph.outEdges(n), ...graph.inEdges(n)].map((e) => LEVEL[structure.get(e.id) ?? 'ground']);
    nodeH.set(n, hs.length ? hs.reduce((a, b) => a + b, 0) / hs.length : 0);
  }
  const heights = new Map<string, [number, number]>();
  for (const e of graph.edges.values()) heights.set(e.id, [nodeH.get(e.from) ?? 0, nodeH.get(e.to) ?? 0]);
  return { plan, structure, heights };
}

const smooth = (t: number): number => t * t * (3 - 2 * t);

/** Высота рельса на доле `f` участка (плавный переход между уровнями). */
export function heightAt(l3: Layout3d, edgeId: string, f: number): number {
  const [h0, h1] = l3.heights.get(edgeId) ?? [0, 0];
  return h0 + (h1 - h0) * smooth(Math.min(1, Math.max(0, f)));
}

/** Точка пути и направление (единичный вектор) на доле `f` участка. */
export function edgePoint(l3: Layout3d, edgeId: string, f: number): { p: P3; dir: P3 } {
  const line = l3.plan.lines.get(edgeId) as Line;
  const { p, dir } = pointOnLine(line, f);
  const y = heightAt(l3, edgeId, f);
  const dy = heightAt(l3, edgeId, Math.min(1, f + 0.01)) - heightAt(l3, edgeId, Math.max(0, f - 0.01));
  const dl = Math.max(1, line.len * 0.02);
  const k = dy / dl;
  const n = Math.hypot(dir.x, k, dir.y) || 1;
  return { p: { x: p.x, y, z: p.y }, dir: { x: dir.x / n, y: k / n, z: dir.y / n } };
}

/**
 * Ломаная состава от хвоста к голове (в метрах, 3D): точки через каждые `step` метров пути.
 * Пустой массив, если состав стоит на участках без геометрии.
 */
export function trainPolyline(l3: Layout3d, graph: Graph, tr: TrainState, step = 12): P3[] {
  const tail = Math.max(0, tr.pos - tr.params.lengthM);
  const pts: P3[] = [];
  for (let i = tr.et; i <= tr.eh; i++) {
    const eid = tr.route[i] as string;
    const len = graph.edge(eid).length;
    const s0 = tr.starts[i] as number;
    const a = Math.max(0, tail - s0);
    const b = Math.min(len, tr.pos - s0);
    if (b < a || !l3.plan.lines.has(eid)) continue;
    const n = Math.max(1, Math.ceil((b - a) / step));
    for (let k = 0; k <= n; k++) {
      const { p } = edgePoint(l3, eid, (a + ((b - a) * k) / n) / len);
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(last.x - p.x, last.y - p.y, last.z - p.z) > 1e-3) pts.push(p);
    }
  }
  return pts;
}

/** Точка и направление на расстоянии `d` метров от головы назад по ломаной (хвост → голова). */
export function sampleBack(pts: P3[], d: number): { p: P3; dir: P3 } | undefined {
  if (pts.length < 2) return undefined;
  let rest = d;
  for (let i = pts.length - 1; i > 0; i--) {
    const a = pts[i - 1] as P3;
    const b = pts[i] as P3;
    const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    if (rest <= len || i === 1) {
      const t = len === 0 ? 0 : Math.max(0, 1 - rest / len);
      const dir = len === 0 ? { x: 1, y: 0, z: 0 } : { x: (b.x - a.x) / len, y: (b.y - a.y) / len, z: (b.z - a.z) / len };
      return { p: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t }, dir };
    }
    rest -= len;
  }
  return undefined;
}
