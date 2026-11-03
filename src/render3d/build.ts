import * as THREE from 'three';
import type { Graph } from '../core/graph';
import type { Interlocking } from '../core/interlocking';
import type { LineConfig } from '../lines/schema';
import { edgePoint, type Layout3d } from './layout3d';

const COLORS = {
  ballast: 0x39404f,
  ballastDim: 0x1c212c,
  rail: 0x9aa3b5,
  deck: 0x3a4252,
  pier: 0x2e3544,
  shell: 0x6b7388,
  platform: 0x4a5368,
  platformDim: 0x262b37,
  roof: 0x2a3040,
  ground: 0x141923,
} as const;

/** Накопитель треугольников для объединённой геометрии (один вызов отрисовки на тип объекта). */
class Mesher {
  pos: number[] = [];
  col: number[] = [];
  idx: number[] = [];

  vertex(x: number, y: number, z: number, c: THREE.Color): number {
    this.pos.push(x, y, z);
    this.col.push(c.r, c.g, c.b);
    return this.pos.length / 3 - 1;
  }

  /** Лента между двумя рядами вершин одинаковой длины. */
  strip(rows: number[][]): void {
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1] as number[];
      const b = rows[i] as number[];
      for (let k = 1; k < a.length; k++) {
        this.idx.push(a[k - 1] as number, b[k - 1] as number, a[k] as number, a[k] as number, b[k - 1] as number, b[k] as number);
      }
    }
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    return g;
  }
}

export interface StaticScene {
  group: THREE.Group;
  /** Блок-участки в порядке экземпляров светофоров. */
  signalBlocks: string[];
  signalLamps: THREE.InstancedMesh;
  /** Подписи станций (для скрытия по расстоянию). */
  labels: { sprite: THREE.Sprite; x: number; y: number; z: number }[];
  stats: { vertices: number; triangles: number; objects: number };
  dispose(): void;
}

function labelSprite(text: string, scale: number): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 96;
  const ctx = c.getContext('2d');
  if (ctx) {
    ctx.fillStyle = 'rgba(11,14,20,0.78)';
    ctx.fillRect(0, 0, 512, 96);
    ctx.fillStyle = '#de64a1';
    ctx.fillRect(0, 0, 10, 96);
    ctx.fillStyle = '#e8ecf3';
    ctx.font = '600 44px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 28, 50, 470);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sp.scale.set(scale, scale * (96 / 512), 1);
  return sp;
}

