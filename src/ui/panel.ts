import { INTERVALS, SPEEDS, formatClock, type Game } from '../game';

export interface PanelHandlers {
  onMode(id: string): void;
  onZoom(kind: 'in' | 'out' | 'fit'): void;
}

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
  private readonly auto = el('span', { className: 'auto', textContent: 'Автомат: вкл' });
  private readonly intervalBtns = new Map<number, HTMLButtonElement>();
  private readonly speedBtns = new Map<number, HTMLButtonElement>();
  private pauseBtn!: HTMLButtonElement;
  private readonly sheet = el('aside', { className: 'sheet' });
  private readonly logBox = el('div', { className: 'log' });
  private readonly diag = el('div', { className: 'diag' });
  private readonly modeSelect = el('select', { className: 'mode' });
  private lastLog = -1;
  private lastText = '';

  constructor(
    root: HTMLElement,
    game: Game,
    handlers: PanelHandlers,
  ) {
    this.game = game;
    const top = el('header', { className: 'top' });
    const title = el('h1', { textContent: 'Метро · Диспетчер' });
    this.modeSelect.dataset['testid'] = 'mode';
    this.modeSelect.setAttribute('aria-label', 'Режим работы');
    for (const m of game.cfg.modes ?? []) this.modeSelect.append(el('option', { value: m.id, textContent: m.name }));
    this.modeSelect.value = game.mode;
    this.modeSelect.addEventListener('change', () => handlers.onMode(this.modeSelect.value));
    top.append(title, this.modeSelect);

    const zoom = el('div', { className: 'zoom' });
    zoom.append(
      button('+', 'zoom-in', () => handlers.onZoom('in'), 'Приблизить'),
      button('−', 'zoom-out', () => handlers.onZoom('out'), 'Отдалить'),
      button('⤢', 'zoom-fit', () => handlers.onZoom('fit'), 'Вся линия'),
    );

    const panel = el('section', { className: 'panel' });
    this.status.dataset['testid'] = 'status';
    this.clock.dataset['testid'] = 'clock';
    const stat = el('div', { className: 'row stat' }, this.clock, this.status, this.auto);

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
    this.sheet.append(el('h2', { textContent: 'Диагностика и журнал' }), this.diag, this.logBox);

    root.append(top, zoom, panel, this.sheet);
  }

  setGame(game: Game): void {
    this.game = game;
    this.modeSelect.value = game.mode;
    this.lastLog = -1;
  }

  /** Обновить тексты; вызывается каждый кадр, DOM трогается только при изменении. */
  update(): void {
    const g = this.game;
    const st = g.status();
    const text = `${formatClock(g.sim.t)}|${st.active}|${st.required}|${st.missing}|${g.paused}|${g.speed}|${g.interval}`;
    if (text === this.lastText) return;
    this.lastText = text;
    this.clock.textContent = formatClock(g.sim.t);
    this.status.textContent = `в работе ${st.active} · расчётно ${st.required} · не хватает ${st.missing}`;
    this.status.classList.toggle('bad', st.missing > 0);
    for (const [iv, b] of this.intervalBtns) b.classList.toggle('on', iv === g.interval);
    for (const [sp, b] of this.speedBtns) b.classList.toggle('on', sp === g.speed && !g.paused);
    this.pauseBtn.classList.toggle('on', g.paused);
    this.pauseBtn.textContent = g.paused ? '▶' : '⏸';
    this.pauseBtn.setAttribute('aria-label', g.paused ? 'Продолжить' : 'Пауза');

    if (this.sheet.classList.contains('open')) {
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
