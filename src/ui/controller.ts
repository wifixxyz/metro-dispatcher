import type { Game } from '../game';
import type { Hit, Scene } from '../render/scene';
import type { Panel } from './panel';

/** Обработка касаний карты: выбор светофоров, стрелок, составов. */
export class Controller {
  constructor(
    private readonly game: Game,
    private readonly scene: Scene,
    private readonly panel: Panel,
  ) {
    panel.onAuto = () => {
      game.setLineManual(!game.manualLine);
      panel.showToast(game.manualLine ? 'Вся линия в ручном режиме: автомат не ставит маршруты' : 'Автомат включён', false);
    };
  }

  tap(hit: Hit | undefined): void {
    const { game, scene, panel } = this;
    if (!hit) {
      scene.selected = undefined;
      panel.hideCard();
      return;
    }
    if (hit.kind === 'far') {
      panel.showToast('Приблизьте схему, чтобы выбрать светофор или стрелку');
      return;
    }
    if (hit.kind === 'signal') this.tapSignal(hit.block);
    else {
      scene.selected = undefined;
      if (hit.kind === 'switch') this.switchCard(hit.node);
      else this.trainCard(hit.id);
    }
    void game;
  }

  private tapSignal(block: string): void {
    const { game, scene, panel } = this;
    panel.hideCard();
    if (scene.selected === block) {
      scene.selected = undefined;
      panel.showToast('Выбор отменён');
      return;
    }
    if (scene.selected) {
      const r = game.setRoute(scene.selected, block);
      scene.selected = undefined;
      panel.showToast(r.ok ? 'Маршрут установлен' : r.reason, !r.ok);
      return;
    }
    const route = game.sim.il.routeOf(block);
    if (route && route.blocks[0] === block) {
      panel.showCard(`Маршрут ${route.id}`, [
        {
          label: 'Отменить маршрут',
          testId: 'route-cancel',
          run: () => {
            const r = game.cancelRoute(block);
            panel.showToast(r.ok ? 'Маршрут отменён' : r.reason, !r.ok);
            panel.hideCard();
          },
        },
      ]);
      return;
    }
    scene.selected = block;
    panel.showToast('Начало маршрута выбрано. Коснитесь конечного светофора');
  }

  private switchCard(node: string): void {
    const { game, panel } = this;
    const render = (): void => {
      const pos = game.sim.il.pointPosition(node);
      panel.showCard(`Стрелка ${node} → ${pos}`, [
        {
          label: game.isNodeManual(node) && !game.manualLine ? 'Узел: ручной' : game.manualLine ? 'Линия ручная' : 'Узел: авто',
          testId: 'node-mode',
          run: () => {
            if (game.manualLine) {
              panel.showToast('Вся линия в ручном режиме', true);
              return;
            }
            game.setNodeManual(node, !game.isNodeManual(node));
            render();
          },
        },
        {
          label: 'Перевести',
          testId: 'throw',
          run: () => {
            const r = game.throwPoints(node);
            panel.showToast(r.ok ? 'Стрелка переведена' : r.reason, !r.ok);
            render();
          },
        },
      ]);
    };
    render();
  }

  private trainCard(id: string): void {
    const { game, panel } = this;
    const render = (): void => {
      const tr = game.sim.trains.find((t) => t.id === id);
      if (!tr) {
        panel.hideCard();
        return;
      }
      panel.showCard(`Поезд ${id.replace(/^\D+/, '')}${tr.hold ? ' · задержан' : ''}`, [
        {
          label: tr.hold ? 'Снять задержку' : 'Задержать',
          testId: 'train-hold',
          run: () => {
            game.holdTrain(id, !tr.hold);
            render();
          },
        },
        {
          label: 'Отправить',
          testId: 'train-send',
          run: () => {
            const r = game.sendTrain(id);
            panel.showToast(r.ok ? 'Отправлен' : r.reason, !r.ok);
            render();
          },
        },
        {
          label: 'В депо',
          testId: 'train-recall',
          run: () => {
            const r = game.recallTrain(id);
            panel.showToast(r.ok ? 'Идёт в депо' : r.reason, !r.ok);
            panel.hideCard();
          },
        },
      ]);
    };
    render();
  }
}
