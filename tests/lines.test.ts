import { describe, expect, it } from 'vitest';
import { Game } from '../src/game';
import { NEKRASOVSKAYA } from '../src/lines';
import { exportLine, parseLineText, validateLine } from '../src/lines/validate';
import { makeMiniLine } from './helpers/miniLine';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const msgs = (r: { errors: { path: string; message: string }[] }) => r.errors.map((e) => `${e.path}: ${e.message}`);

describe('проверка линии', () => {
  it('Некрасовская валидна (в том числе пробный запуск)', () => {
    const r = validateLine(clone(NEKRASOVSKAYA), { smoke: true });
    expect(msgs(r)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
  });
  it('учебная линия валидна и запускается ядром без правок кода', () => {
    const cfg = makeMiniLine();
    const r = validateLine(cfg, { smoke: true });
    expect(msgs(r)).toEqual([]);
    const g = new Game(r.config!, {});
    expect(g.mode).toBe('all');
    g.setSpeed(8);
    while (g.sim.t < 3 * 3600) g.advance(0.5);
    expect(g.sim.il.violations).toEqual([]);
    expect(g.status().active).toBe(g.status().required);
    expect(g.stats.arrivals).toBeGreaterThan(100);
    const mean = g.stats.stations().filter((s) => s.count > 5).map((s) => s.mean);
    for (const m of mean) expect(Math.abs(m - g.interval)).toBeLessThan(g.interval * 0.15);
  }, 60000);
  it.each([2, 3, 6])('учебная линия из %i станций запускается', (n) => {
    if (n === 2) return; // для депо у второй станции нужно ≥ 3 станций
    const r = validateLine(makeMiniLine(n, { link: 900 + n * 100, blockLength: 300 }), { smoke: true });
    expect(msgs(r)).toEqual([]);
  });
  it('длина блок-участка из конфига действует', () => {
    const a = new Game(makeMiniLine(4, { blockLength: 250 }), {});
    const b = new Game(makeMiniLine(4), {});
    expect(a.sim.il.blocks.size).toBeGreaterThan(b.sim.il.blocks.size);
  });
});

describe('понятные ошибки', () => {
  it('некорректный JSON — с позицией', () => {
    const r = parseLineText('{\n "id": "x",\n "name": \n}');
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.message).toMatch(/некорректный JSON \(строка \d+, столбец \d+\)/);
  });
  it('нет обязательных полей и неверные типы', () => {
    const r = validateLine({ id: 'x', name: 5 });
    expect(r.ok).toBe(false);
    const m = msgs(r).join('\n');
    expect(m).toContain('name: ожидалось: строка');
    expect(m).toContain('edges: нет обязательного поля');
  });
  it('отрицательная длина участка', () => {
    const c = clone(NEKRASOVSKAYA);
    c.edges[3]!.length = -5;
    expect(msgs(validateLine(c)).join('\n')).toContain('edges[3].length: значение должно быть');
  });
  it('участок с неизвестным узлом', () => {
    const c = clone(NEKRASOVSKAYA);
    c.edges[0]!.to = 'нет-такого';
    expect(msgs(validateLine(c))).toContain('edges[0].to: участок «nk-I»: нет узла «нет-такого» в списке nodes');
  });
  it('остановка за пределами участка, неизвестный участок станции, повторы', () => {
    const c = clone(NEKRASOVSKAYA);
    c.stations[0]!.stops[0]!.at = 9999;
    c.stations[1]!.stops[1]!.edge = 'xx';
    c.nodes.push(c.nodes[0]!);
    const m = msgs(validateLine(c)).join('\n');
    expect(m).toContain('остановка (9999 м) за пределами участка «nk-I»');
    expect(m).toContain('нет участка «xx»');
    expect(m).toContain('повторяется узел');
  });
  it('съезд режима присоединён не туда', () => {
    const c = clone(NEKRASOVSKAYA);
    c.modes![0]!.turnEast = 'ks-turn';
    expect(msgs(validateLine(c)).join('\n')).toMatch(/modes\[0\]\.turnEast: режим «.+»: съезд «ks-turn» должен идти от выхода пути I/);
  });
  it('нет депо / нет режимов', () => {
    const c = clone(NEKRASOVSKAYA);
    delete c.depot;
    c.modes = [];
    const m = msgs(validateLine(c));
    expect(m).toContain('depot: не задано депо (нужно для выпуска составов)');
    expect(m.some((x) => x.startsWith('modes: не задан ни один режим'))).toBe(true);
  });
  it('выход из депо не на путь I', () => {
    const c = makeMiniLine();
    c.edges.find((e) => e.id === 'dep-exit')!.to = 's1-II-in';
    expect(msgs(validateLine(c)).join('\n')).toContain('выпуск только на путь I');
  });
  it('узел без координат на схеме', () => {
    const c = makeMiniLine();
    delete c.layout;
    expect(msgs(validateLine(c)).join('\n')).toMatch(/layout: схема: .*координат/);
  });
  it('предупреждение о неиспользуемом участке; скорость выше возможностей', () => {
    const c = makeMiniLine();
    c.nodes.push('z1', 'z2');
    c.edges.push({ id: 'lonely', from: 'z1', to: 'z2', length: 500, speedKmh: 200 });
    c.layout = { ...c.layout!, nodes: { ...c.layout!.nodes!, z1: { station: 's0', dx: 0, dy: 200 }, z2: { station: 's0', dx: 100, dy: 200 } } };
    const r = validateLine(c);
    expect(r.ok).toBe(true);
    const w = r.warnings.map((x) => x.message).join('\n');
    expect(w).toContain('«lonely» не используется ни одним режимом');
    expect(w).toContain('200 км/ч');
  });
  it('пробный запуск ловит неработоспособную линию', () => {
    const c = makeMiniLine();
    c.depot!.fleet = 1;
    // Один состав на линии — всё равно запускается: ошибок нет.
    expect(validateLine(c, { smoke: true }).ok).toBe(true);
  });
});

describe('импорт и экспорт', () => {
  it('круг: экспорт → импорт даёт ту же линию', () => {
    const text = exportLine(NEKRASOVSKAYA);
    const r = parseLineText(text);
    expect(r.ok).toBe(true);
    expect(r.config).toEqual(NEKRASOVSKAYA);
  });
});
