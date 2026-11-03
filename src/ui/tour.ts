const KEY = 'metro.tour.v1';

const STEPS: { title: string; text: string }[] = [
  { title: 'Это пульт диспетчера', text: 'Схема линии: розовые полосы — поезда с номерами, красным подсвечены занятые участки. Двумя пальцами — масштаб, одним — сдвиг.' },
  { title: 'Авто и ручной режим', text: 'Кнопка «Авто» отдаёт линию автодиспетчеру. «Ручной» — маршруты ставите вы. Интервал и скорость времени — внизу.' },
  { title: 'Задать маршрут', text: 'Нажмите «Задать маршрут», коснитесь светофора начала, затем светофора конца. Подсказка на экране ведёт по шагам.' },
  { title: 'Вид в 3D', text: 'Кнопка «3D» вверху показывает линию в объёме: коснитесь поезда и нажмите «Из кабины».' },
];

function seen(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

function markSeen(): void {
  try {
    localStorage.setItem(KEY, '1');
  } catch {
    /* хранилище недоступно — подсказки покажутся снова */
  }
}

/** Короткое обучение при первом запуске: 4 подсказки, можно пропустить. */
export function showTourOnce(root: HTMLElement, force = false): void {
  if (!force && seen()) return;
  let i = 0;
  const box = document.createElement('div');
  box.className = 'tour';
  box.dataset['testid'] = 'tour';
  const card = document.createElement('div');
  card.className = 'tour-card';
  box.append(card);
  const close = (): void => {
    markSeen();
    box.remove();
  };
  const render = (): void => {
    const st = STEPS[i] as (typeof STEPS)[number];
    const h = document.createElement('h2');
    h.textContent = st.title;
    const p = document.createElement('p');
    p.textContent = st.text;
    const dots = document.createElement('div');
    dots.className = 'tour-dots';
    dots.textContent = `${i + 1} / ${STEPS.length}`;
    const row = document.createElement('div');
    row.className = 'row';
    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'btn';
    skip.textContent = 'Пропустить';
    skip.dataset['testid'] = 'tour-skip';
    skip.addEventListener('click', close);
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'btn primary';
    next.textContent = i === STEPS.length - 1 ? 'Начать' : 'Дальше';
    next.dataset['testid'] = 'tour-next';
    next.addEventListener('click', () => {
      if (i === STEPS.length - 1) close();
      else {
        i++;
        render();
      }
    });
    row.append(skip, next);
    card.replaceChildren(h, p, dots, row);
  };
  render();
  root.append(box);
}
