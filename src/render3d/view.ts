import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Game } from '../game';
import { buildStatic, type StaticScene } from './build';
import { buildLayout3d, edgePoint, sampleBack, trainPolyline, type Layout3d, type P3 } from './layout3d';
import { Governor } from './quality';

const CARS = 8;
const MAX_TRAINS = 96;
/** Дальше этого расстояния от камеры вагоны не рисуем — остаётся маркер. */
const CAR_LOD = 2600;
const LABEL_LOD = 1300;
const ASPECT_COLOR = { green: 0x4cd964, yellow: 0xf2c94c, 'red-yellow': 0xff9f43, red: 0xff4d4d } as const;

export interface View3dStats {
  frames: number;
  calls: number;
  triangles: number;
  ratio: number;
  avgMs: number;
  carsDrawn: number;
  trainsVisible: number;
  signals: number;
  staticTriangles: number;
  cab: boolean;
  selected: string | null;
}

export interface View3dHooks {
  /** Касание поезда (или пустого места → `undefined`). */
  onSelect(id: string | undefined): void;
}

const UP = new THREE.Vector3(0, 1, 0);

/** 3D-вид: читает конфиг линии и состояние ядра, ничего в ядро не пишет. */
export class View3D {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  private readonly scene = new THREE.Scene();
  private readonly controls: OrbitControls;
  private readonly gov: Governor;
  private game: Game;
  private l3!: Layout3d;
  private stat: StaticScene | undefined;
  private bodies!: THREE.InstancedMesh;
  private bands!: THREE.InstancedMesh;
  private glow!: THREE.Points;
  private markers!: THREE.Points;
  private seenVersion = -1;
  private dirty = true;
  private readonly obs: ResizeObserver;
  private down: { x: number; y: number; t: number } | undefined;
  private readonly cabPos = new THREE.Vector3();
  private readonly cabLook = new THREE.Vector3();
  private cabInit = false;
  frames = 0;
  selected: string | undefined;
  cab = false;
  private carsDrawn = 0;
  private trainsVisible = 0;
  private stationLabels: string[] = [];

