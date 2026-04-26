import Phaser from 'phaser';
import type { Types } from '@hive/shared';
import { fadeInScene, fadeToScene } from '../ui/transitions.js';
import { installSceneClickDebug } from '../ui/clickDebug.js';
import { openClanCreateModal } from '../ui/clanCreateModal.js';
import { openAlert, openConfirm } from '../ui/confirmModal.js';
import type { HiveRuntime } from '../main.js';
import type { ClanMyResponse, ClanSummary } from '../net/Api.js';
import { crispText } from '../ui/text.js';
import { makeHiveButton } from '../ui/button.js';
import { drawPanel, drawPill } from '../ui/panel.js';
import { COLOR, DEPTHS, bodyTextStyle, displayTextStyle, labelTextStyle } from '../ui/theme.js';

// ClanScene — three views:
//   1. My clan (when the player is in one)        — members + chat
//   2. Browse / Create (when the player isn't)    — list + form
//
// Chat is polled every 5 seconds and on send; no WebSocket yet.
// Scene-active guards on every async resolve so navigation doesn't
// touch torn-down UI.

const HUD_H = 56;

export class ClanScene extends Phaser.Scene {
  private view: 'loading' | 'member' | 'outsider' = 'loading';
  private my: ClanMyResponse | null = null;
  private pollTimer: number | null = null;
  private latestMessageId = 0;

  // Layers (destroyed on view switch so we don't leak DOM between modes).
  private layerContainer!: Phaser.GameObjects.Container;
  private chatContainer!: Phaser.GameObjects.Container;
  private chatInputEl: HTMLInputElement | null = null;
  private chatSendBtn: Phaser.GameObjects.Text | null = null;
  private browseLoaded: ClanSummary[] | null = null;
  // Active clan war, fetched alongside member view. Null when not in a
  // war; cached between renders so the header re-draw doesn't flicker.
  private activeWar: import('../net/Api.js').ClanWarState | null = null;

  constructor() {
    super('ClanScene');
  }

  create(): void {
    fadeInScene(this);
    installSceneClickDebug(this);
    this.cameras.main.setBackgroundColor('#0f1b10');
    this.drawAmbient();
    this.drawHud();
    this.layerContainer = this.add.container(0, 0);
    this.chatContainer = this.add.container(0, 0);
    void this.refreshMy();
    this.events.once('shutdown', () => this.cleanup());
  }

  private drawAmbient(): void {
    const g = this.add.graphics().setDepth(DEPTHS.background);
    const top = 0x203224;
    const bot = 0x070d08;
    const bands = 18;
    for (let i = 0; i < bands; i++) {
      const t = i / (bands - 1);
      const r = Math.round(((top >> 16) & 0xff) + (((bot >> 16) & 0xff) - ((top >> 16) & 0xff)) * t);
      const gc = Math.round(((top >> 8) & 0xff) + (((bot >> 8) & 0xff) - ((top >> 8) & 0xff)) * t);
      const b = Math.round((top & 0xff) + ((bot & 0xff) - (top & 0xff)) * t);
      g.fillStyle((r << 16) | (gc << 8) | b, 1);
      g.fillRect(
        0,
        Math.floor((i * this.scale.height) / bands),
        this.scale.width,
        Math.ceil(this.scale.height / bands) + 1,
      );
    }
    const glow = this.add.graphics().setDepth(DEPTHS.ambient);
    glow.fillStyle(COLOR.brass, 0.05);
    glow.fillEllipse(this.scale.width / 2, HUD_H + 150, Math.min(860, this.scale.width * 0.9), 220);
  }

