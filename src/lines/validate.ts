import type { ZodIssue } from 'zod';
import { Game } from '../game';
import { Graph } from '../core/graph';
import { modeRoutes } from '../core/dispatcher';
import { buildLayout } from '../render/layout';
import { LineConfigSchema, type LineConfig } from './schema';

export interface Problem {
  /** Где: `edges[3].length`, `modes[0]`, `depot` … */
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  config?: LineConfig;
  errors: Problem[];
  warnings: Problem[];
}

const TYPES: Record<string, string> = { string: 'строка', number: 'число', boolean: 'да/нет', array: 'список', object: 'объект' };

function fmtPath(path: PropertyKey[]): string {
  return path.reduce<string>((acc, p) => (typeof p === 'number' ? `${acc}[${p}]` : acc ? `${acc}.${String(p)}` : String(p)), '');
}

/** Понятное сообщение по ошибке схемы (zod). */
export function describeIssue(issue: ZodIssue, raw?: unknown): Problem {
  const path = fmtPath(issue.path) || '(корень)';
  const i = issue as unknown as { code: string; expected?: string; origin?: string; minimum?: number; maximum?: number; input?: unknown; keys?: string[]; values?: unknown[] };
  let message = issue.message;
  if (i.code === 'invalid_type') {
    let v: unknown = raw;
    for (const k of issue.path) v = v !== null && typeof v === 'object' ? (v as Record<PropertyKey, unknown>)[k] : undefined;
    message = v === undefined ? 'нет обязательного поля' : `ожидалось: ${TYPES[i.expected ?? ''] ?? i.expected}`;
  } else if (i.code === 'too_small') {
    message = i.origin === 'number' ? `значение должно быть не меньше ${i.minimum}` : `слишком мало элементов или символов (минимум ${i.minimum})`;
  } else if (i.code === 'too_big') {
    message = `значение должно быть не больше ${i.maximum}`;
  } else if (i.code === 'invalid_value') {
    message = `допустимые значения: ${(i.values ?? []).join(', ')}`;
  } else if (i.code === 'unrecognized_keys') {
    message = `лишние поля: ${(i.keys ?? []).join(', ')}`;
  }
  return { path, message };
}

function dups(ids: string[]): string[] {
  const seen = new Set<string>();
  const res = new Set<string>();
  for (const id of ids) (seen.has(id) ? res : seen).add(id);
  return [...res];
}

