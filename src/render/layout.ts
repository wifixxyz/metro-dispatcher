import type { Graph } from '../core/graph';
import type { TrainState } from '../core/sim';
import type { LineConfig } from '../lines/schema';

export interface Pt {
  x: number;
  y: number;
}

/** Полилиния с накопленными длинами (в единицах схемы). */
export interface Line {
  pts: Pt[];
  cum: number[];
  len: number;
}

export interface StationLayout {
  id: string;
  name: string;
  cx: number;
  platform: 'island' | 'shore';
  /** Полудлина платформы. */
  half: number;
}

export interface LayoutOptions {
  /** Реальные метры: длины платформ и перегонов в масштабе (для 3D). */
  metric?: boolean;
}

export interface Layout {
  stations: StationLayout[];
  nodes: Map<string, Pt>;
  lines: Map<string, Line>;
  bounds: { x0: number; y0: number; x1: number; y1: number };
  /** Половина расстояния между путями I и II. */
  trackHalf: number;
}

const PLATFORM_HALF = 42;
const TRACK_HALF = 14;
const X_SCALE = 0.12;
const MIN_GAP = 120;
const BULGE = 30;

function makeLine(pts: Pt[]): Line {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as Pt;
    const b = pts[i] as Pt;
    cum.push((cum[i - 1] as number) + Math.hypot(b.x - a.x, b.y - a.y));
  }
  return { pts, cum, len: cum[cum.length - 1] as number };
}

/** Квадратичная кривая через заданную среднюю точку. */
function curve(a: Pt, via: Pt, b: Pt, n = 12): Pt[] {
  const cx = 2 * via.x - (a.x + b.x) / 2;
  const cy = 2 * via.y - (a.y + b.y) / 2;
  const res: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    res.push({ x: u * u * a.x + 2 * u * t * cx + t * t * b.x, y: u * u * a.y + 2 * u * t * cy + t * t * b.y });
  }
  return res;
}

/** Схема линии: станции слева направо, путь I сверху (на восток), путь II снизу. */
export function buildLayout(cfg: LineConfig, graph: Graph, opts: LayoutOptions = {}): Layout {
  const metric = opts.metric === true;
  const trackHalf = metric ? 5 : TRACK_HALF;
  const bulge = metric ? 45 : BULGE;
  const nodes = new Map<string, Pt>();
  const stations: StationLayout[] = [];
  // Расстояние между станциями — по длине первого перегона между ними.
  let x = 0;
  for (let i = 0; i < cfg.stations.length; i++) {
    const st = cfg.stations[i]!;
    const eI0 = st.stops[0] ? graph.edge(st.stops[0].edge) : undefined;
    const half = metric && eI0 ? eI0.length / 2 : PLATFORM_HALF;
    if (i > 0) {
      const prevI = cfg.stations[i - 1]!.stops[0]?.edge;
      const thisI = st.stops[0]?.edge;
      const a = prevI ? graph.edge(prevI) : undefined;
      const b = thisI ? graph.edge(thisI) : undefined;
      const link = a && b ? graph.next(a.id).find((e) => e.to === b.from) : undefined;
      const prevHalf = stations[i - 1]?.half ?? PLATFORM_HALF;
      x += metric ? prevHalf + (link?.length ?? 1500) + half : Math.max(MIN_GAP + 2 * PLATFORM_HALF, (link?.length ?? 1500) * X_SCALE);
    }
    stations.push({ id: st.id, name: st.name, cx: x, platform: st.platform, half });
    const [eI, eII] = st.stops.map((s) => graph.edge(s.edge));
    if (eI) {
      nodes.set(eI.from, { x: x - half, y: -trackHalf });
      nodes.set(eI.to, { x: x + half, y: -trackHalf });
    }
    if (eII) {
      nodes.set(eII.from, { x: x + half, y: trackHalf });
      nodes.set(eII.to, { x: x - half, y: trackHalf });
    }
  }
  const anchor = (a: { station: string; dx: number; dy: number }): Pt => {
    const st = stations.find((s) => s.id === a.station);
    if (!st) throw new Error(`Схема: нет станции ${a.station}`);
    return { x: st.cx + a.dx, y: a.dy };
  };
  for (const [id, a] of Object.entries(cfg.layout?.nodes ?? {})) nodes.set(id, anchor(a));

  const lines = new Map<string, Line>();
  for (const e of graph.edges.values()) {
    const a = nodes.get(e.from);
    const b = nodes.get(e.to);
    if (!a || !b) throw new Error(`Схема: нет координат узла участка ${e.id}`);
    const bends = cfg.layout?.bends?.[e.id];
    if (bends) {
      lines.set(e.id, makeLine([a, ...bends.map(anchor), b]));
    } else if (e.track === 'turn') {
      // Съезд оборота: дуга вправо у выхода пути I, влево у выхода пути II.
      const dir = a.y < 0 ? 1 : -1;
      const via = { x: (a.x + b.x) / 2 + dir * bulge, y: (a.y + b.y) / 2 };
      lines.set(e.id, makeLine(curve(a, via, b)));
    } else {
      lines.set(e.id, makeLine([a, b]));
    }
  }

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of lines.values()) {
    for (const p of l.pts) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
  }
  return { stations, nodes, lines, bounds: { x0, y0, x1, y1 }, trackHalf };
}

/** Точка линии на доле длины f ∈ [0,1] и направление (единичный вектор). */
export function pointOnLine(line: Line, f: number): { p: Pt; dir: Pt } {
  const target = Math.min(1, Math.max(0, f)) * line.len;
  let i = 1;
  while (i < line.pts.length - 1 && (line.cum[i] as number) < target) i++;
  const a = line.pts[i - 1] as Pt;
  const b = line.pts[i] as Pt;
  const seg = (line.cum[i] as number) - (line.cum[i - 1] as number) || 1;
  const u = (target - (line.cum[i - 1] as number)) / seg;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy) || 1;
  return { p: { x: a.x + dx * u, y: a.y + dy * u }, dir: { x: dx / d, y: dy / d } };
}

/** Часть линии между долями f0 ≤ f1. */
export function sliceLine(line: Line, f0: number, f1: number): Pt[] {
  const a = Math.min(1, Math.max(0, f0)) * line.len;
  const b = Math.min(1, Math.max(0, f1)) * line.len;
  const res: Pt[] = [pointOnLine(line, f0).p];
  for (let i = 1; i < line.pts.length - 1; i++) {
    const c = line.cum[i] as number;
    if (c > a && c < b) res.push(line.pts[i] as Pt);
  }
  res.push(pointOnLine(line, f1).p);
  return res;
}

/** Контур поезда от хвоста к голове в координатах схемы и направление головы. */
export function trainShape(layout: Layout, graph: Graph, tr: TrainState): { pts: Pt[]; dir: Pt } {
  const tail = Math.max(0, tr.pos - tr.params.lengthM);
  const pts: Pt[] = [];
  let dir: Pt = { x: 1, y: 0 };
  for (let i = tr.et; i <= tr.eh; i++) {
    const eid = tr.route[i] as string;
    const len = graph.edge(eid).length;
    const s0 = tr.starts[i] as number;
    const f0 = Math.max(0, tail - s0) / len;
    const f1 = Math.min(len, tr.pos - s0) / len;
    const line = layout.lines.get(eid);
    if (!line) continue;
    const part = sliceLine(line, f0, f1);
    for (const p of part) {
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(last.x - p.x, last.y - p.y) > 1e-6) pts.push(p);
    }
    dir = pointOnLine(line, f1).dir;
  }
  return { pts, dir };
}
