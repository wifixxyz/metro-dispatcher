import type { LineConfig } from '../../src/lines/schema';

/**
 * Небольшая учебная линия с нуля: n станций, оборот на концах, депо у второй станции.
 * Нужна, чтобы проверять, что ядро запускает любую валидную линию без правок кода.
 */
export function makeMiniLine(n = 4, opts: { link?: number; blockLength?: number } = {}): LineConfig {
  const link = opts.link ?? 1200;
  const ids = Array.from({ length: n }, (_, i) => `s${i}`);
  const nodes: string[] = [];
  const edges: LineConfig['edges'] = [];
  const stations: LineConfig['stations'] = [];
  for (const id of ids) {
    nodes.push(`${id}-I-in`, `${id}-I-out`, `${id}-II-in`, `${id}-II-out`);
    edges.push({ id: `${id}-I`, from: `${id}-I-in`, to: `${id}-I-out`, length: 160, speedKmh: 60, track: 'I' });
    edges.push({ id: `${id}-II`, from: `${id}-II-in`, to: `${id}-II-out`, length: 160, speedKmh: 60, track: 'II' });
    stations.push({
      id,
      name: `Станция ${id.slice(1)}`,
      platform: 'island',
      stops: [{ edge: `${id}-I`, at: 150 }, { edge: `${id}-II`, at: 150 }],
    });
  }
  for (let i = 0; i + 1 < n; i++) {
    const a = ids[i]!;
    const b = ids[i + 1]!;
    edges.push({ id: `${a}-${b}-I`, from: `${a}-I-out`, to: `${b}-I-in`, length: link, speedKmh: 80, track: 'I' });
    edges.push({ id: `${b}-${a}-II`, from: `${b}-II-out`, to: `${a}-II-in`, length: link, speedKmh: 80, track: 'II' });
  }
  const first = ids[0]!;
  const last = ids[n - 1]!;
  edges.push({ id: `${last}-turn`, from: `${last}-I-out`, to: `${last}-II-in`, length: 350, speedKmh: 25, track: 'turn' });
  edges.push({ id: `${first}-turn`, from: `${first}-II-out`, to: `${first}-I-in`, length: 350, speedKmh: 25, track: 'turn' });
  // Депо у станции s1: вход с пути II, выход на путь I.
  const d = ids[1]!;
  const next = ids[2]!;
  nodes.push('dep-a', 'dep-b');
  edges.push({ id: 'dep-in', from: `${d}-II-out`, to: 'dep-a', length: 300, speedKmh: 25, track: 'depot' });
  edges.push({ id: 'dep-1', from: 'dep-a', to: 'dep-b', length: 250, speedKmh: 25, track: 'depot' });
  edges.push({ id: 'dep-exit', from: 'dep-b', to: `${d}-I-out`, length: 300, speedKmh: 25, track: 'depot' });
  return {
    id: 'mini',
    name: 'Учебная линия',
    nodes,
    edges,
    stations,
    modes: [{ id: 'all', name: 'Вся линия', west: first, east: last, turnWest: `${first}-turn`, turnEast: `${last}-turn` }],
    depot: {
      id: 'dep', name: 'Депо', station: d, entry: 'dep-in', exit: 'dep-exit', join: `${d}-${next}-I`,
      tracks: [{ edge: 'dep-1', at: 240 }], fleet: 20,
    },
    layout: {
      nodes: { 'dep-a': { station: d, dx: -100, dy: 90 }, 'dep-b': { station: d, dx: 100, dy: 90 } },
      bends: { 'dep-1': [{ station: d, dx: 0, dy: 80 }] },
    },
    ...(opts.blockLength !== undefined ? { blockLength: opts.blockLength } : {}),
  };
}
