import { LineConfigSchema, type LineConfig } from '../lines/schema';
import { checkLine, exportLine, parseLineText, validateLine, type Problem } from '../lines/validate';
import { addDepot, addMode, addStation, removeMode, removeStation, setBlockLength, updateEdge, updateStation } from './model';
import { renderPreview } from './preview';

export interface EditorOptions {
  initial: LineConfig;
  /** Линия по умолчанию (для «вернуть исходную»). */
  isDefault: boolean;
  onPlay(cfg: LineConfig): void;
  onReset(): void;
  onClose(): void;
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

function btn(label: string, testId: string, on: () => void, cls = 'btn'): HTMLButtonElement {
  const b = el('button', { type: 'button', className: cls, textContent: label });
  b.dataset['testid'] = testId;
  b.addEventListener('click', on);
  return b;
}

function num(value: number, testId: string, on: (v: number) => void, step = 1): HTMLInputElement {
  const i = el('input', { type: 'number', className: 'inp', value: String(value), step: String(step) });
  i.dataset['testid'] = testId;
  i.addEventListener('change', () => {
    const v = Number(i.value);
    if (Number.isFinite(v)) on(v);
  });
  return i;
}

function select(options: { value: string; label: string }[], value: string, testId: string): HTMLSelectElement {
  const s = el('select', { className: 'inp' });
  s.dataset['testid'] = testId;
  for (const o of options) s.append(el('option', { value: o.value, textContent: o.label }));
  s.value = value;
  return s;
}

/** Экран редактора линий: правка формами и JSON, проверка, предпросмотр, запуск. */
export function openEditor(root: HTMLElement, opts: EditorOptions): void {
  let cfg = opts.initial;
  let problems: { errors: Problem[]; warnings: Problem[] } = { errors: [], warnings: [] };
  let note = '';
  let jsonDirty = false;

  const box = el('div', { className: 'editor' });
  box.dataset['testid'] = 'editor';
  const head = el('div', { className: 'ehead' }, el('h2', { textContent: `Редактор линий · ${cfg.name}` }), btn('×', 'editor-close', () => close(), 'btn narrow'));
  const noteEl = el('div', { className: 'note' });
  noteEl.dataset['testid'] = 'editor-note';
  const previewBox = el('div', { className: 'pv' });
  const statEl = el('div', { className: 'estat' });
  statEl.dataset['testid'] = 'editor-status';
  const probEl = el('div', { className: 'probs' });
  probEl.dataset['testid'] = 'editor-errors';
  const forms = el('div', { className: 'forms' });
  const ta = el('textarea', { className: 'json', spellcheck: false });
  ta.dataset['testid'] = 'editor-json';
  ta.addEventListener('input', () => {
    jsonDirty = true;
  });
  const fileIn = el('input', { type: 'file', accept: '.json,application/json' });
  fileIn.dataset['testid'] = 'editor-file';
  fileIn.hidden = true;
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files?.[0];
    if (!f) return;
    ta.value = await f.text();
    jsonDirty = true;
    applyJson();
  });

  function close(): void {
    box.remove();
    opts.onClose();
  }

  function setCfg(next: LineConfig, msg = ''): void {
    cfg = next;
    note = msg;
    jsonDirty = false;
    ta.value = exportLine(cfg);
    refresh();
  }

  function applyJson(): void {
    const text = ta.value;
    const full = parseLineText(text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const z = parsed === undefined ? undefined : LineConfigSchema.safeParse(parsed);
    if (z?.success) {
      cfg = z.data;
      note = full.ok ? 'JSON применён' : 'JSON применён, но в линии есть ошибки — исправьте их ниже';
      jsonDirty = false;
      refresh(false);
    } else {
      problems = { errors: full.errors, warnings: full.warnings };
      note = 'JSON не применён: исправьте ошибки';
      paintProblems();
    }
  }

  function paintProblems(): void {
    const { errors, warnings } = problems;
    statEl.textContent = `Ошибок: ${errors.length} · предупреждений: ${warnings.length}`;
    statEl.classList.toggle('bad', errors.length > 0);
    probEl.replaceChildren(
      ...errors.map((p) => el('div', { className: 'prob err', textContent: `${p.path}: ${p.message}` })),
      ...warnings.map((p) => el('div', { className: 'prob warn', textContent: `${p.path}: ${p.message}` })),
    );
    noteEl.textContent = note;
    (box.querySelector('[data-testid=editor-play]') as HTMLButtonElement | null)?.toggleAttribute('disabled', errors.length > 0);
  }

  function buildForms(): void {
    const stationOpts = cfg.stations.map((s) => ({ value: s.id, label: s.name }));
    const sec = (title: string, ...kids: Node[]): HTMLElement => el('section', { className: 'esec' }, el('h3', { textContent: title }), ...kids);

    // Станции.
    const rows = cfg.stations.map((s) => {
      const name = el('input', { className: 'inp', value: s.name });
      name.dataset['testid'] = `st-name-${s.id}`;
      name.addEventListener('change', () => setCfg(updateStation(cfg, s.id, { name: name.value }), ''));
      const plat = select([{ value: 'island', label: 'островная' }, { value: 'shore', label: 'береговая' }], s.platform, `st-plat-${s.id}`);
      plat.addEventListener('change', () => setCfg(updateStation(cfg, s.id, { platform: plat.value as 'island' | 'shore' })));
      const at = num(s.stops[0]?.at ?? 0, `st-at-${s.id}`, (v) => setCfg(updateStation(cfg, s.id, { stopAt: v })));
      const del = btn('Удалить', `st-del-${s.id}`, () => {
        const r = removeStation(cfg, s.id);
        setCfg(r.cfg, r.note);
      });
      return el('div', { className: 'erow' }, name, plat, el('label', { className: 'lbl2' }, 'стоп, м', at), del);
    });
    const newName = el('input', { className: 'inp', placeholder: 'Название новой станции' });
    newName.dataset['testid'] = 'add-st-name';
    const after = select([{ value: '', label: 'в начало' }, ...stationOpts.map((o) => ({ value: o.value, label: `после «${o.label}»` }))], cfg.stations.at(-1)?.id ?? '', 'add-st-after');
    const add = btn('Добавить станцию', 'add-st', () => {
      const name = newName.value.trim();
      if (!name) {
        note = 'Введите название станции';
        paintProblems();
        return;
      }
      const r = addStation(cfg, name, after.value || undefined);
      setCfg(r.cfg, r.note);
    });
    forms.append(sec('Станции', ...rows, el('div', { className: 'erow' }, newName, after, add)));

    // Режимы.
    const modeRows = (cfg.modes ?? []).map((m) =>
      el('div', { className: 'erow' }, el('span', { className: 'grow', textContent: m.name }), btn('Удалить', `mode-del-${m.id}`, () => setCfg(removeMode(cfg, m.id), `Режим «${m.name}» удалён`))),
    );
    const w = select(stationOpts, cfg.stations[0]?.id ?? '', 'add-mode-west');
    const e = select(stationOpts, cfg.stations.at(-1)?.id ?? '', 'add-mode-east');
    const addM = btn('Добавить режим', 'add-mode', () => {
      try {
        const r = addMode(cfg, w.value, e.value);
        setCfg(r.cfg, r.note);
      } catch (err) {
        note = err instanceof Error ? err.message : String(err);
        paintProblems();
      }
    });
    forms.append(sec('Режимы (оборотные станции)', ...modeRows, el('div', { className: 'erow' }, w, e, addM)));

    // Депо.
    if (cfg.depot) forms.append(sec('Депо', el('div', { textContent: `${cfg.depot.name} у станции «${cfg.stations.find((s) => s.id === cfg.depot!.station)?.name ?? '?'}», парк ${cfg.depot.fleet}` })));
    else {
      const ds = select(stationOpts.slice(0, -1), stationOpts[0]?.value ?? '', 'add-depot-st');
      forms.append(
        sec('Депо', el('div', { className: 'erow' }, ds, btn('Добавить депо', 'add-depot', () => {
          try {
            const r = addDepot(cfg, ds.value);
            setCfg(r.cfg, r.note);
          } catch (err) {
            note = err instanceof Error ? err.message : String(err);
            paintProblems();
          }
        }))),
      );
    }

    // Светофоры: длина блок-участка.
    const bl = num(cfg.blockLength ?? 400, 'block-length', (v) => setCfg(setBlockLength(cfg, v), ''), 50);
    forms.append(sec('Светофоры', el('label', { className: 'lbl2' }, 'расстояние между светофорами, м (100–2000)', bl)));

    // Участки.
    const edgeRows = cfg.edges.map((ed) =>
      el(
        'div',
        { className: 'erow small' },
        el('span', { className: 'grow', textContent: ed.id }),
        num(ed.length, `edge-len-${ed.id}`, (v) => setCfg(updateEdge(cfg, ed.id, { length: v }))),
        num(ed.speedKmh, `edge-v-${ed.id}`, (v) => setCfg(updateEdge(cfg, ed.id, { speedKmh: v }))),
      ),
    );
    const det = el('details', {}, el('summary', { textContent: `Участки (${cfg.edges.length}): длина м · скорость км/ч` }), ...edgeRows);
    forms.append(sec('Участки и стрелки', det, el('div', { className: 'hint', textContent: 'Стрелки возникают там, где из узла выходит несколько участков (съезды оборота, депо); их список виден на предпросмотре кольцами.' })));
  }

  function refresh(rebuildText = true): void {
    problems = checkLine(cfg);
    forms.replaceChildren();
    buildForms();
    if (rebuildText) ta.value = exportLine(cfg);
    try {
      const { svg, stats } = renderPreview(cfg);
      previewBox.replaceChildren(svg, el('div', { className: 'hint', textContent: `${stats.stations} станций · ${stats.edges} участков · ${stats.signals} светофоров · ${stats.switches} стрелок` }));
    } catch (err) {
      previewBox.replaceChildren(el('div', { className: 'hint', textContent: `Предпросмотр недоступен: ${err instanceof Error ? err.message : String(err)}` }));
    }
    paintProblems();
  }

  const actions = el(
    'div',
    { className: 'erow' },
    btn('Применить JSON', 'editor-apply', () => applyJson()),
    btn('Скачать .json', 'editor-export', () => {
      const a = el('a', { href: URL.createObjectURL(new Blob([exportLine(cfg)], { type: 'application/json' })), download: `${cfg.id}.json` });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }),
    btn('Загрузить файл', 'editor-import', () => fileIn.click()),
  );
  const play = btn('Играть на этой линии', 'editor-play', () => {
    if (jsonDirty) applyJson();
    const r = validateLine(cfg, { smoke: true });
    problems = { errors: r.errors, warnings: r.warnings };
    if (!r.ok) {
      note = 'Линия не запускается: исправьте ошибки';
      paintProblems();
      return;
    }
    opts.onPlay(cfg);
  }, 'btn primary');
  const reset = btn('Вернуть Некрасовскую', 'editor-reset', () => opts.onReset());
  if (opts.isDefault) reset.disabled = true;

  box.append(
    head,
    noteEl,
    previewBox,
    statEl,
    probEl,
    forms,
    el('section', { className: 'esec' }, el('h3', { textContent: 'JSON линии' }), ta, actions, fileIn),
    el('div', { className: 'erow' }, play, reset),
  );
  root.append(box);
  ta.value = exportLine(cfg);
  refresh(false);
}
