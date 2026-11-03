import { describe, expect, it } from 'vitest';
import { addDepot, addMode, addStation, removeMode, removeStation, setBlockLength, updateEdge, updateStation } from '../src/editor/model';
import { validateLine } from '../src/lines/validate';
import { makeMiniLine } from './helpers/miniLine';

const msgs = (r: { errors: { path: string; message: string }[] }) => r.errors.map((e) => `${e.path}: ${e.message}`);

describe('редактор: правки линии', () => {
  it('станция в середине: линия остаётся валидной и запускается', () => {
    const base = makeMiniLine(4);
    const { cfg } = addStation(base, 'Новая', 's2');
    expect(cfg.stations.map((s) => s.name)).toEqual(['Станция 0', 'Станция 1', 'Станция 2', 'Новая', 'Станция 3']);
    expect(msgs(validateLine(cfg, { smoke: true }))).toEqual([]);
    expect(cfg.nodes.length).toBe(base.nodes.length + 4);
  });
  it('станция между депо и следующей сохраняет контрольный участок депо', () => {
    const { cfg } = addStation(makeMiniLine(4), 'Вставка', 's1');
    expect(cfg.depot!.join).toBe('s1-s2-I');
    expect(msgs(validateLine(cfg, { smoke: true }))).toEqual([]);
  });
  it('станция в конце + режим до неё', () => {
    const added = addStation(makeMiniLine(4), 'Конечная', 's3');
    expect(added.note).toMatch(/добавьте режим/);
    expect(validateLine(added.cfg).ok).toBe(true);
    const m = addMode(added.cfg, 's0', added.cfg.stations.at(-1)!.id);
    expect(m.cfg.modes).toHaveLength(2);
    expect(msgs(validateLine(m.cfg, { smoke: true }))).toEqual([]);
  });
  it('удаление станции в середине склеивает перегоны', () => {
    const base = makeMiniLine(5);
    const { cfg } = removeStation(base, 's3');
    expect(cfg.stations).toHaveLength(4);
    expect(cfg.edges.some((e) => e.id.includes('s3'))).toBe(false);
    expect(cfg.edges.some((e) => e.id === 's2-s4-I')).toBe(true);
    expect(cfg.edges.some((e) => e.id === 's4-s2-II')).toBe(true);
    expect(msgs(validateLine(cfg, { smoke: true }))).toEqual([]);
    const sumBase = base.edges.filter((e) => ['s2-s3-I', 's3-s4-I'].includes(e.id)).reduce((a, e) => a + e.length, 0);
    expect(cfg.edges.find((e) => e.id === 's2-s4-I')!.length).toBe(sumBase);
  });
  it('удаление станции депо убирает депо — это видно как ошибка', () => {
    const { cfg } = removeStation(makeMiniLine(5), 's1');
    expect(cfg.depot).toBeUndefined();
    expect(msgs(validateLine(cfg))).toContain('depot: не задано депо (нужно для выпуска составов)');
    const fixed = addDepot(cfg, 's0');
    expect(msgs(validateLine(fixed.cfg, { smoke: true }))).toEqual([]);
  });
  it('удаление конечной станции вместе с режимом', () => {
    const { cfg } = removeStation(makeMiniLine(5), 's4');
    expect(cfg.modes).toEqual([]);
    expect(msgs(validateLine(cfg)).some((m) => m.includes('не задан ни один режим'))).toBe(true);
    const m = addMode(cfg, 's0', 's3');
    expect(msgs(validateLine(m.cfg, { smoke: true }))).toEqual([]);
  });
  it('правка станции, участка, длины блока', () => {
    let cfg = makeMiniLine(4);
    cfg = updateStation(cfg, 's2', { name: 'Переименована', platform: 'shore', stopAt: 140 });
    expect(cfg.stations[2]).toMatchObject({ name: 'Переименована', platform: 'shore' });
    expect(cfg.stations[2]!.stops.every((s) => s.at === 140)).toBe(true);
    cfg = updateEdge(cfg, 's0-s1-I', { length: 2500, speedKmh: 70 });
    expect(cfg.edges.find((e) => e.id === 's0-s1-I')).toMatchObject({ length: 2500, speedKmh: 70 });
    cfg = setBlockLength(cfg, 300);
    expect(cfg.blockLength).toBe(300);
    expect(msgs(validateLine(cfg, { smoke: true }))).toEqual([]);
    expect(setBlockLength(cfg, undefined).blockLength).toBeUndefined();
    cfg = updateStation(cfg, 's1', { stopAt: 9999 });
    expect(msgs(validateLine(cfg)).join('\n')).toContain('за пределами участка');
  });
  it('режим: добавить и удалить; режим с одинаковыми станциями отклоняется', () => {
    const base = makeMiniLine(5);
    const { cfg } = addMode(base, 's1', 's3');
    expect(cfg.modes!.map((m) => m.id)).toEqual(['all', 's1-s3']);
    expect(msgs(validateLine(cfg, { smoke: true }))).toEqual([]);
    expect(removeMode(cfg, 's1-s3').modes).toHaveLength(1);
    expect(() => addMode(base, 's1', 's1')).toThrow();
  });
  it('исходная линия при правках не меняется', () => {
    const base = makeMiniLine(4);
    const before = JSON.stringify(base);
    addStation(base, 'X', 's1');
    removeStation(base, 's2');
    expect(JSON.stringify(base)).toBe(before);
  });
});
