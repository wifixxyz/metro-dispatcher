import { INTERVALS, SPEEDS, formatClock, type Game } from '../game';
import type { Settings } from '../storage/save';

export interface PanelHandlers {
  onMode(id: string): void;
  onZoom(kind: 'in' | 'out' | 'fit'): void;
  onSettings(s: Settings): void;
  onNewShift(): void;
  onEditor(): void;
  onView(): void;
  onCam(kind: 'overview' | 'cab' | 'focus'): void;
}

const PALETTE = ['#de64a1', '#5ad19a', '#f2c94c', '#56b6f7', '#ff9f43', '#b48cf2', '#9bdc5a', '#ff6b6b'];
const NS = 'http://www.w3.org/2000/svg';

const mmss = (sec: number): string => {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

function button(label: string, testId: string, onClick: () => void, aria?: string): HTMLButtonElement {
  const b = el('button', { type: 'button', className: 'btn', textContent: label });
  b.dataset['testid'] = testId;
  if (aria) b.setAttribute('aria-label', aria);
  b.addEventListener('click', onClick);
  return b;
}

/** DOM-панели поверх карты: режим, масштаб, нижняя панель, шторка журнала. */
export class Panel {
  private game: Game;
  private readonly clock = el('span', { className: 'clock' });
  private readonly status = el('span', { className: 'status' });
  private readonly autoBtn = button('Автомат: вкл', 'auto-toggle', () => this.onAuto?.());
  private readonly toast = el('div', { className: 'toast' });
  private readonly card = el('div', { className: 'card' });
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  /** Обработчик переключателя авто/ручной для всей линии. */
  onAuto: (() => void) | undefined;
  private readonly intervalBtns = new Map<number, HTMLButtonElement>();
  private readonly speedBtns = new Map<number, HTMLButtonElement>();
  private pauseBtn!: HTMLButtonElement;
  private readonly sheet = el('aside', { className: 'sheet' });
  private readonly logBox = el('div', { className: 'log' });
  private readonly diag = el('div', { className: 'diag' });
  private readonly modeSelect = el('select', { className: 'mode' });
  private viewBtn!: HTMLButtonElement;
  private cabBtn!: HTMLButtonElement;
  private hudRow!: HTMLElement;
  private readonly hud = el('div', { className: 'hud' });
  private readonly hudText = el('div', { className: 'hudtext' });
  private lastLog = -1;
  private lastText = '';
  private lastStats = '';
  private readonly statsBox = el('div', { className: 'stats' });
  private settings: Settings;
  private readonly setBtns = new Map<keyof Settings, HTMLButtonElement>();

  constructor(
    private readonly root: HTMLElement,
    game: Game,
    private readonly handlers: PanelHandlers,
    settings: Settings,
  ) {
    this.game = game;
    this.settings = { ...settings };
    const top = el('header', { className: 'top' });
    const title = el('h1', { textContent: 'Метро · Диспетчер' });
    this.modeSelect.dataset['testid'] = 'mode';
    this.modeSelect.setAttribute('aria-label', 'Режим работы');
    for (const m of game.cfg.modes ?? []) this.modeSelect.append(el('option', { value: m.id, textContent: m.name }));
    this.modeSelect.value = game.mode;
    this.modeSelect.addEventListener('change', () => handlers.onMode(this.modeSelect.value));
    const edit = button('✎', 'editor-open', () => handlers.onEditor(), 'Редактор линий');
    this.viewBtn = button('3D', 'view-toggle', () => handlers.onView(), 'Переключить 2D-пульт и 3D-вид');
    top.append(title, this.modeSelect, this.viewBtn, edit);
    this.hud.dataset['testid'] = 'hud';
    this.hudText.dataset['testid'] = 'hud-text';
    this.hudRow = el('div', { className: 'row' });
    this.cabBtn = button('Из кабины', 'cam-cab', () => handlers.onCam('cab'));
    this.hudRow.append(
      button('Обзор', 'cam-overview', () => handlers.onCam('overview')),
      button('К поезду', 'cam-focus', () => handlers.onCam('focus')),
      this.cabBtn,
    );
    this.hud.append(this.hudText, this.hudRow);

    const zoom = el('div', { className: 'zoom' });
    zoom.append(
      button('+', 'zoom-in', () => handlers.onZoom('in'), 'Приблизить'),
      button('−', 'zoom-out', () => handlers.onZoom('out'), 'Отдалить'),
      button('⤢', 'zoom-fit', () => handlers.onZoom('fit'), 'Вся линия'),
    );

    const panel = el('section', { className: 'panel' });
    this.status.dataset['testid'] = 'status';
    this.clock.dataset['testid'] = 'clock';
    this.toast.dataset['testid'] = 'toast';
    this.card.dataset['testid'] = 'card';
    this.autoBtn.classList.add('wide');
    const stat = el('div', { className: 'row stat' }, this.clock, this.status, this.autoBtn);

    const ivRow = el('div', { className: 'row' }, el('span', { className: 'lbl', textContent: 'Интервал' }));
    for (const iv of INTERVALS) {
      const b = button(`${iv / 60} мин`, `interval-${iv / 60}`, () => this.game.setInterval(iv));
      this.intervalBtns.set(iv, b);
      ivRow.append(b);
    }

    const spRow = el('div', { className: 'row' });
    this.pauseBtn = button('⏸', 'pause', () => this.game.togglePause(), 'Пауза');
    spRow.append(this.pauseBtn);
    for (const sp of SPEEDS) {
      const b = button(`${sp}×`, `speed-${sp}`, () => this.game.setSpeed(sp));
      this.speedBtns.set(sp, b);
      spRow.append(b);
    }
    const sheetBtn = button('☰', 'sheet-toggle', () => this.sheet.classList.toggle('open'), 'Журнал и диагностика');
    spRow.append(sheetBtn);
    panel.append(stat, ivRow, spRow);

    this.sheet.dataset['testid'] = 'sheet';
    const setRow = el('div', { className: 'row' });
    const names: [keyof Settings, string, string][] = [
      ['sound', 'Звук', 'set-sound'],
      ['ambient', 'Фон зала', 'set-ambient'],
      ['haptics', 'Вибрация', 'set-haptics'],
    ];
    for (const [key, label, id] of names) {
      const b = button(label, id, () => {
        this.settings[key] = !this.settings[key];
        this.paintSettings();
        this.handlers.onSettings({ ...this.settings });
      });
      this.setBtns.set(key, b);
      setRow.append(b);
    }
    const newBtn = button('Новая смена', 'new-shift', () => this.handlers.onNewShift());
    this.paintSettings();
    this.sheet.append(
      el('h2', { textContent: 'Настройки' }),
      setRow,
      el('div', { className: 'row' }, newBtn),
      el('h2', { textContent: 'Статистика' }),
      this.statsBox,
      el('h2', { textContent: 'Диагностика и журнал' }),
      this.diag,
      this.logBox,
    );

    root.append(top, zoom, this.hud, this.toast, this.card, panel, this.sheet);
  }

  /** Короткое сообщение (в том числе объяснение отказа). */
  showToast(text: string, bad = false): void {
    this.toast.textContent = text;
    this.toast.classList.toggle('bad', bad);
    this.toast.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.classList.remove('show'), 3500);
  }

  /** Карточка объекта: заголовок и кнопки действий. */
  showCard(title: string, actions: { label: string; testId: string; run: () => void }[]): void {
    const close = button('×', 'card-close', () => this.hideCard(), 'Закрыть');
    const head = el('div', { className: 'head' }, el('span', { textContent: title }), close);
    const row = el('div', { className: 'row' });
    for (const a of actions) row.append(button(a.label, a.testId, a.run));
    this.card.replaceChildren(head, row);
    this.card.classList.add('show');
  }

  hideCard(): void {
    this.card.classList.remove('show');
  }

  /** Переключить вид: в 3D скрываются кнопки масштаба 2D и показывается панель камеры. */
  setView(v: '2d' | '3d'): void {
    this.viewBtn.textContent = v === '3d' ? '2D' : '3D';
    this.viewBtn.classList.toggle('on', v === '3d');
    this.hud.classList.toggle('show', v === '3d');
    this.root.classList.toggle('v3d', v === '3d');
  }

  setHud(text: string, hasTrain: boolean, cab: boolean): void {
    this.hudText.textContent = text || 'Коснитесь поезда, чтобы выбрать его';
    this.cabBtn.textContent = cab ? 'Выйти из кабины' : 'Из кабины';
    this.cabBtn.disabled = !hasTrain && !cab;
    (this.hudRow.children[1] as HTMLButtonElement).disabled = !hasTrain;
  }

  private paintSettings(): void {
    for (const [k, b] of this.setBtns) b.classList.toggle('on', this.settings[k]);
  }

  private renderStats(): void {
    const g = this.game;
    const st = g.stats;
    const key = `${st.arrivals}|${st.failures.length}|${g.interventions}|${g.interval}`;
    if (key === this.lastStats) return;
    this.lastStats = key;
    const rows = st.stations();
    const tNow = g.sim.t;
    const span = 40 * 60;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 300 110');
    svg.setAttribute('class', 'chart');
    svg.dataset['testid'] = 'chart';
    const yMax = g.interval * 2;
    const ref = document.createElementNS(NS, 'line');
    const yRef = 105 - (g.interval / yMax) * 100;
    ref.setAttribute('x1', '0');
    ref.setAttribute('x2', '300');
    ref.setAttribute('y1', String(yRef));
    ref.setAttribute('y2', String(yRef));
    ref.setAttribute('stroke', '#4a5368');
    ref.setAttribute('stroke-dasharray', '3 3');
    svg.append(ref);
    rows.forEach((r, i) => {
      const pts = r.points.filter((p) => p.t >= tNow - span);
      if (pts.length < 2) return;
      const poly = document.createElementNS(NS, 'polyline');
      poly.setAttribute('fill', 'none');
      poly.setAttribute('stroke', PALETTE[i % PALETTE.length] as string);
      poly.setAttribute('stroke-width', '1.2');
      poly.setAttribute(
        'points',
        pts.map((p) => `${((p.t - (tNow - span)) / span) * 300},${105 - Math.min(1, p.dt / yMax) * 100}`).join(' '),
      );
      svg.append(poly);
    });
    const summary = el('div', {
      className: 'sum',
      textContent:
        `Парк выполнен на ${Math.round(st.fleetFulfilment() * 100)}% · задержек ${st.delays} из ${st.arrivals} прибытий · ` +
        `вмешательств ${g.interventions} · сбоев ${st.failures.length}`,
    });
    summary.dataset['testid'] = 'stats-summary';
    const table = el('div', { className: 'tbl' });
    rows.forEach((r, i) => {
      if (r.count === 0) return;
      const line = el('div', { className: 'tr' });
      const dot = el('span', { className: 'dot' });
      dot.style.background = PALETTE[i % PALETTE.length] as string;
      line.append(dot, el('span', { className: 'nm', textContent: r.name }), el('span', { textContent: `${mmss(r.mean)} (${mmss(r.min)}–${mmss(r.max)})` }));
      table.append(line);
    });
    const fails = st.failures.slice(-5).reverse().map((f) => el('div', { className: 'line warn', textContent: `${formatClock(f.t)}  ${f.text}` }));
    this.statsBox.replaceChildren(summary, svg, table, ...(fails.length ? [el('div', { className: 'lbl', textContent: 'Журнал сбоев' }), ...fails] : []));
  }

  setGame(game: Game): void {
    this.lastStats = '';
    this.game = game;
    this.modeSelect.value = game.mode;
    this.lastLog = -1;
  }

  /** Обновить тексты; вызывается каждый кадр, DOM трогается только при изменении. */
  update(): void {
    const g = this.game;
    const st = g.status();
    const text = `${g.manualLine}|${formatClock(g.sim.t)}|${st.active}|${st.required}|${st.missing}|${g.paused}|${g.speed}|${g.interval}`;
    if (text === this.lastText) return;
    this.lastText = text;
    this.clock.textContent = formatClock(g.sim.t);
    this.status.textContent = `в работе ${st.active} · расчётно ${st.required} · не хватает ${st.missing}`;
    this.status.classList.toggle('bad', st.missing > 0);
    this.autoBtn.textContent = g.manualLine ? 'Ручной режим' : 'Автомат: вкл';
    this.autoBtn.classList.toggle('on', g.manualLine);
    for (const [iv, b] of this.intervalBtns) b.classList.toggle('on', iv === g.interval);
    for (const [sp, b] of this.speedBtns) b.classList.toggle('on', sp === g.speed && !g.paused);
    this.pauseBtn.classList.toggle('on', g.paused);
    this.pauseBtn.textContent = g.paused ? '▶' : '⏸';
    this.pauseBtn.setAttribute('aria-label', g.paused ? 'Продолжить' : 'Пауза');

    if (this.sheet.classList.contains('open')) {
      this.renderStats();
      this.diag.textContent =
        `Составов на линии: ${g.sim.trains.length} · в депо: ${st.inDepot} · ` +
        `занятых блоков: ${g.sim.il.occupiedBlocks().length} · маршрутов: ${g.sim.il.routes.size} · ` +
        `нарушений: ${g.sim.il.violations.length}`;
      if (this.lastLog !== g.log.length || this.lastLog < 0) {
        this.lastLog = g.log.length;
        this.logBox.replaceChildren(
          ...g.log
            .slice(-60)
            .reverse()
            .map((l) => el('div', { className: `line ${l.kind}`, textContent: `${formatClock(l.t)}  ${l.text}` })),
        );
      }
    }
  }
}