/** Смысловые проверки уже разобранной по схеме линии. */
export function checkLine(cfg: LineConfig): { errors: Problem[]; warnings: Problem[] } {
  const errors: Problem[] = [];
  const warnings: Problem[] = [];
  const err = (path: string, message: string): void => void errors.push({ path, message });
  const warn = (path: string, message: string): void => void warnings.push({ path, message });

  for (const d of dups(cfg.nodes)) err('nodes', `повторяется узел «${d}»`);
  for (const d of dups(cfg.edges.map((e) => e.id))) err('edges', `повторяется участок «${d}»`);
  for (const d of dups(cfg.stations.map((s) => s.id))) err('stations', `повторяется станция «${d}»`);
  for (const d of dups((cfg.modes ?? []).map((m) => m.id))) err('modes', `повторяется режим «${d}»`);

  const nodes = new Set(cfg.nodes);
  const edges = new Map(cfg.edges.map((e) => [e.id, e]));
  cfg.edges.forEach((e, i) => {
    for (const end of ['from', 'to'] as const) {
      if (!nodes.has(e[end])) err(`edges[${i}].${end}`, `участок «${e.id}»: нет узла «${e[end]}» в списке nodes`);
    }
    if (e.from === e.to) err(`edges[${i}]`, `участок «${e.id}» начинается и кончается в одном узле`);
    if (e.speedKmh > 120) warn(`edges[${i}].speedKmh`, `участок «${e.id}»: ${e.speedKmh} км/ч — выше возможностей состава (80 км/ч)`);
    if (e.length < 40) warn(`edges[${i}].length`, `участок «${e.id}»: очень короткий (${e.length} м)`);
  });
  const usedStopEdges = new Map<string, string>();
  cfg.stations.forEach((s, i) => {
    if (s.stops.length !== 2) err(`stations[${i}].stops`, `станция «${s.name}»: нужны ровно два пути (I и II), указано ${s.stops.length}`);
    s.stops.forEach((st, j) => {
      const e = edges.get(st.edge);
      if (!e) return err(`stations[${i}].stops[${j}].edge`, `станция «${s.name}»: нет участка «${st.edge}»`);
      if (st.at > e.length) err(`stations[${i}].stops[${j}].at`, `станция «${s.name}»: остановка (${st.at} м) за пределами участка «${e.id}» (${e.length} м)`);
      const other = usedStopEdges.get(st.edge);
      if (other) err(`stations[${i}].stops[${j}].edge`, `участок «${st.edge}» уже занят станцией «${other}»`);
      usedStopEdges.set(st.edge, s.name);
    });
  });

  const track = (station: string, k: 0 | 1) => {
    const e = cfg.stations.find((s) => s.id === station)?.stops[k]?.edge;
    return e ? edges.get(e) : undefined;
  };
  (cfg.modes ?? []).forEach((m, i) => {
    const p = `modes[${i}]`;
    const wI = track(m.west, 0), wII = track(m.west, 1), eI = track(m.east, 0), eII = track(m.east, 1);
    if (!cfg.stations.some((s) => s.id === m.west)) return err(p, `режим «${m.name}»: нет станции «${m.west}»`);
    if (!cfg.stations.some((s) => s.id === m.east)) return err(p, `режим «${m.name}»: нет станции «${m.east}»`);
    if (m.west === m.east) return err(p, `режим «${m.name}»: оборотные станции совпадают`);
    const te = edges.get(m.turnEast);
    const tw = edges.get(m.turnWest);
    if (!te) err(`${p}.turnEast`, `режим «${m.name}»: нет съезда «${m.turnEast}»`);
    else if (eI && eII && (te.from !== eI.to || te.to !== eII.from)) {
      err(`${p}.turnEast`, `режим «${m.name}»: съезд «${te.id}» должен идти от выхода пути I (${eI.to}) ко входу пути II (${eII.from}) станции «${m.east}»`);
    }
    if (!tw) err(`${p}.turnWest`, `режим «${m.name}»: нет съезда «${m.turnWest}»`);
    else if (wI && wII && (tw.from !== wII.to || tw.to !== wI.from)) {
      err(`${p}.turnWest`, `режим «${m.name}»: съезд «${tw.id}» должен идти от выхода пути II (${wII.to}) ко входу пути I (${wI.from}) станции «${m.west}»`);
    }
  });

  if (!cfg.modes || cfg.modes.length === 0) err('modes', 'не задан ни один режим работы (нужен минимум один)');
  const d = cfg.depot;
  if (!d) err('depot', 'не задано депо (нужно для выпуска составов)');
  else {
    const st = cfg.stations.find((s) => s.id === d.station);
    const I = track(d.station, 0), II = track(d.station, 1);
    const entry = edges.get(d.entry), exit = edges.get(d.exit), join = edges.get(d.join);
    if (!st) err('depot.station', `депо: нет станции «${d.station}»`);
    if (!entry) err('depot.entry', `депо: нет участка входа «${d.entry}»`);
    if (!exit) err('depot.exit', `депо: нет участка выхода «${d.exit}»`);
    if (!join) err('depot.join', `депо: нет участка «${d.join}»`);
    if (entry && II && entry.from !== II.to) err('depot.entry', `депо: вход «${entry.id}» должен начинаться у выхода пути II станции «${d.station}» (${II.to})`);
    if (exit && I && exit.to !== I.to) err('depot.exit', `депо: выход «${exit.id}» должен кончаться у выхода пути I станции «${d.station}» (${I.to}) — выпуск только на путь I`);
    if (join && exit && join.from !== exit.to) err('depot.join', `депо: контрольный участок «${join.id}» должен начинаться там, где кончается выход (${exit.to})`);
    d.tracks.forEach((t, i) => {
      const e = edges.get(t.edge);
      if (!e) return err(`depot.tracks[${i}]`, `депо: нет участка «${t.edge}»`);
      if (t.at > e.length) err(`depot.tracks[${i}].at`, `депо: место стоянки за пределами участка «${e.id}»`);
      if (entry && exit && (e.from !== entry.to || e.to !== exit.from)) {
        err(`depot.tracks[${i}]`, `депо: путь «${e.id}» должен идти от конца входа (${entry.to}) к началу выхода (${exit.from})`);
      }
    });
  }

  // Размещение на схеме: у каждого узла участков должны быть координаты.
  if (errors.length === 0) {
    try {
      buildLayout(cfg, new Graph(cfg));
    } catch (e) {
      err('layout', `схема: ${e instanceof Error ? e.message : String(e)}. Задайте координаты узла в layout.nodes`);
    }
  }
  // Маршруты режимов.
  if (errors.length === 0) {
    const used = new Set<string>();
    const g = new Graph(cfg);
    (cfg.modes ?? []).forEach((m, i) => {
      try {
        const r = modeRoutes(g, cfg, m.id);
        for (const e of r.loop) used.add(e);
      } catch (e) {
        err(`modes[${i}]`, `режим «${m.name}»: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
    if (cfg.depot) for (const e of [cfg.depot.entry, cfg.depot.exit, ...cfg.depot.tracks.map((t) => t.edge)]) used.add(e);
    if (errors.length === 0) {
      cfg.edges.forEach((e, i) => {
        if (!used.has(e.id)) warn(`edges[${i}]`, `участок «${e.id}» не используется ни одним режимом`);
      });
    }
  }
  return { errors, warnings };
}

/** Пробный запуск: ядро строит игру и несколько минут модельного времени ведёт составы. */
export function smokeRun(cfg: LineConfig, seconds = 300): Problem | undefined {
  try {
    const g = new Game(cfg, {});
    g.setSpeed(8);
    const end = g.sim.t + seconds;
    while (g.sim.t < end) g.advance(0.5);
    if (g.sim.il.violations.length > 0) return { path: '(запуск)', message: `при пробном запуске нарушена безопасность: ${g.sim.il.violations[0]}` };
    if (g.sim.trains.length === 0) return { path: '(запуск)', message: 'при пробном запуске на линии нет составов' };
    return undefined;
  } catch (e) {
    return { path: '(запуск)', message: `линия не запускается: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Полная проверка произвольных данных: схема, смысл, (по желанию) пробный запуск. */
export function validateLine(raw: unknown, opts: { smoke?: boolean } = {}): ValidationResult {
  const parsed = LineConfigSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((x) => describeIssue(x, raw)), warnings: [] };
  const { errors, warnings } = checkLine(parsed.data);
  if (errors.length === 0 && opts.smoke) {
    const p = smokeRun(parsed.data);
    if (p) errors.push(p);
  }
  return { ok: errors.length === 0, ...(errors.length === 0 ? { config: parsed.data } : {}), errors, warnings };
}

/** Позиция первой синтаксической ошибки JSON (или -1, если текст разбирается). */
export function jsonErrorPos(t: string): number {
  let i = 0;
  const ws = (): void => {
    while (i < t.length && ' \t\r\n'.includes(t[i] as string)) i++;
  };
  const fail = (): never => {
    throw i;
  };
  const str = (): void => {
    if (t[i] !== '"') fail();
    i++;
    while (i < t.length && t[i] !== '"') {
      if (t[i] === '\n') fail();
      i += t[i] === '\\' ? 2 : 1;
    }
    if (t[i] !== '"') fail();
    i++;
  };
  const value = (): void => {
    ws();
    const c = t[i];
    if (c === '{') {
      i++;
      ws();
      if (t[i] === '}') return void i++;
      for (;;) {
        ws();
        str();
        ws();
        if (t[i] !== ':') fail();
        i++;
        value();
        ws();
        if (t[i] === ',') { i++; continue; }
        if (t[i] === '}') return void i++;
        fail();
      }
    } else if (c === '[') {
      i++;
      ws();
      if (t[i] === ']') return void i++;
      for (;;) {
        value();
        ws();
        if (t[i] === ',') { i++; continue; }
        if (t[i] === ']') return void i++;
        fail();
      }
    } else if (c === '"') str();
    else {
      const m = /^(-?\d+(\.\d+)?([eE][+-]?\d+)?|true|false|null)/.exec(t.slice(i));
      if (!m) fail();
      i += (m as RegExpExecArray)[0].length;
    }
  };
  try {
    value();
    ws();
    if (i < t.length) fail();
    return -1;
  } catch (e) {
    return typeof e === 'number' ? e : -1;
  }
}

/** Разбор текста JSON с понятной ошибкой (с позицией). */
export function parseLineText(text: string, opts: { smoke?: boolean } = {}): ValidationResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const m = /position (\d+)/.exec(msg);
    let where = '';
    const found = m ? Number(m[1]) : jsonErrorPos(text);
    if (found >= 0) {
      const pos = found;
      const before = text.slice(0, pos);
      const line = before.split('\n').length;
      const col = pos - before.lastIndexOf('\n');
      where = ` (строка ${line}, столбец ${col})`;
    }
    return { ok: false, errors: [{ path: '(JSON)', message: `некорректный JSON${where}: ${msg}` }], warnings: [] };
  }
  return validateLine(raw, opts);
}

export function exportLine(cfg: LineConfig): string {
  return JSON.stringify(cfg, null, 1) + '\n';
}
