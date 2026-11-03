import './style.css';
import { registerSW } from 'virtual:pwa-register';
import { APP_STAGE, APP_TITLE } from './meta';

declare const __APP_VERSION__: string;

function mount(root: HTMLElement): void {
  const title = document.createElement('h1');
  title.textContent = APP_TITLE;

  const stage = document.createElement('p');
  stage.className = 'stage';
  stage.textContent = `${APP_STAGE} · v${__APP_VERSION__}`;

  root.append(title, stage);
}

const root = document.getElementById('app');
if (!root) throw new Error('Не найден контейнер #app');
mount(root);

registerSW({ immediate: true });
