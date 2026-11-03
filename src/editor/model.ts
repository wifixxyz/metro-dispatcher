import type { LineConfig } from '../lines/schema';

type Edge = LineConfig['edges'][number];

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}${i}`)) i++;
  return `${base}${i}`;
}

function slug(name: string): string {
  const map: Record<string, string> = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ы: 'y', э: 'e', ю: 'yu', я: 'ya' };
  const s = [...name.toLowerCase()].map((c) => map[c] ?? c).join('').replace(/[^a-z0-9]+/g, '');
  return s.slice(0, 6) || 'st';
}

const takenIds = (cfg: LineConfig): Set<string> =>
  new Set([...cfg.nodes, ...cfg.edges.map((e) => e.id), ...cfg.stations.map((s) => s.id)]);

function edgeOf(cfg: LineConfig, id: string | undefined): Edge | undefined {
  return cfg.edges.find((e) => e.id === id);
}

function trackEdges(cfg: LineConfig, stationId: string): { I: Edge; II: Edge } | undefined {
  const st = cfg.stations.find((s) => s.id === stationId);
  const I = edgeOf(cfg, st?.stops[0]?.edge);
  const II = edgeOf(cfg, st?.stops[1]?.edge);
  return I && II ? { I, II } : undefined;
}

/** Межстанционный перегон по пути I (`from` → `to` станций) и по пути II (обратный). */
function links(cfg: LineConfig, a: string, b: string): { I?: Edge; II?: Edge } {
  const ta = trackEdges(cfg, a);
  const tb = trackEdges(cfg, b);
  if (!ta || !tb) return {};
  const I = cfg.edges.find((e) => e.from === ta.I.to && e.to === tb.I.from);
  const II = cfg.edges.find((e) => e.from === tb.II.to && e.to === ta.II.from);
  return { ...(I ? { I } : {}), ...(II ? { II } : {}) };
}

export interface EditResult {
  cfg: LineConfig;
  /** Что сделано (для сообщения пользователю). */
  note: string;
}

/**
 * Добавить станцию после `afterId` (или в начало, если `afterId` не задан).
 * Перегон между соседями делится пополам; если станция становится крайней — для неё добавляется съезд оборота.
 */
export function addStation(src: LineConfig, name: string, afterId?: string): EditResult {
  const cfg = clone(src);
  const taken = takenIds(cfg);
  const id = uniqueId(slug(name), taken);
  const idx = afterId === undefined ? -1 : cfg.stations.findIndex((s) => s.id === afterId);
  if (afterId !== undefined && idx < 0) throw new Error(`Нет станции ${afterId}`);
  const prev = idx >= 0 ? cfg.stations[idx] : undefined;
  const next = cfg.stations[idx + 1];

  cfg.nodes.push(`${id}-I-in`, `${id}-I-out`, `${id}-II-in`, `${id}-II-out`);
  cfg.edges.push({ id: `${id}-I`, from: `${id}-I-in`, to: `${id}-I-out`, length: 160, speedKmh: 60, track: 'I' });
  cfg.edges.push({ id: `${id}-II`, from: `${id}-II-in`, to: `${id}-II-out`, length: 160, speedKmh: 60, track: 'II' });
  const station = { id, name, platform: 'island' as const, stops: [{ edge: `${id}-I`, at: 150 }, { edge: `${id}-II`, at: 150 }] };
  cfg.stations.splice(idx + 1, 0, station);

  if (prev && next) {
    const l = links(cfg, prev.id, next.id);
    const half = (e: Edge): number => Math.max(400, Math.round(e.length / 2));
    // Путь I: prev → N (прежний перегон, укороченный) и N → next (новый).
    if (l.I) {
      const len = half(l.I);
      cfg.edges.push({ id: `${id}-${next.id}-I`, from: `${id}-I-out`, to: l.I.to, length: len, speedKmh: l.I.speedKmh, track: 'I' });
      l.I.to = `${id}-I-in`;
      l.I.length = len;
    }
    // Путь II: next → N (новый) и N → prev (прежний перегон, укороченный).
    if (l.II) {
      const len = half(l.II);
      cfg.edges.push({ id: `${next.id}-${id}-II`, from: l.II.from, to: `${id}-II-in`, length: len, speedKmh: l.II.speedKmh, track: 'II' });
      l.II.from = `${id}-II-out`;
      l.II.length = len;
    }
    return { cfg, note: `Станция «${name}» добавлена между «${prev.name}» и «${next.name}»` };
  }
  if (prev) {
    // Новый восточный конец: перегон от prev.
    const tp = trackEdges(cfg, prev.id)!;
    cfg.edges.push({ id: `${prev.id}-${id}-I`, from: tp.I.to, to: `${id}-I-in`, length: 1500, speedKmh: 80, track: 'I' });
    cfg.edges.push({ id: `${id}-${prev.id}-II`, from: `${id}-II-out`, to: tp.II.from, length: 1500, speedKmh: 80, track: 'II' });
    return { cfg, note: `Станция «${name}» добавлена в конец линии. Чтобы работать до неё, добавьте режим.` };
  }
  if (next) {
    const tn = trackEdges(cfg, next.id)!;
    cfg.edges.push({ id: `${id}-${next.id}-I`, from: `${id}-I-out`, to: tn.I.from, length: 1500, speedKmh: 80, track: 'I' });
    cfg.edges.push({ id: `${next.id}-${id}-II`, from: tn.II.to, to: `${id}-II-in`, length: 1500, speedKmh: 80, track: 'II' });
    return { cfg, note: `Станция «${name}» добавлена в начало линии. Чтобы работать от неё, добавьте режим.` };
  }
  return { cfg, note: `Станция «${name}» добавлена` };
}

/** Удалить станцию вместе с её путями; соседи соединяются перегоном суммарной длины. */
export function removeStation(src: LineConfig, id: string): EditResult {
  const cfg = clone(src);
  const idx = cfg.stations.findIndex((s) => s.id === id);
  if (idx < 0) throw new Error(`Нет станции ${id}`);
  const st = cfg.stations[idx]!;
  const t = trackEdges(cfg, id)!;
  const prev = cfg.stations[idx - 1];
  const next = cfg.stations[idx + 1];
  const inI = cfg.edges.find((e) => e.to === t.I.from && e.id !== t.I.id && e.track !== 'turn');
  const outI = cfg.edges.find((e) => e.from === t.I.to && e.track !== 'turn' && e.track !== 'depot');
  const inII = cfg.edges.find((e) => e.to === t.II.from && e.track !== 'turn' && e.track !== 'depot' && e.id !== t.II.id);
  const outII = cfg.edges.find((e) => e.from === t.II.to && e.track !== 'turn' && e.track !== 'depot');
  const drop = new Set<string>([t.I.id, t.II.id]);
  // Всё, что цепляется к узлам станции (съезды, депо), удаляется.
  const nodes = new Set([t.I.from, t.I.to, t.II.from, t.II.to]);
  for (const e of cfg.edges) {
    if (e.track === 'turn' || e.track === 'depot') if (nodes.has(e.from) || nodes.has(e.to)) drop.add(e.id);
  }
  if (prev && next && inI && outI) {
    // Сливаем перегоны по пути I в один: prev → next.
    inI.to = outI.to;
    inI.length += outI.length;
    drop.add(outI.id);
    const nid = `${prev.id}-${next.id}-I`;
    if (!takenIds(cfg).has(nid)) {
      if (cfg.depot?.join === inI.id) cfg.depot.join = nid;
      inI.id = nid;
    }
  }
  if (prev && next && inII && outII) {
    outII.from = inII.from;
    outII.length += inII.length;
    drop.add(inII.id);
    const nid = `${next.id}-${prev.id}-II`;
    if (!takenIds(cfg).has(nid)) outII.id = nid;
  }
  if (!(prev && next)) for (const e of [inI, outI, inII, outII]) if (e) drop.add(e.id);
  // Депо, потерявшее станцию, удаляется целиком вместе со своими путями.
  const dep = cfg.depot;
  if (dep && (dep.station === id || drop.has(dep.entry) || drop.has(dep.exit))) {
    for (const e of [dep.entry, dep.exit, ...dep.tracks.map((x) => x.edge)]) drop.add(e);
  }
  cfg.edges = cfg.edges.filter((e) => !drop.has(e.id));
  cfg.nodes = cfg.nodes.filter((n) => cfg.edges.some((e) => e.from === n || e.to === n));
  cfg.stations.splice(idx, 1);
  cfg.modes = (cfg.modes ?? []).filter((m) => m.west !== id && m.east !== id && !drop.has(m.turnEast) && !drop.has(m.turnWest));
  if (cfg.depot && (cfg.depot.station === id || drop.has(cfg.depot.entry) || drop.has(cfg.depot.exit))) delete cfg.depot;
  if (cfg.layout?.nodes) for (const k of Object.keys(cfg.layout.nodes)) if (cfg.layout.nodes[k]!.station === id) delete cfg.layout.nodes[k];
  if (cfg.layout?.bends) for (const k of Object.keys(cfg.layout.bends)) if (cfg.layout.bends[k]!.some((b) => b.station === id)) delete cfg.layout.bends[k];
  return { cfg, note: `Станция «${st.name}» удалена` };
}

export function updateStation(src: LineConfig, id: string, patch: { name?: string; platform?: 'island' | 'shore'; stopAt?: number }): LineConfig {
  const cfg = clone(src);
  const st = cfg.stations.find((s) => s.id === id);
  if (!st) throw new Error(`Нет станции ${id}`);
  if (patch.name !== undefined) st.name = patch.name;
  if (patch.platform !== undefined) st.platform = patch.platform;
  if (patch.stopAt !== undefined) for (const s of st.stops) s.at = patch.stopAt;
  return cfg;
}

export function updateEdge(src: LineConfig, id: string, patch: { length?: number; speedKmh?: number }): LineConfig {
  const cfg = clone(src);
  const e = cfg.edges.find((x) => x.id === id);
  if (!e) throw new Error(`Нет участка ${id}`);
  if (patch.length !== undefined) e.length = patch.length;
  if (patch.speedKmh !== undefined) e.speedKmh = patch.speedKmh;
  delete e.approx;
  return cfg;
}

export function setBlockLength(src: LineConfig, meters: number | undefined): LineConfig {
  const cfg = clone(src);
  if (meters === undefined) delete cfg.blockLength;
  else cfg.blockLength = meters;
  return cfg;
}

/** Добавить режим «западная — восточная»; недостающие съезды оборота создаются. */
export function addMode(src: LineConfig, west: string, east: string): EditResult {
  const cfg = clone(src);
  const tw = trackEdges(cfg, west);
  const te = trackEdges(cfg, east);
  const ws = cfg.stations.find((s) => s.id === west);
  const es = cfg.stations.find((s) => s.id === east);
  if (!tw || !te || !ws || !es) throw new Error('Нужны две существующие станции');
  if (west === east) throw new Error('Оборотные станции должны различаться');
  const ensureTurn = (from: string, to: string, base: string): string => {
    const have = cfg.edges.find((e) => e.from === from && e.to === to);
    if (have) return have.id;
    const id = uniqueId(base, takenIds(cfg));
    cfg.edges.push({ id, from, to, length: 350, speedKmh: 25, track: 'turn', approx: true });
    return id;
  };
  const turnWest = ensureTurn(tw.II.to, tw.I.from, `${west}-turn`);
  const turnEast = ensureTurn(te.I.to, te.II.from, `${east}-turn`);
  const mid = uniqueId(`${west}-${east}`, new Set((cfg.modes ?? []).map((m) => m.id)));
  cfg.modes = [...(cfg.modes ?? []), { id: mid, name: `${ws.name} — ${es.name}`, west, east, turnWest, turnEast }];
  return { cfg, note: `Режим «${ws.name} — ${es.name}» добавлен` };
}

export function removeMode(src: LineConfig, id: string): LineConfig {
  const cfg = clone(src);
  cfg.modes = (cfg.modes ?? []).filter((m) => m.id !== id);
  return cfg;
}

/** Добавить депо у станции: вход с пути II, два… один деповский путь, выход на путь I к следующей станции. */
export function addDepot(src: LineConfig, stationId: string): EditResult {
  const cfg = clone(src);
  if (cfg.depot) throw new Error('Депо уже есть');
  const idx = cfg.stations.findIndex((s) => s.id === stationId);
  const st = cfg.stations[idx];
  const nextSt = cfg.stations[idx + 1];
  const t = trackEdges(cfg, stationId);
  if (!st || !t || !nextSt) throw new Error('Депо ставится у станции, за которой есть следующая');
  const join = links(cfg, stationId, nextSt.id).I;
  if (!join) throw new Error('Нет перегона до следующей станции');
  const taken = takenIds(cfg);
  const a = uniqueId('dep-a', taken);
  const b = uniqueId('dep-b', taken);
  cfg.nodes.push(a, b);
  const mk = (id: string, from: string, to: string, len: number): string => {
    const eid = uniqueId(id, takenIds(cfg));
    cfg.edges.push({ id: eid, from, to, length: len, speedKmh: 25, track: 'depot', approx: true });
    return eid;
  };
  const entry = mk('dep-in', t.II.to, a, 300);
  const tr1 = mk('dep-1', a, b, 250);
  const exit = mk('dep-exit', b, t.I.to, 300);
  cfg.depot = { id: 'depot', name: 'Депо', station: stationId, entry, exit, join: join.id, tracks: [{ edge: tr1, at: 240 }], fleet: 40, approx: true };
  cfg.layout = cfg.layout ?? {};
  cfg.layout.nodes = { ...(cfg.layout.nodes ?? {}), [a]: { station: stationId, dx: -110, dy: 90 }, [b]: { station: stationId, dx: 110, dy: 90 } };
  cfg.layout.bends = { ...(cfg.layout.bends ?? {}), [tr1]: [{ station: stationId, dx: 0, dy: 80 }] };
  return { cfg, note: `Депо добавлено у станции «${st.name}»` };
}
