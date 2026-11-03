import { Graph } from '../core/graph';
import { Interlocking } from '../core/interlocking';
import type { LineConfig } from '../lines/schema';
import { buildLayout, pointOnLine } from '../render/layout';

const NS = 'http://www.w3.org/2000/svg';

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

export interface PreviewStats {
  edges: number;
  stations: number;
  signals: number;
  switches: number;
}

/** Предпросмотр линии на схеме: пути, станции, светофоры, стрелки, депо. Бросает ошибку, если схему построить нельзя. */
export function renderPreview(cfg: LineConfig): { svg: SVGSVGElement; stats: PreviewStats } {
  const graph = new Graph(cfg);
  const layout = buildLayout(cfg, graph);
  const il = new Interlocking(graph, cfg.blockLength !== undefined ? { maxBlock: cfg.blockLength } : {});
  const m = 40;
  const { x0, y0, x1, y1 } = layout.bounds;
  const svg = svgEl('svg', { viewBox: `${x0 - m} ${y0 - m} ${x1 - x0 + 2 * m} ${y1 - y0 + 2 * m}`, class: 'preview' });
  svg.dataset['testid'] = 'editor-preview';
  const depot = new Set(cfg.depot ? [cfg.depot.entry, cfg.depot.exit, ...cfg.depot.tracks.map((t) => t.edge)] : []);

  for (const st of layout.stations) {
    const h = layout.trackHalf;
    const fill = '#2a3040';
    if (st.platform === 'island') svg.append(svgEl('rect', { x: st.cx - st.half, y: -h + 4, width: st.half * 2, height: 2 * h - 8, fill }));
    else {
      svg.append(svgEl('rect', { x: st.cx - st.half, y: -h - 9, width: st.half * 2, height: 6, fill }));
      svg.append(svgEl('rect', { x: st.cx - st.half, y: h + 3, width: st.half * 2, height: 6, fill }));
    }
    const t = svgEl('text', { x: st.cx, y: -h - 14, 'text-anchor': 'middle', fill: '#aab2c0', 'font-size': 11 });
    t.textContent = st.name;
    svg.append(t);
  }
  for (const e of graph.edges.values()) {
    const line = layout.lines.get(e.id);
    if (!line) continue;
    svg.append(
      svgEl('polyline', {
        points: line.pts.map((p) => `${p.x},${p.y}`).join(' '),
        fill: 'none',
        stroke: depot.has(e.id) ? '#8a7a4a' : e.track === 'turn' ? '#6b7388' : '#4a5368',
        'stroke-width': 3,
        'stroke-linecap': 'round',
      }),
    );
  }
  let signals = 0;
  for (const b of il.blocks.values()) {
    const line = layout.lines.get(b.edge);
    if (!line) continue;
    const len = graph.edge(b.edge).length;
    const { p, dir } = pointOnLine(line, b.s0 / len);
    svg.append(svgEl('circle', { cx: p.x + dir.y * 7, cy: p.y - dir.x * 7, r: b.controlled ? 3 : 1.8, fill: b.controlled ? '#ff9f43' : '#4cd964' }));
    signals++;
  }
  const sw = il.switchNodes();
  for (const n of sw) {
    const p = layout.nodes.get(n);
    if (p) svg.append(svgEl('circle', { cx: p.x, cy: p.y, r: 6, fill: 'none', stroke: '#5ad19a', 'stroke-width': 1.5 }));
  }
  return { svg, stats: { edges: graph.edges.size, stations: cfg.stations.length, signals, switches: sw.length } };
}
