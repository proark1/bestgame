import Phaser from 'phaser';
import { fadeInScene, fadeToScene } from '../ui/transitions.js';
import { installSceneClickDebug } from '../ui/clickDebug.js';
import { openClanCreateModal } from '../ui/clanCreateModal.js';
import type { HiveRuntime } from '../main.js';
import type { ClanMyResponse, ClanSummary } from '../net/Api.js';

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

  constructor() {
    super('ClanScene');
  }

  create(): void {
    fadeInScene(this);
    installSceneClickDebug(this);
    this.cameras.main.setBackgroundColor('#0f1b10');
    this.drawHud();
    this.layerContainer = this.add.container(0, 0);
    this.chatContainer = this.add.container(0, 0);
    void this.refreshMy();
    this.events.once('shutdown', () => this.cleanup());
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
    const g = this.add.graphics();
    g.fillStyle(0x0a120c, 1);
    g.fillRect(0, 0, this.scale.width, HUD_H);
    g.fillStyle(0x1a2b1a, 1);
    g.fillRect(0, HUD_H - 2, this.scale.width, 2);
    this.add
      .text(16, HUD_H / 2, '← Home', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '14px',
        color: '#c3e8b0',
        backgroundColor: '#1a2b1a',
        padding: { left: 10, right: 10, top: 6, bottom: 6 },
      })
      .setOrigin(0, 0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => {
        this.cleanup();
        fadeToScene(this, 'HomeScene');
      });
    this.add
      .text(this.scale.width / 2, HUD_H / 2, '👥 Clan', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '18px',
        color: '#ffd98a',
      })
      .setOrigin(0.5);
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
    this.layerContainer.add(
      this.add
        .text(this.scale.width / 2, HUD_H + 80, msg, {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '14px',
          color: '#c3e8b0',
        })
        .setOrigin(0.5),
    );
  }

  // -- Member view: members list on the left, chat on the right --------------

  private renderMemberView(): void {
    this.layerContainer.removeAll(true);
    this.chatContainer.removeAll(true);
    if (!this.my?.clan) return;
    const clan = this.my.clan;
    const title = this.add
      .text(
        this.scale.width / 2,
        HUD_H + 18,
        `[${clan.tag}] ${clan.name}`,
        {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '16px',
          color: '#ffd98a',
        },
      )
      .setOrigin(0.5);
    this.layerContainer.add(title);
    if (clan.description) {
      this.layerContainer.add(
        this.add
          .text(this.scale.width / 2, HUD_H + 40, clan.description, {
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
    mBg.fillStyle(0x141f11, 0.9);
    mBg.lineStyle(1, 0x2c5a23, 1);
    mBg.fillRoundedRect(listX, listY, listW, listH, 8);
    mBg.strokeRoundedRect(listX, listY, listW, listH, 8);
    this.layerContainer.add(mBg);
    this.layerContainer.add(
      this.add
        .text(listX + 10, listY + 10, `Members (${this.my.members?.length ?? 0})`, {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '12px',
          color: '#ffd98a',
        })
        .setOrigin(0, 0),
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

    // Leave button
    const leaveBtn = this.add
      .text(listX + listW / 2, listY + listH - 28, 'Leave clan', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '12px',
        color: '#d94c4c',
        backgroundColor: '#2a1e1e',
        padding: { left: 12, right: 12, top: 6, bottom: 6 },
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    leaveBtn.on('pointerdown', () => void this.confirmLeave());
    this.layerContainer.add(leaveBtn);

    // Chat pane — right column
    const chatX = listX + listW + 20;
    const chatY = listY;
    const chatW = this.scale.width - chatX - 20;
    const chatH = listH;
    const cBg = this.add.graphics();
    cBg.fillStyle(0x141f11, 0.9);
    cBg.lineStyle(1, 0x2c5a23, 1);
    cBg.fillRoundedRect(chatX, chatY, chatW, chatH, 8);
    cBg.strokeRoundedRect(chatX, chatY, chatW, chatH, 8);
    this.layerContainer.add(cBg);

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

  private async confirmLeave(): Promise<void> {
    if (!confirm('Leave this clan?')) return;
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
      alert(`Leave failed: ${(err as Error).message}`);
    }
  }

  // -- Outsider view: browse + create ----------------------------------------

  private async renderOutsiderView(): Promise<void> {
    this.layerContainer.removeAll(true);
    this.chatContainer.removeAll(true);
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (!runtime) return;

    this.layerContainer.add(
      this.add
        .text(this.scale.width / 2, HUD_H + 14, 'Browse clans or create your own', {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '14px',
          color: '#c3e8b0',
        })
        .setOrigin(0.5),
    );

    const createBtn = this.add
      .text(this.scale.width - 20, HUD_H + 14, '✦ Create new clan', {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '13px',
        color: '#0f1b10',
        backgroundColor: '#ffd98a',
        padding: { left: 12, right: 12, top: 6, bottom: 6 },
      })
      .setOrigin(1, 0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => this.openCreateForm());
    this.layerContainer.add(createBtn);

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
      bg.fillStyle(0x141f11, 0.9);
      bg.lineStyle(1, 0x2c5a23, 1);
      bg.fillRoundedRect(ox, y, maxW, rowH, 8);
      bg.strokeRoundedRect(ox, y, maxW, rowH, 8);
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
      const joinBtn = this.add
        .text(ox + maxW - 14, y + rowH / 2, 'Join', {
          fontFamily: 'ui-monospace, monospace',
          fontSize: '13px',
          color: '#ffffff',
          backgroundColor: '#3a7f3a',
          padding: { left: 12, right: 12, top: 6, bottom: 6 },
        })
        .setOrigin(1, 0.5)
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', () => void this.commitJoin(c.id));
      this.layerContainer.add(joinBtn);
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
