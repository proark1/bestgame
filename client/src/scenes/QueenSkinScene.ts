import Phaser from 'phaser';
import type { HiveRuntime } from '../main.js';
import type { QueenSkinDef, QueenSkinCatalog } from '../net/Api.js';
import { fadeInScene } from '../ui/transitions.js';
import { drawSceneAmbient, drawSceneHud, makeScrollBody } from '../ui/sceneFrame.js';
import { drawQueenCard } from '../ui/queenPortrait.js';
import { makeHiveButton } from '../ui/button.js';
import { crispText } from '../ui/text.js';
import { COLOR, bodyTextStyle } from '../ui/theme.js';

// Queen skin picker. Shows the full catalog; owned skins get an
// "Equip" button, locked skins show their unlock condition. The
// equipped skin also flows back into HomeScene via runtime.player
// on the next /me refresh.

export class QueenSkinScene extends Phaser.Scene {
  constructor() { super('QueenSkinScene'); }

  create(): void {
    fadeInScene(this);
    this.cameras.main.setBackgroundColor('#0f1b10');
    drawSceneAmbient(this);
    drawSceneHud(this, 'Your Queen', 'HomeScene');
    const body = makeScrollBody(this);
    const loading = crispText(
      this,
      this.scale.width / 2,
      140,
      'Summoning the queens...',
      bodyTextStyle(14, COLOR.textDim),
    ).setOrigin(0.5);
    void this.loadAndRender(body.container, body.setContentHeight, loading);
  }

  private async loadAndRender(
    container: Phaser.GameObjects.Container,
    setContentHeight: (h: number) => void,
    loading: Phaser.GameObjects.Text,
  ): Promise<void> {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime) { loading.setText('Offline — no queens'); return; }
    try {
      const res = await runtime.api.getQueenSkins();
      if (!this.scene.isActive()) return;
      loading.destroy();
      this.renderCatalog(container, setContentHeight, res, runtime);
    } catch (err) {
      if (!this.scene.isActive()) return;
      loading.setText(`Error: ${(err as Error).message}`);
    }
  }

  private renderCatalog(
    container: Phaser.GameObjects.Container,
    setContentHeight: (h: number) => void,
    res: QueenSkinCatalog,
    runtime: HiveRuntime,
  ): void {
    container.removeAll(true);
    const maxW = Math.min(640, this.scale.width - 32);
    const originX = (this.scale.width - maxW) / 2;
    let y = 0;

    container.add(
      crispText(
        this,
        originX,
        y,
        'Every queen is cosmetic only — no skin affects stats.',
        bodyTextStyle(13, COLOR.textDim),
      ),
    );
    y += 32;

    for (const def of res.catalog) {
      const owned = res.owned.includes(def.id);
      const equipped = res.equipped === def.id;
      const card = drawQueenCard(this, originX, y, maxW, def, owned, equipped);
      container.add(card);

      if (owned && !equipped) {
        const btn = makeHiveButton(this, {
          x: originX + maxW - 60,
          y: y + 128,
          width: 100,
          height: 32,
          label: 'Equip',
          variant: 'primary',
          fontSize: 13,
          onPress: () => {
            void this.equip(def, container, setContentHeight, runtime);
          },
        });
        container.add(btn.container);
      }
      y += 172;
    }
    setContentHeight(y);
  }

  private async equip(
    def: QueenSkinDef,
    container: Phaser.GameObjects.Container,
    setContentHeight: (h: number) => void,
    runtime: HiveRuntime,
  ): Promise<void> {
    try {
      const r = await runtime.api.equipQueenSkin(def.id);
      if (runtime.player) {
        runtime.player.player.queenSkin = { equipped: r.equipped, owned: r.owned };
      }
      const res = await runtime.api.getQueenSkins();
      this.renderCatalog(container, setContentHeight, res, runtime);
    } catch (err) {
      console.warn('equip failed', err);
    }
  }
}