/** Статическая часть сцены: пути, эстакады, тоннели, станции, депо, светофоры. Читает конфиг и ядро, ничего не меняет. */
export function buildStatic(
  cfg: LineConfig,
  graph: Graph,
  l3: Layout3d,
  il: Interlocking,
  active: Set<string>,
  withLabels = true,
): StaticScene {
  const group = new THREE.Group();
  const disposables: { dispose(): void }[] = [];
  const track = (o: { dispose(): void }): void => void disposables.push(o);
  const bal = new Mesher();
  const deck = new Mesher();
  const shell = new Mesher();
  const railPos: number[] = [];
  const rails: number[][] = [[], []];
  const piers: { x: number; y: number; z: number; h: number }[] = [];
  const cBal = new THREE.Color(COLORS.ballast);
  const cDim = new THREE.Color(COLORS.ballastDim);
  const cDeck = new THREE.Color(COLORS.deck);
  const cShell = new THREE.Color(COLORS.shell);

  for (const e of graph.edges.values()) {
    const line = l3.plan.lines.get(e.id);
    if (!line) continue;
    const kind = l3.structure.get(e.id) ?? 'ground';
    const n = Math.max(2, Math.ceil(line.len / 18));
    const color = active.has(e.id) || kind === 'ground' && e.track === 'depot' ? cBal : cDim;
    const rowsB: number[][] = [];
    const rowsD: number[][] = [];
    const rowsS: number[][] = [];
    let prevPier = -Infinity;
    for (let i = 0; i <= n; i++) {
      const { p, dir } = edgePoint(l3, e.id, i / n);
      const hl = Math.hypot(dir.x, dir.z) || 1;
      const nx = -dir.z / hl;
      const nz = dir.x / hl;
      const at = (w: number, dy: number): number[] => [p.x + nx * w, p.y + dy, p.z + nz * w];
      const bv = (w: number, dy: number): number => {
        const [x, y, z] = at(w, dy) as [number, number, number];
        return bal.vertex(x, y, z, color);
      };
      rowsB.push([bv(-1.7, 0.02), bv(1.7, 0.02)]);
      [-0.72, 0.72].forEach((w, r) => {
        const [x, y, z] = at(w, 0.12) as [number, number, number];
        const arr = rails[r] as number[];
        arr.push(x, y, z);
        if (i > 0 && i < n) arr.push(x, y, z);
      });
      if (kind === 'viaduct') {
        const dv = (w: number, dy: number): number => {
          const [x, y, z] = at(w, dy) as [number, number, number];
          return deck.vertex(x, y, z, cDeck);
        };
        // Балка пролётного строения: верх, низ и боковины в одной ленте.
        rowsD.push([dv(-3.6, -0.2), dv(3.6, -0.2), dv(3.6, -1.8), dv(-3.6, -1.8), dv(-3.6, -0.2)]);
        const dist = i * (line.len / n);
        if (dist - prevPier >= 26 && p.y > 2) {
          piers.push({ x: p.x, y: p.y - 1.8, z: p.z, h: p.y - 1.8 });
          prevPier = dist;
        }
      } else if (kind === 'tunnel') {
        const sv = (w: number, dy: number): number => {
          const [x, y, z] = at(w, dy) as [number, number, number];
          return shell.vertex(x, y, z, cShell);
        };
        const arch: number[] = [];
        for (let k = 0; k <= 8; k++) {
          const a = (Math.PI * k) / 8;
          arch.push(sv(Math.cos(a) * 3.6, Math.sin(a) * 5.4 - 0.1));
        }
        rowsS.push(arch);
      }
    }
    railPos.push(...(rails[0] as number[]), ...(rails[1] as number[]));
    rails[0] = [];
    rails[1] = [];
    bal.strip(rowsB);
    deck.strip(rowsD);
    shell.strip(rowsS);
  }

  const mk = (m: Mesher, mat: THREE.Material): THREE.Mesh | undefined => {
    if (m.idx.length === 0) return undefined;
    const g = m.geometry();
    track(g);
    track(mat);
    const mesh = new THREE.Mesh(g, mat);
    group.add(mesh);
    return mesh;
  };
  mk(bal, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  mk(deck, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  mk(shell, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.2, depthWrite: false }));
  {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(railPos, 3));
    track(g);
    const m = new THREE.LineBasicMaterial({ color: COLORS.rail });
    track(m);
    group.add(new THREE.LineSegments(g, m));
  }

  // Земля: полупрозрачная, чтобы тоннели просматривались.
  const b = l3.plan.bounds;
  const gw = b.x1 - b.x0 + 2000;
  const gd = b.y1 - b.y0 + 2000;
  const gg = new THREE.PlaneGeometry(gw, gd);
  gg.rotateX(-Math.PI / 2);
  const gm = new THREE.MeshBasicMaterial({ color: COLORS.ground, transparent: true, opacity: 0.55, depthWrite: false });
  track(gg);
  track(gm);
  const ground = new THREE.Mesh(gg, gm);
  ground.position.set((b.x0 + b.x1) / 2, -0.05, (b.y0 + b.y1) / 2);
  group.add(ground);

  // Опоры эстакады.
  if (piers.length > 0) {
    const pg = new THREE.BoxGeometry(1.8, 1, 1.8);
    const pm = new THREE.MeshLambertMaterial({ color: COLORS.pier });
    track(pg);
    track(pm);
    const im = new THREE.InstancedMesh(pg, pm, piers.length);
    const m4 = new THREE.Matrix4();
    piers.forEach((p, i) => {
      m4.compose(new THREE.Vector3(p.x, p.y - p.h / 2, p.z), new THREE.Quaternion(), new THREE.Vector3(1, p.h, 1));
      im.setMatrixAt(i, m4);
    });
    group.add(im);
  }

  // Станции: платформы (островные / береговые — по конфигу), навесы и колонны.
  const labels: StaticScene['labels'] = [];
  const slabs: { x: number; y: number; z: number; sx: number; sy: number; sz: number; dim: boolean }[] = [];
  const roofs: typeof slabs = [];
  const columns: { x: number; y: number; z: number; h: number }[] = [];
  const T = l3.plan.trackHalf;
  for (const st of l3.plan.stations) {
    const sc = cfg.stations.find((s) => s.id === st.id);
    const eI = sc?.stops[0] ? graph.edge(sc.stops[0].edge) : undefined;
    if (!eI) continue;
    const h = l3.heights.get(eI.id)?.[0] ?? 0;
    const dim = !active.has(eI.id);
    const len = st.half * 2;
    const kind = l3.structure.get(eI.id) ?? 'ground';
    if (st.platform === 'island') slabs.push({ x: st.cx, y: h + 0.5, z: 0, sx: len, sy: 1, sz: T * 2 - 3.2, dim });
    else {
      slabs.push({ x: st.cx, y: h + 0.5, z: -(T + 1.6 + 2), sx: len, sy: 1, sz: 4, dim });
      slabs.push({ x: st.cx, y: h + 0.5, z: T + 1.6 + 2, sx: len, sy: 1, sz: 4, dim });
    }
    if (kind !== 'tunnel') {
      const span = st.platform === 'island' ? T * 2 + 4 : (T + 1.6 + 4) * 2;
      roofs.push({ x: st.cx, y: h + 5.2, z: 0, sx: len, sy: 0.3, sz: span, dim });
      for (let k = 0; k <= 5; k++) {
        const x = st.cx - st.half + 8 + ((len - 16) * k) / 5;
        const zs = st.platform === 'island' ? [0] : [-(T + 1.6 + 2), T + 1.6 + 2];
        for (const z of zs) columns.push({ x, y: h + 2.6, z, h: 5.2 });
      }
    }
    if (withLabels) {
      const sp = labelSprite(st.name, 70);
      sp.position.set(st.cx, h + 15, 0);
      group.add(sp);
      labels.push({ sprite: sp, x: st.cx, y: h + 15, z: 0 });
      track(sp.material);
      track((sp.material as THREE.SpriteMaterial).map as THREE.Texture);
    }
  }
  const boxes = (items: typeof slabs, color: number, dimColor: number, opacity = 1): void => {
    if (items.length === 0) return;
    const g = new THREE.BoxGeometry(1, 1, 1);
    const m = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: opacity < 1, opacity });
    track(g);
    track(m);
    const im = new THREE.InstancedMesh(g, m, items.length);
    const m4 = new THREE.Matrix4();
    const c = new THREE.Color();
    items.forEach((s, i) => {
      m4.compose(new THREE.Vector3(s.x, s.y, s.z), new THREE.Quaternion(), new THREE.Vector3(s.sx, s.sy, s.sz));
      im.setMatrixAt(i, m4);
      im.setColorAt(i, c.set(s.dim ? dimColor : color));
    });
    group.add(im);
  };
  boxes(slabs, COLORS.platform, COLORS.platformDim);
  boxes(roofs, COLORS.roof, COLORS.platformDim, 0.75);
  if (columns.length > 0) {
    boxes(columns.map((c) => ({ x: c.x, y: c.y, z: c.z, sx: 0.5, sy: c.h, sz: 0.5, dim: false })), COLORS.pier, COLORS.pier);
  }

  // Депо: ангар над деповскими путями.
  if (cfg.depot) {
    const ids = [cfg.depot.entry, cfg.depot.exit, ...cfg.depot.tracks.map((t) => t.edge)];
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const id of ids) {
      for (const p of l3.plan.lines.get(id)?.pts ?? []) {
        x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.y); z1 = Math.max(z1, p.y);
      }
    }
    if (Number.isFinite(x0)) {
      const g = new THREE.BoxGeometry(1, 1, 1);
      const m = new THREE.MeshLambertMaterial({ color: COLORS.roof, transparent: true, opacity: 0.55 });
      track(g);
      track(m);
      const shed = new THREE.Mesh(g, m);
      shed.position.set((x0 + x1) / 2, 4, (z0 + z1) / 2);
      shed.scale.set(Math.max(40, x1 - x0), 0.5, Math.max(30, z1 - z0));
      group.add(shed);
      if (withLabels) {
        const sp = labelSprite(cfg.depot.name, 60);
        sp.position.set((x0 + x1) / 2, 14, (z0 + z1) / 2);
        group.add(sp);
        labels.push({ sprite: sp, x: (x0 + x1) / 2, y: 14, z: (z0 + z1) / 2 });
        track(sp.material);
        track((sp.material as THREE.SpriteMaterial).map as THREE.Texture);
      }
    }
  }

  // Светофоры: столб и лампа на входе в каждый блок-участок активной части.
  const sig: { x: number; y: number; z: number; id: string }[] = [];
  for (const blk of il.blocks.values()) {
    if (!active.has(blk.edge)) continue;
    const len = graph.edge(blk.edge).length;
    const { p, dir } = edgePoint(l3, blk.edge, blk.s0 / len);
    const hl = Math.hypot(dir.x, dir.z) || 1;
    sig.push({ x: p.x + (dir.z / hl) * 2.7, y: p.y, z: p.z - (dir.x / hl) * 2.7, id: blk.id });
  }
  const poleG = new THREE.BoxGeometry(0.18, 4.2, 0.18);
  const poleM = new THREE.MeshLambertMaterial({ color: 0x59627a });
  const lampG = new THREE.SphereGeometry(0.42, 6, 4);
  const lampM = new THREE.MeshBasicMaterial({ color: 0xffffff });
  track(poleG);
  track(poleM);
  track(lampG);
  track(lampM);
  const poles = new THREE.InstancedMesh(poleG, poleM, Math.max(1, sig.length));
  const lamps = new THREE.InstancedMesh(lampG, lampM, Math.max(1, sig.length));
  const m4 = new THREE.Matrix4();
  const c0 = new THREE.Color(0x4cd964);
  sig.forEach((s, i) => {
    m4.makeTranslation(s.x, s.y + 2.1, s.z);
    poles.setMatrixAt(i, m4);
    m4.makeTranslation(s.x, s.y + 4.4, s.z);
    lamps.setMatrixAt(i, m4);
    lamps.setColorAt(i, c0);
  });
  poles.count = sig.length;
  lamps.count = sig.length;
  group.add(poles, lamps);

  let vertices = 0;
  let triangles = 0;
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const g = mesh.geometry as THREE.BufferGeometry | undefined;
    if (!g) return;
    const inst = (o as THREE.InstancedMesh).isInstancedMesh ? (o as THREE.InstancedMesh).count : 1;
    vertices += (g.getAttribute('position')?.count ?? 0) * inst;
    triangles += ((g.index?.count ?? (g.getAttribute('position')?.count ?? 0)) / 3) * inst;
  });
  return {
    group,
    signalBlocks: sig.map((s) => s.id),
    signalLamps: lamps,
    labels,
    stats: { vertices, triangles: Math.round(triangles), objects: group.children.length },
    dispose: () => {
      for (const d of disposables) d.dispose();
      lamps.dispose();
      poles.dispose();
    },
  };
}