  constructor(
    private readonly container: HTMLElement,
    game: Game,
    private readonly hooks: View3dHooks,
  ) {
    this.game = game;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.renderer = new THREE.WebGLRenderer({ antialias: dpr < 1.5, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(dpr);
    this.renderer.setClearColor(0x0b0e14);
    this.renderer.shadowMap.enabled = false;
    container.append(this.renderer.domElement);
    this.renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none';
    this.gov = new Governor(dpr);

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.3, 40000);
    this.scene.fog = new THREE.Fog(0x0b0e14, 2500, 16000);
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.35));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-0.4, 1, 0.6);
    this.scene.add(sun);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.minDistance = 12;
    this.controls.maxDistance = 22000;
    this.controls.maxPolarAngle = Math.PI * 0.97;
    this.controls.screenSpacePanning = true;
    // Жесты: один палец — вращение, два — зум и сдвиг; мышь: левая — вращение, правая — сдвиг, колесо — зум.
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this.controls.addEventListener('change', () => (this.dirty = true));

    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => {
      this.down = { x: e.clientX, y: e.clientY, t: performance.now() };
    });
    el.addEventListener('pointerup', (e) => {
      const d = this.down;
      this.down = undefined;
      if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8 || performance.now() - d.t > 450) return;
      const r = el.getBoundingClientRect();
      this.hooks.onSelect(this.pick(e.clientX - r.left, e.clientY - r.top));
    });

    this.obs = new ResizeObserver(() => this.resize());
    this.obs.observe(container);
    this.build();
    this.resize();
    this.overview(false);
  }

  /** Новая смена или режим: пересобрать сцену. */
  setGame(game: Game): void {
    this.game = game;
    this.selected = undefined;
    this.cab = false;
    this.build();
    this.overview(false);
  }

  private build(): void {
    if (this.stat) {
      this.scene.remove(this.stat.group);
      this.stat.dispose();
    }
    for (const o of [this.bodies, this.bands, this.glow, this.markers] as (THREE.Object3D | undefined)[]) if (o) this.scene.remove(o);
    const { cfg, graph, sim, disp } = this.game;
    this.l3 = buildLayout3d(cfg, graph);
    const active = new Set(disp.routes.loop);
    for (const e of [cfg.depot?.entry, cfg.depot?.exit, ...(cfg.depot?.tracks.map((t) => t.edge) ?? [])]) if (e) active.add(e);
    this.stat = buildStatic(cfg, graph, this.l3, sim.il, active);
    this.scene.add(this.stat.group);
    this.stationLabels = cfg.stations.map((s) => s.name);

    const box = new THREE.BoxGeometry(1, 1, 1);
    this.bodies = new THREE.InstancedMesh(box, new THREE.MeshLambertMaterial({ color: 0xde64a1 }), MAX_TRAINS * CARS);
    this.bands = new THREE.InstancedMesh(box, new THREE.MeshLambertMaterial({ color: 0x1a1f2b }), MAX_TRAINS * CARS);
    this.bodies.frustumCulled = false;
    this.bands.frustumCulled = false;
    this.bodies.count = 0;
    this.bands.count = 0;
    this.scene.add(this.bodies, this.bands);

    const mkPoints = (n: number, mat: THREE.PointsMaterial): THREE.Points => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      g.setDrawRange(0, 0);
      const p = new THREE.Points(g, mat);
      p.frustumCulled = false;
      this.scene.add(p);
      return p;
    };
    this.glow = mkPoints(MAX_TRAINS * 4, new THREE.PointsMaterial({ size: 7, sizeAttenuation: true, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.markers = mkPoints(MAX_TRAINS, new THREE.PointsMaterial({ size: 9, sizeAttenuation: false, vertexColors: true, depthTest: false, transparent: true }));
    this.markers.renderOrder = 10;
    this.seenVersion = -1;
    this.dirty = true;
  }

  resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  /** Камера над западной оборотной станцией режима (`whole` — вся линия режима). */
  overview(whole: boolean): void {
    this.cab = false;
    this.controls.enabled = true;
    const { disp } = this.game;
    const st = this.l3.plan.stations;
    const w = st.find((s) => s.id === disp.routes.mode.west);
    const e = st.find((s) => s.id === disp.routes.mode.east);
    const x0 = w?.cx ?? 0;
    const x1 = e?.cx ?? x0 + 1000;
    const cx = whole ? (x0 + x1) / 2 : x0 + 15;
    const dist = whole ? Math.max(500, Math.abs(x1 - x0) * 0.75) : 230;
    const ty = whole ? 0 : (this.l3.heights.get(this.game.cfg.stations.find((q) => q.id === disp.routes.mode.west)?.stops[0]?.edge ?? '')?.[0] ?? 0);
    this.controls.target.set(cx, ty, 0);
    this.camera.position.set(cx - dist * 0.35, ty + dist * 0.45, dist * 0.8);
    this.controls.update();
    this.dirty = true;
  }

  select(id: string | undefined): void {
    this.selected = id;
    if (!id) this.setCab(false);
    this.dirty = true;
  }

  setCab(on: boolean): void {
    if (on && !this.selected) return;
    this.cab = on;
    this.cabInit = false;
    this.controls.enabled = !on;
    this.camera.fov = on ? 70 : 55;
    this.camera.near = on ? 0.3 : 0.3;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  private headOf(id: string): P3 | undefined {
    const tr = this.game.sim.trains.find((t) => t.id === id && t.phase !== 'done');
    if (!tr) return undefined;
    return trainPolyline(this.l3, this.game.graph, tr).at(-1);
  }

  /** Ближайший к точке касания поезд (до 36 экранных пикселей). */
  private pick(px: number, py: number): string | undefined {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const v = new THREE.Vector3();
    let best: { id: string; d: number } | undefined;
    for (const tr of this.game.sim.trains) {
      if (tr.phase === 'done') continue;
      const head = this.headOf(tr.id);
      if (!head) continue;
      v.set(head.x, head.y + 2, head.z).project(this.camera);
      if (v.z > 1) continue;
      const d = Math.hypot((v.x * 0.5 + 0.5) * w - px, (-v.y * 0.5 + 0.5) * h - py);
      if (d < 36 && (!best || d < best.d)) best = { id: tr.id, d };
    }
    return best?.id;
  }

  hudText(): string {
    if (!this.selected) return '';
    const tr = this.game.sim.trains.find((t) => t.id === this.selected && t.phase !== 'done');
    if (!tr) return '';
    const next = tr.stops[tr.nextStop] ?? tr.stops[tr.nextStop - 1];
    const name = next ? this.game.cfg.stations.find((s) => s.id === next.station)?.name : undefined;
    return `Поезд ${tr.id.replace(/^\D+/, '')} · ${Math.round(tr.speed * 3.6)} км/ч · допустимо ${Math.round(tr.allowed * 3.6)} · ${tr.phase === 'dwell' ? 'стоянка' : 'в пути'}${name ? ` · ${name}` : ''}`;
  }

  private updateSignals(): void {
    const il = this.game.sim.il;
    if (!this.stat) return;
    const c = new THREE.Color();
    this.stat.signalBlocks.forEach((id, i) => {
      this.stat?.signalLamps.setColorAt(i, c.set(ASPECT_COLOR[il.aspectOfBlock(id)]));
    });
    if (this.stat.signalLamps.instanceColor) this.stat.signalLamps.instanceColor.needsUpdate = true;
  }

  /** Один кадр. `paused` — игра на паузе: без изменений камеры можно не перерисовывать. */
  update(frameMs: number, paused: boolean): void {
    const t0 = performance.now();
    const il = this.game.sim.il;
    if (il.version !== this.seenVersion) {
      this.seenVersion = il.version;
      this.updateSignals();
    }
    if (this.cab && this.selected) this.followCab();
    else if (this.controls.enabled) this.controls.update();
    if (paused && !this.dirty && !this.cab) return;
    this.dirty = false;

    this.updateTrains();
    const camPos = this.camera.position;
    for (const l of this.stat?.labels ?? []) {
      l.sprite.visible = Math.hypot(l.x - camPos.x, l.y - camPos.y, l.z - camPos.z) < LABEL_LOD;
    }
    this.renderer.render(this.scene, this.camera);
    this.frames++;
    const next = this.gov.frame(Math.max(frameMs, performance.now() - t0));
    if (next !== undefined) {
      this.renderer.setPixelRatio(next);
      this.resize();
    }
  }

  private updateTrains(): void {
    const { sim, graph } = this.game;
    const bodies = this.bodies;
    const bands = this.bands;
    const m4 = new THREE.Matrix4();
    const x = new THREE.Vector3();
    const y = new THREE.Vector3();
    const z = new THREE.Vector3();
    const pos = new THREE.Vector3();
    const gp = (this.glow.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
    const gc = (this.glow.geometry.getAttribute('color') as THREE.BufferAttribute).array as Float32Array;
    const mp = (this.markers.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
    const mc = (this.markers.geometry.getAttribute('color') as THREE.BufferAttribute).array as Float32Array;
    let bi = 0;
    let gi = 0;
    let ti = 0;
    const cam = this.camera.position;
    for (const tr of sim.trains) {
      if (tr.phase === 'done' || ti >= MAX_TRAINS) continue;
      const pts = trainPolyline(this.l3, graph, tr);
      const head = pts.at(-1);
      if (!head || pts.length < 2) continue;
      const hDist = Math.hypot(head.x - cam.x, head.y - cam.y, head.z - cam.z);
      const sel = tr.id === this.selected;
      // Маркер: виден с любого расстояния.
      mp[ti * 3] = head.x;
      mp[ti * 3 + 1] = head.y + 5;
      mp[ti * 3 + 2] = head.z;
      const mcol = sel ? [1, 1, 1] : [0.87, 0.39, 0.63];
      mc[ti * 3] = mcol[0] as number;
      mc[ti * 3 + 1] = mcol[1] as number;
      mc[ti * 3 + 2] = mcol[2] as number;
      ti++;
      if (hDist > CAR_LOD) continue;
      const carLen = tr.params.lengthM / CARS;
      const skipHead = this.cab && sel;
      for (let k = 0; k < CARS; k++) {
        if (skipHead && k === 0) continue;
        const s = sampleBack(pts, (k + 0.5) * carLen);
        if (!s) continue;
        x.set(s.dir.x, s.dir.y, s.dir.z).normalize();
        z.crossVectors(x, UP).normalize();
        y.crossVectors(z, x).normalize();
        pos.set(s.p.x, s.p.y + 2.2, s.p.z);
        m4.makeBasis(x, y, z).setPosition(pos);
        const body = m4.clone().scale(new THREE.Vector3(carLen - 0.5, 3.4, 2.8));
        bodies.setMatrixAt(bi, body);
        bands.setMatrixAt(bi, m4.clone().scale(new THREE.Vector3(carLen - 1.5, 0.95, 2.86)).setPosition(pos.x, pos.y + 0.35, pos.z));
        bi++;
      }
      // Огни: белые фары спереди, красные сзади.
      const front = sampleBack(pts, 0.5);
      const rear = sampleBack(pts, tr.params.lengthM - 0.5);
      for (const [pt, col] of [[front, [1, 0.95, 0.8]], [rear, [1, 0.1, 0.1]]] as const) {
        if (!pt) continue;
        const nx = -pt.dir.z;
        const nz = pt.dir.x;
        for (const side of [-0.9, 0.9]) {
          gp[gi * 3] = pt.p.x + nx * side;
          gp[gi * 3 + 1] = pt.p.y + 1.4;
          gp[gi * 3 + 2] = pt.p.z + nz * side;
          gc[gi * 3] = col[0];
          gc[gi * 3 + 1] = col[1];
          gc[gi * 3 + 2] = col[2];
          gi++;
        }
      }
    }
    bodies.count = bi;
    bands.count = bi;
    bodies.instanceMatrix.needsUpdate = true;
    bands.instanceMatrix.needsUpdate = true;
    this.glow.geometry.setDrawRange(0, gi);
    (this.glow.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.glow.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    this.markers.geometry.setDrawRange(0, ti);
    (this.markers.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.markers.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    this.carsDrawn = bi;
    this.trainsVisible = ti;
  }

  /** Вид «из кабины»: камера у головы выбранного поезда, плавно следует за ним. */
  private followCab(): void {
    const tr = this.game.sim.trains.find((t) => t.id === this.selected && t.phase !== 'done');
    if (!tr) {
      this.setCab(false);
      return;
    }
    const pts = trainPolyline(this.l3, this.game.graph, tr);
    const s = sampleBack(pts, 0.5);
    if (!s) return;
    const eye = new THREE.Vector3(s.p.x - s.dir.x * 1.5, s.p.y + 3.1, s.p.z - s.dir.z * 1.5);
    const look = new THREE.Vector3(s.p.x + s.dir.x * 80, s.p.y + 2.6 + s.dir.y * 80, s.p.z + s.dir.z * 80);
    if (!this.cabInit) {
      this.cabPos.copy(eye);
      this.cabLook.copy(look);
      this.cabInit = true;
    } else {
      this.cabPos.lerp(eye, 0.5);
      this.cabLook.lerp(look, 0.35);
    }
    this.camera.position.copy(this.cabPos);
    this.camera.lookAt(this.cabLook);
    this.dirty = true;
  }

  /** Поставить камеру на выбранный поезд в обычном режиме (облёт). */
  focusSelected(): void {
    if (!this.selected) return;
    const h = this.headOf(this.selected);
    if (!h) return;
    this.cab = false;
    this.controls.enabled = true;
    this.controls.target.set(h.x, h.y, h.z);
    this.camera.position.set(h.x - 60, h.y + 35, h.z + 70);
    this.controls.update();
    this.dirty = true;
  }

  /** Экранные координаты точки станции (для проверок). */
  stationScreen(id: string): { x: number; y: number } | undefined {
    const st = this.l3.plan.stations.find((s) => s.id === id);
    if (!st) return undefined;
    const v = new THREE.Vector3(st.cx, 0, 0).project(this.camera);
    return { x: (v.x * 0.5 + 0.5) * this.container.clientWidth, y: (-v.y * 0.5 + 0.5) * this.container.clientHeight };
  }

  trainScreen(id: string): { x: number; y: number } | undefined {
    const head = this.headOf(id);
    if (!head) return undefined;
    const v = new THREE.Vector3(head.x, head.y + 2, head.z).project(this.camera);
    return { x: (v.x * 0.5 + 0.5) * this.container.clientWidth, y: (-v.y * 0.5 + 0.5) * this.container.clientHeight };
  }

  stats(): View3dStats {
    const info = this.renderer.info.render;
    return {
      frames: this.frames,
      calls: info.calls,
      triangles: info.triangles,
      ratio: this.gov.ratio,
      avgMs: this.gov.averageMs,
      carsDrawn: this.carsDrawn,
      trainsVisible: this.trainsVisible,
      signals: this.stat?.signalBlocks.length ?? 0,
      staticTriangles: this.stat?.stats.triangles ?? 0,
      cab: this.cab,
      selected: this.selected ?? null,
    };
  }

  /** Точка пути для проверок: высота рельса на доле участка. */
  railHeight(edgeId: string, f: number): number {
    return edgePoint(this.l3, edgeId, f).p.y;
  }

  dispose(): void {
    this.obs.disconnect();
    this.controls.dispose();
    this.stat?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    void this.stationLabels;
  }
}
