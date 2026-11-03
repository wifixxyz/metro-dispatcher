import './style.css';
import { Application } from 'pixi.js';
import { Viewport } from 'pixi-viewport';
import { registerSW } from 'virtual:pwa-register';
import { Sound } from './audio/sound';
import { Game } from './game';
import { Haptics } from './haptics/haptics';
import { Storage } from './storage/save';
import { openEditor } from './editor/ui';
import type { View3D } from './render3d/view';
import { NEKRASOVSKAYA } from './lines';
import { validateLine } from './lines/validate';
import { buildLayout } from './render/layout';
import { Scene } from './render/scene';
import { Controller } from './ui/controller';
import { Panel } from './ui/panel';
import { showTourOnce } from './ui/tour';

declare const __APP_VERSION__: string;

interface MetroDebug {
  version: string;
  state(): Record<string, unknown>;
  signalScreen(block: string): { x: number; y: number } | undefined;
  switchScreen(node: string): { x: number; y: number } | undefined;
  focus(node: string, scale: number): void;
  v3TrainScreen(): { id: string; x: number; y: number } | undefined;
  v3Select(id: string): void;
  trainScreen(): { id: string; x: number; y: number } | undefined;
}

async function main(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) throw new Error('Не найден контейнер #app');
  const mapEl = document.createElement('div');
  mapEl.id = 'map';
  root.append(mapEl);

  const storage = new Storage();
  const settings = await storage.loadSettings();
  // Своя линия из редактора (если сохранена и проходит проверку), иначе Некрасовская.
  const customRaw = await storage.loadLine();
  const customCheck = customRaw ? validateLine(customRaw) : undefined;
  const line = customCheck?.ok && customCheck.config ? customCheck.config : NEKRASOVSKAYA;
  if (customRaw && !customCheck?.ok) await storage.clearLine();
  const firstMode = line.modes?.[0]?.id ?? '';
  const sound = new Sound();
  sound.enabled = settings.sound;
  sound.setAmbient(settings.ambient);
  const haptics = new Haptics();
  haptics.enabled = settings.haptics;
  // Звук разрешён браузером только после жеста.
  window.addEventListener('pointerdown', () => sound.unlock(), { capture: true });

  // Продолжение смены после перезапуска: проигрываем сохранённые действия на тех же шагах.
  let game: Game;
  const save = await storage.loadShift();
  const known = save && line.modes?.some((m) => m.id === save.mode);
  if (save && known) {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.dataset['testid'] = 'restoring';
    root.append(overlay);
    try {
      game = await Game.restore(line, save, (f) => {
        overlay.textContent = `Восстановление смены… ${Math.round(f * 100)}%`;
      });
    } catch {
      await storage.clearShift();
      game = new Game(line, { mode: firstMode, interval: 180 });
    }
    overlay.remove();
  } else {
    game = new Game(line, { mode: firstMode, interval: 180 });
  }
  game.onSignal = (s) => {
    if (s.kind === 'switch') sound.play('click', s.player ? 1 : game.speed <= 2 ? 0.3 : 0);
    else if (s.kind === 'route') sound.play('route');
    else if (s.kind === 'alarm') {
      sound.play('alarm');
      haptics.alarm();
    } else if (s.kind === 'action') haptics.tap();
  };
  const saveNow = (): void => {
    void storage.saveShift(game.snapshot()).catch(() => undefined);
  };
  setInterval(saveNow, 2000);
  window.addEventListener('pagehide', saveNow);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveNow();
  });
  const layout = buildLayout(line, game.graph);
  const margin = 40;
  const world = {
    x: layout.bounds.x0 - margin,
    y: layout.bounds.y0 - margin,
    w: layout.bounds.x1 - layout.bounds.x0 + 2 * margin,
    h: layout.bounds.y1 - layout.bounds.y0 + 2 * margin,
  };

  const view3dEl = document.createElement('div');
  view3dEl.id = 'view3d';
  root.append(view3dEl);
  let view: '2d' | '3d' = '2d';
  let v3: View3D | undefined;

  const app = new Application();
  await app.init({
    resizeTo: mapEl,
    background: '#0b0e14',
    antialias: true,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    preference: 'webgl',
  });
  mapEl.append(app.canvas);

  const viewport = new Viewport({
    screenWidth: app.screen.width,
    screenHeight: app.screen.height,
    worldWidth: world.w,
    worldHeight: world.h,
    events: app.renderer.events,
  });
  viewport.drag().pinch().wheel().decelerate();
  viewport.clampZoom({ minScale: 0.15, maxScale: 6 });
  app.stage.addChild(viewport);

  const fit = (): void => {
    // Ширина линии — главный размер; по высоте оставляем место под панели.
    const scale = Math.max(0.1, Math.min(app.screen.width / world.w, app.screen.height / (world.h * 1.4)));
    viewport.setZoom(scale, true);
    viewport.moveCenter(world.x + world.w / 2, world.y + world.h / 2 + 20);
  };
  fit();

  const scene = new Scene(app, viewport, layout, game);
  const panel = new Panel(root, game, {
    onMode(id) {
      game.reset(id);
      scene.setGame(game);
      v3?.setGame(game);
      saveNow();
      panel.setGame(game);
    },
    onSettings(st) {
      sound.setEnabled(st.sound);
      sound.setAmbient(st.ambient);
      haptics.enabled = st.haptics;
      void storage.saveSettings(st);
    },
    onView() {
      void setView(view === '2d' ? '3d' : '2d');
    },
    onCam(kind) {
      if (!v3) return;
      if (kind === 'overview') {
        v3.select(undefined);
        v3.overview(true);
      } else if (kind === 'focus') v3.focusSelected();
      else v3.setCab(!v3.cab);
    },
    onRoute() {
      controller.toggleRouteMode();
    },
    onEditor() {
      openEditor(root, {
        initial: line,
        isDefault: line === NEKRASOVSKAYA,
        onClose: () => undefined,
        onPlay(cfg) {
          void (async () => {
            await storage.saveLine(cfg);
            await storage.clearShift();
            location.reload();
          })();
        },
        onReset() {
          void (async () => {
            await storage.clearLine();
            await storage.clearShift();
            location.reload();
          })();
        },
      });
    },
    onNewShift() {
      game.newShift();
      scene.setGame(game);
      v3?.setGame(game);
      panel.setGame(game);
      saveNow();
    },
    onZoom(kind) {
      if (kind === 'fit') fit();
      else viewport.setZoom(viewport.scale.x * (kind === 'in' ? 1.5 : 1 / 1.5), true);
    },
  }, settings);

  const controller = new Controller(game, scene, panel);
  showTourOnce(root);
  viewport.on('clicked', (e) => controller.tap(scene.hitTest(e.world.x, e.world.y), e.world.x, e.world.y));

  app.renderer.on('resize', (w: number, h: number) => {
    viewport.resize(w, h, world.w, world.h);
  });

  const setView = async (next: '2d' | '3d'): Promise<void> => {
    if (next === '3d' && !v3) {
      panel.showToast('Загрузка 3D…');
      // Three.js подгружается только при первом переключении.
      const { View3D: V } = await import('./render3d/view');
      v3 = new V(view3dEl, game, {
        onSelect(id) {
          v3?.select(id);
          if (id) panel.showToast(`Выбран поезд ${id.replace(/^\D+/, '')}`);
        },
      });
    }
    view = next;
    app.stage.visible = next === '2d';
    panel.setView(next);
    if (next === '3d') v3?.resize();
  };

  app.ticker.add((t) => {
    game.advance(Math.min(t.deltaMS, 100) / 1000);
    if (view === '2d') scene.update();
    else if (v3) {
      v3.update(t.deltaMS, game.paused);
      panel.setHud(v3.hudText(), v3.selected !== undefined && v3.hudText() !== '', v3.cab);
    }
    panel.update();
  });

  const debug: MetroDebug = {
    version: __APP_VERSION__,
    signalScreen: (b) => scene.signalScreen(b),
    switchScreen: (n) => scene.switchScreen(n),
    focus: (n, sc) => scene.focusNode(n, sc),
    v3TrainScreen: () => {
      const tr = game.sim.trains.find((t) => t.phase !== 'done');
      const p = tr && v3 ? v3.trainScreen(tr.id) : undefined;
      return tr && p ? { id: tr.id, ...p } : undefined;
    },
    v3Select: (id) => v3?.select(id),
    trainScreen: () => {
      const tr = game.sim.trains.find((t) => t.phase !== 'done');
      if (!tr) return undefined;
      const p = scene.trainHeadScreen(tr.id);
      return p ? { id: tr.id, ...p } : undefined;
    },
    state: () => ({
      mode: game.mode,
      line: line.id,
      simTime: game.sim.t,
      speed: game.speed,
      paused: game.paused,
      interval: game.interval,
      trains: game.sim.trains.length,
      trainsDrawn: scene.stats.trainsDrawn,
      edgesDrawn: scene.stats.edgesDrawn,
      signalsDrawn: scene.stats.signalsDrawn,
      frames: scene.stats.frames,
      violations: game.sim.il.violations.length,
      manualLine: game.manualLine,
      interventions: game.interventions,
      selected: scene.selected ?? null,
      view,
      v3: v3 ? v3.stats() : null,
      routes: game.sim.il.routes.size,
      scale: viewport.scale.x,
      fitWidth: (world.w * viewport.scale.x) / app.screen.width,
    }),
  };
  (window as unknown as { __metro: MetroDebug }).__metro = debug;
}

main().catch((e: unknown) => {
  const box = document.createElement('pre');
  box.textContent = `Ошибка запуска: ${e instanceof Error ? e.message : String(e)}`;
  box.style.color = '#ff5d5d';
  document.body.append(box);
  throw e;
});

registerSW({ immediate: true });