  private cleanup(): void {
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.chatInputEl) {
      this.chatInputEl.remove();
      this.chatInputEl = null;
    }
  }

  private drawHud(): void {
    const w = this.scale.width;
    const hud = this.add.graphics();
    drawPanel(hud, 0, 0, w, HUD_H, {
      topColor: COLOR.bgPanelHi,
      botColor: COLOR.bgPanelLo,
      strokeWidth: 0,
      highlight: COLOR.brass,
      highlightAlpha: 0.12,
      radius: 0,
      shadowOffset: 0,
      shadowAlpha: 0,
    });
    hud.fillStyle(0x000000, 0.4);
    hud.fillRect(0, HUD_H, w, 3);
    makeHiveButton(this, {
      x: 72,
      y: HUD_H / 2,
      width: 120,
      height: 36,
      label: 'Home',
      variant: 'ghost',
      fontSize: 13,
      onPress: () => {
        this.cleanup();
        fadeToScene(this, 'HomeScene');
      },
    });
    crispText(
      this,
      this.scale.width / 2,
      HUD_H / 2,
      'Clan',
      displayTextStyle(20, COLOR.textGold, 4),
    ).setOrigin(0.5);
  }

  private async refreshMy(): Promise<void> {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime) {
      this.statusText('Offline');
      return;
    }
    try {
      const res = await runtime.api.clanMy();
      if (!this.scene.isActive()) return;
      this.my = res;
      if (res.clan) {
        this.view = 'member';
        this.latestMessageId =
          res.messages && res.messages.length > 0
            ? Number(res.messages[res.messages.length - 1]!.id)
            : 0;
        // Pull active war state alongside the member view. Failure is
        // non-fatal — the war banner simply won't render. Fire-and-
        // forget so we don't block the member list.
        void runtime.api
          .warCurrent()
          .then((r) => {
            if (!this.scene.isActive()) return;
            this.activeWar = r.war;
            this.renderMemberView();
          })
          .catch(() => undefined);
        this.renderMemberView();
        this.startPolling();
      } else {
        this.view = 'outsider';
        this.renderOutsiderView();
      }
    } catch (err) {
      if (!this.scene.isActive()) return;
      this.statusText(`Error: ${(err as Error).message}`);
    }
  }

  private statusText(msg: string): void {
    this.layerContainer.removeAll(true);
    const w = Math.min(520, this.scale.width - 32);
    const x = (this.scale.width - w) / 2;
    const y = HUD_H + 44;
    const card = this.add.graphics();
    drawPanel(card, x, y, w, 76, {
      topColor: COLOR.bgPanelHi,
      botColor: COLOR.bgPanelLo,
      stroke: COLOR.brassDeep,
      strokeWidth: 3,
      highlight: COLOR.brass,
      highlightAlpha: 0.14,
      radius: 16,
      shadowOffset: 5,
      shadowAlpha: 0.32,
    });
    const pill = this.add.graphics();
    drawPill(pill, x + 16, y + 14, 80, 20, { brass: true });
    this.layerContainer.add(card);
    this.layerContainer.add(pill);
    this.layerContainer.add(
      crispText(this, x + 56, y + 24, 'Status', labelTextStyle(10, COLOR.textGold)).setOrigin(0.5, 0.5),
    );
    this.layerContainer.add(
      crispText(this, this.scale.width / 2, y + 48, msg, bodyTextStyle(14, COLOR.textPrimary)).setOrigin(0.5, 0.5),
    );
  }

  // -- Member view: members list on the left, chat on the right --------------

  private renderMemberView(): void {
    this.layerContainer.removeAll(true);
    this.chatContainer.removeAll(true);
    if (!this.my?.clan) return;
    const clan = this.my.clan;
    const title = crispText(
      this,
      this.scale.width / 2,
      HUD_H + 20,
      `[${clan.tag}] ${clan.name}`,
      displayTextStyle(18, COLOR.textGold, 4),
    ).setOrigin(0.5);
    this.layerContainer.add(title);
    // War banner — renders just under the clan title when a war is
    // active. Shows "A vs B" star totals and time remaining so every
    // member can see the shared objective at a glance.
    if (this.activeWar) {
      const w = this.activeWar;
      const mine = w.myClanSide === 'A' ? w.starsA : w.starsB;
      const them = w.myClanSide === 'A' ? w.starsB : w.starsA;
      const msLeft = Math.max(0, new Date(w.endsAt).getTime() - Date.now());
      const hh = Math.floor(msLeft / 3600000);
      const mm = Math.floor((msLeft % 3600000) / 60000);
      const banner = this.add.graphics();
      banner.fillStyle(0x2a1e1e, 1);
      banner.lineStyle(2, 0xd94c4c, 1);
      const bx = 20;
      const bw = this.scale.width - 40;
      banner.fillRoundedRect(bx, HUD_H + 40, bw, 30, 6);
      banner.strokeRoundedRect(bx, HUD_H + 40, bw, 30, 6);
      this.layerContainer.add(banner);
      this.layerContainer.add(
        this.add
          .text(
            this.scale.width / 2,
            HUD_H + 55,
            msLeft === 0
              ? `⚔ War ended — ${mine} ★ vs ${them} ★ (tap Clan Wars to finalize)`
              : `⚔ Clan War · ${mine} ★ vs ${them} ★ · ${hh}h ${mm}m left`,
            {
              fontFamily: 'ui-monospace, monospace',
              fontSize: '12px',
              color: '#ffd98a',
            },
          )
          .setOrigin(0.5),
      );
    }
    if (clan.description) {
      this.layerContainer.add(
        this.add
          .text(this.scale.width / 2, HUD_H + (this.activeWar ? 82 : 40), clan.description, {
            fontFamily: 'ui-monospace, monospace',
            fontSize: '11px',
            color: '#9cb98a',
          })
          .setOrigin(0.5),
      );
    }

    // Members — left column
    const listX = 20;
    const listY = HUD_H + 70;
    const listW = 240;
    const listH = this.scale.height - listY - 80;
    const mBg = this.add.graphics();
    drawPanel(mBg, listX, listY, listW, listH, {
      topColor: COLOR.bgCard,
      botColor: COLOR.bgInset,
      stroke: COLOR.outline,
      strokeWidth: 2,
      highlight: COLOR.brass,
      highlightAlpha: 0.08,
      radius: 12,
      shadowOffset: 4,
      shadowAlpha: 0.22,
    });
    this.layerContainer.add(mBg);
    const membersPill = this.add.graphics();
    drawPill(membersPill, listX + 10, listY + 10, 110, 20, { brass: true });
    this.layerContainer.add(membersPill);
    this.layerContainer.add(
      crispText(
        this,
        listX + 65,
        listY + 20,
        `Members ${this.my.members?.length ?? 0}`,
        labelTextStyle(10, COLOR.textGold),
      ).setOrigin(0.5, 0.5),
    );
    (this.my.members ?? []).forEach((m, i) => {
      const y = listY + 36 + i * 22;
      this.layerContainer.add(
        this.add
          .text(
            listX + 10,
            y,
            `${m.role === 'leader' ? '👑 ' : ''}${m.displayName}`,
            {
              fontFamily: 'ui-monospace, monospace',
              fontSize: '12px',
              color: '#e6f5d2',
            },
          )
          .setOrigin(0, 0),
      );
      this.layerContainer.add(
        this.add
          .text(listX + listW - 10, y, `🏆 ${m.trophies}`, {
            fontFamily: 'ui-monospace, monospace',
            fontSize: '11px',
            color: '#ffd98a',
          })
          .setOrigin(1, 0),
      );
    });

    // Request-units button — opens a small prompt that lets the
    // player ask the clan for help. The actual donate buttons render
    // inline in the chat feed (server posts a "🤝 …" system message
    // for every request and donation) so we don't need a separate
    // panel here.
    const reqBtn = makeHiveButton(this, {
      x: listX + listW / 2,
      y: listY + listH - 64,
      width: 168,
      height: 34,
      label: '🤝 Request units',
      variant: 'primary',
      fontSize: 12,
      onPress: () => { void this.openRequestPrompt(); },
    });
    this.layerContainer.add(reqBtn.container);

    // Leave button
    const leaveBtn = makeHiveButton(this, {
      x: listX + listW / 2,
      y: listY + listH - 24,
      width: 120,
      height: 34,
      label: 'Leave clan',
      variant: 'danger',
      fontSize: 12,
      onPress: () => void this.confirmLeave(),
    });
    this.layerContainer.add(leaveBtn.container);

    // Chat pane — right column
    const chatX = listX + listW + 20;
    const chatY = listY;
    const chatW = this.scale.width - chatX - 20;
    const chatH = listH;
    const cBg = this.add.graphics();
    drawPanel(cBg, chatX, chatY, chatW, chatH, {
      topColor: COLOR.bgCard,
      botColor: COLOR.bgInset,
      stroke: COLOR.outline,
      strokeWidth: 2,
      highlight: COLOR.brass,
      highlightAlpha: 0.08,
      radius: 12,
      shadowOffset: 4,
      shadowAlpha: 0.22,
    });
    this.layerContainer.add(cBg);
    const chatPill = this.add.graphics();
    drawPill(chatPill, chatX + 10, chatY + 10, 86, 20, { brass: true });
    this.layerContainer.add(chatPill);
    this.layerContainer.add(
      crispText(this, chatX + 53, chatY + 20, 'Clan chat', labelTextStyle(10, COLOR.textGold)).setOrigin(0.5, 0.5),
    );

    this.renderMessages(chatX, chatY, chatW, chatH);
    this.mountChatInput(chatX, chatY + chatH - 40, chatW);
  }

  private renderMessages(x: number, y: number, w: number, h: number): void {
    this.chatContainer.removeAll(true);
    const msgs = this.my?.messages ?? [];
    const lineH = 20;
    const padTop = 10;
    const pad = 10;
    const maxLines = Math.floor((h - 48) / lineH);
    const visible = msgs.slice(Math.max(0, msgs.length - maxLines));
    visible.forEach((m, i) => {
      const text = `[${m.displayName}] ${m.content}`;
      this.chatContainer.add(
        this.add
          .text(x + pad, y + padTop + i * lineH, text, {
            fontFamily: 'ui-monospace, monospace',
            fontSize: '12px',
            color: '#e6f5d2',
            wordWrap: { width: w - pad * 2 },
          })
          .setOrigin(0, 0),
      );
    });
  }

  // A DOM <input> floats on top of the canvas for chat entry. Phaser
  // doesn't have a text input primitive and wiring one from scratch is
  // over-engineering vs the ~10 lines of HTML below.
  private mountChatInput(x: number, y: number, w: number): void {
    if (this.chatInputEl) {
      this.chatInputEl.remove();
      this.chatInputEl = null;
    }
    const parent = document.getElementById('game');
    if (!parent) return;
    const canvas = parent.querySelector('canvas') as HTMLCanvasElement | null;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width / this.scale.width;
    const scaleY = rect.height / this.scale.height;

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Say something…';
    input.maxLength = 400;
    input.style.cssText = `
      position: absolute;
      left: ${rect.left + (x + 10) * scaleX}px;
      top: ${rect.top + y * scaleY}px;
      width: ${(w - 110) * scaleX}px;
      height: ${28 * scaleY}px;
      background: #0f1b10;
      color: #e6f5d2;
      border: 1px solid #2c5a23;
      border-radius: 6px;
      padding: 4px 8px;
      font-family: ui-monospace, monospace;
      font-size: ${12 * scaleY}px;
      z-index: 20;
    `;
    document.body.appendChild(input);
    this.chatInputEl = input;

    const send = async (): Promise<void> => {
      const content = input.value.trim();
      if (!content) return;
      const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
      if (!runtime) return;
      input.disabled = true;
      try {
        await runtime.api.clanMessageSend(content);
        if (!this.scene.isActive()) return;
        input.value = '';
        await this.pollMessages();
      } catch (err) {
        if (!this.scene.isActive()) return;
        console.warn('send failed', err);
      } finally {
        if (this.chatInputEl === input) input.disabled = false;
        input.focus();
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void send();
    });

    // Send button next to the input. Phaser-rendered so it lives
    // inside the scene lifecycle.
    const btn = this.add
      .text(x + w - 80, y + 14, 'Send', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '12px',
        color: '#ffffff',
        backgroundColor: '#3a7f3a',
        padding: { left: 12, right: 12, top: 6, bottom: 6 },
      })
      .setOrigin(0, 0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => void send());
    this.chatSendBtn = btn;
    this.layerContainer.add(btn);
  }

  private startPolling(): void {
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
    this.pollTimer = window.setInterval(() => void this.pollMessages(), 5000);
  }

  private async pollMessages(): Promise<void> {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime) return;
    try {
      const newMsgs = await runtime.api.clanMessages(this.latestMessageId);
      if (!this.scene.isActive()) return;
      if (newMsgs.length === 0) return;
      if (!this.my) return;
      this.my.messages = [...(this.my.messages ?? []), ...newMsgs];
      const last = newMsgs[newMsgs.length - 1]!;
      this.latestMessageId = Number(last.id);
      // Re-render chat pane only (cheap — only ~50 rows)
      const listX = 20;
      const listY = HUD_H + 70;
      const listW = 240;
      const listH = this.scale.height - listY - 80;
      const chatX = listX + listW + 20;
      const chatY = listY;
      const chatW = this.scale.width - chatX - 20;
      const chatH = listH;
      this.renderMessages(chatX, chatY, chatW, chatH);
    } catch (err) {
      console.debug('poll failed', err);
    }
  }

  // Lightweight prompt: pick a unit kind from the standard attacker
  // roster, type a count (1..10), submit. Server posts a "🤝 X
  // requests …" message into the existing clan chat, so the rest of
  // the clan sees the ask via the regular polling stream.
  private async openRequestPrompt(): Promise<void> {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime) return;
    // Native window.prompt is good enough as a first-pass UI here —
    // ClanScene already mixes DOM (chat input) with Phaser, and a
    // proper modal would be a larger UI investment than this MVP
    // warrants. Replace with a real picker once the loop is proven.
    const kindRaw = window.prompt(
      'Which unit do you want to request?\nOptions: SoldierAnt, WorkerAnt, DirtDigger, Wasp, FireAnt, Termite, Dragonfly, Mantis, Scarab',
      'SoldierAnt',
    );
    if (!kindRaw) return;
    const kind = kindRaw.trim();
    const countRaw = window.prompt('How many? (1–10)', '5');
    if (!countRaw) return;
    const count = Math.floor(Number(countRaw));
    if (!Number.isFinite(count) || count <= 0) {
      await openAlert('Bad count', 'Enter a positive integer 1–10.');
      return;
    }
    try {
      await runtime.api.clanRequestUnits(kind as Types.UnitKind, count);
      // Side-effect chat message will arrive via the next poll cycle;
      // no need to manually refresh here.
    } catch (err) {
      await openAlert('Request failed', (err as Error).message);
    }
  }

  private async confirmLeave(): Promise<void> {
    const ok = await openConfirm({
      title: 'Leave this clan?',
      body: "You'll lose your place on the chat and the clan perks. You can join another at any time.",
      confirmLabel: 'Leave clan',
      cancelLabel: 'Stay',
      danger: true,
    });
    if (!ok) return;
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime) return;
    try {
      await runtime.api.clanLeave();
      if (!this.scene.isActive()) return;
      this.cleanup();
      this.my = null;
      this.view = 'outsider';
      this.chatContainer.removeAll(true);
      void this.refreshMy();
    } catch (err) {
      await openAlert('Leave failed', (err as Error).message);
    }
  }

  // -- Outsider view: browse + create ----------------------------------------

  private async renderOutsiderView(): Promise<void> {
    this.layerContainer.removeAll(true);
    this.chatContainer.removeAll(true);
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime) return;

    this.layerContainer.add(
      crispText(
        this,
        this.scale.width / 2,
        HUD_H + 14,
        'Browse clans or create your own',
        bodyTextStyle(14, COLOR.textPrimary),
      ).setOrigin(0.5),
    );

    const createBtn = makeHiveButton(this, {
      x: this.scale.width - 92,
      y: HUD_H + 14,
      width: 164,
      height: 36,
      label: 'Create clan',
      variant: 'primary',
      fontSize: 12,
      onPress: () => this.openCreateForm(),
    });
    this.layerContainer.add(createBtn.container);

    try {
      this.browseLoaded = await runtime.api.clanBrowse();
      if (!this.scene.isActive()) return;
      this.renderBrowseList();
    } catch (err) {
      if (!this.scene.isActive()) return;
      this.statusText(`Error: ${(err as Error).message}`);
    }
  }

  private renderBrowseList(): void {
    const rows = this.browseLoaded ?? [];
    if (rows.length === 0) {
      this.layerContainer.add(
        this.add
          .text(
            this.scale.width / 2,
            HUD_H + 80,
            'No open clans yet — create the first one!',
            {
              fontFamily: 'ui-monospace, monospace',
              fontSize: '13px',
              color: '#9cb98a',
            },
          )
          .setOrigin(0.5),
      );
      return;
    }
    const maxW = Math.min(600, this.scale.width - 32);
    const ox = (this.scale.width - maxW) / 2;
    const rowH = 60;
    rows.forEach((c, i) => {
      const y = HUD_H + 60 + i * (rowH + 6);
      const bg = this.add.graphics();
      drawPanel(bg, ox, y, maxW, rowH, {
        topColor: COLOR.bgCard,
        botColor: COLOR.bgInset,
        stroke: COLOR.outline,
        strokeWidth: 2,
        highlight: COLOR.brass,
        highlightAlpha: 0.08,
        radius: 12,
        shadowOffset: 3,
        shadowAlpha: 0.2,
      });
      this.layerContainer.add(bg);
      this.layerContainer.add(
        this.add
          .text(ox + 14, y + 10, `[${c.tag}] ${c.name}`, {
            fontFamily: 'ui-monospace, monospace',
            fontSize: '14px',
            color: '#ffd98a',
          })
          .setOrigin(0, 0),
      );
      this.layerContainer.add(
        this.add
          .text(
            ox + 14,
            y + 34,
            c.description || ' ',
            {
              fontFamily: 'ui-monospace, monospace',
              fontSize: '11px',
              color: '#c3e8b0',
              wordWrap: { width: maxW - 160 },
            },
          )
          .setOrigin(0, 0),
      );
      this.layerContainer.add(
        this.add
          .text(ox + maxW - 90, y + rowH / 2, `👥 ${c.memberCount}`, {
            fontFamily: 'ui-monospace, monospace',
            fontSize: '12px',
            color: '#9cb98a',
          })
          .setOrigin(0, 0.5),
      );
      const joinBtn = makeHiveButton(this, {
        x: ox + maxW - 52,
        y: y + rowH / 2,
        width: 76,
        height: 34,
        label: 'Join',
        variant: 'secondary',
        fontSize: 12,
        onPress: () => void this.commitJoin(c.id),
      });
      this.layerContainer.add(joinBtn.container);
    });
  }

  private async commitJoin(clanId: string): Promise<void> {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime) return;
    try {
      await runtime.api.clanJoin(clanId);
      if (!this.scene.isActive()) return;
      await this.refreshMy();
    } catch (err) {
      alert((err as Error).message);
    }
  }

  private openCreateForm(): void {
    openClanCreateModal({
      onSubmit: async (values) => {
        const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
        if (!runtime) throw new Error('Offline — cannot create clan');
        await runtime.api.clanCreate({
          name: values.name,
          tag: values.tag,
          description: values.description,
          isOpen: values.isOpen,
        });
        // refreshMy re-fetches the player's clan + renders the list;
        // scene.restart wipes the stale "no clan yet" render so the
        // freshly-created clan actually appears immediately.
        if (this.scene.isActive()) this.scene.restart();
      },
    });
  }
}
