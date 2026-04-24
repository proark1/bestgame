import Phaser from 'phaser';
import type { HiveRuntime } from '../main.js';
import { fadeInScene, fadeToScene } from '../ui/transitions.js';
import { drawSceneAmbient } from '../ui/sceneFrame.js';
import { makeHiveButton } from '../ui/button.js';
import { crispText } from '../ui/text.js';
import { drawPanel } from '../ui/panel.js';
import { drawQueenSilhouette } from '../ui/queenPortrait.js';
import {
  COLOR,
  bodyTextStyle,
  displayTextStyle,
  labelTextStyle,
} from '../ui/theme.js';

// PrologueScene — a scripted "first session magic" sequence. Shown
// once when tutorial_stage < 10, narrates the opening beats of the
// lore (drawn from STORY.md), and hands off to the Campaign chapter 1
// "Awakening" mission as the first real raid.
//
// The scene is intentionally simple: a vignette of 4 slides, each a
// line of Queen dialog, tap-to-advance. The last slide's primary CTA
// drops the player straight into the first scripted mission.
//
// Server contract: POST /player/tutorial with {stage: N} is called on
// each advance, clamped max at 100 (== finished). Keeps the stage
// server-side so a guest session carries over.

interface Slide {
  portraitText: string;
  heading: string;
  body: string;
  cta: string;
}

const SLIDES: ReadonlyArray<Slide> = [
  {
    portraitText: 'YOUR QUEEN',
    heading: 'The sun rises on the backyard.',
    body:
      'The old hive has fractured. You are its youngest queen. ' +
      'Your scouts have found a rival outpost beyond the moss line.',
    cta: 'Continue',
  },
  {
    portraitText: 'YOUR QUEEN',
    heading: 'You remember the pheromone.',
    body:
      'To send your colony somewhere, you trace a path in your mind. ' +
      'Your warriors will follow it — drawn, literally, by the scent.',
    cta: 'Continue',
  },
  {
    portraitText: 'YOUR QUEEN',
    heading: 'One path at first.',
    body:
      'Later you will learn to raid through the tunnels too — underneath. ' +
      'Today, one path. One win. Prove you can.',
    cta: 'Continue',
  },
  {
    portraitText: 'YOUR QUEEN',
    heading: "Let's take our first base.",
    body:
      'The Red Scout colony is watching from the pebbles. Deploy the worker ants ' +
      'along a path into their queen chamber and take the loot.',
    cta: 'Begin Mission 1: Awakening',
  },
];

export class PrologueScene extends Phaser.Scene {
  private slide = 0;
  private container!: Phaser.GameObjects.Container;

  constructor() { super('PrologueScene'); }

  create(): void {
    fadeInScene(this);
    this.cameras.main.setBackgroundColor('#0f1b10');
    drawSceneAmbient(this);
    this.container = this.add.container(0, 0);
    this.renderSlide();
  }

  private renderSlide(): void {
    this.container.removeAll(true);
    const slide = SLIDES[this.slide]!;
    const maxW = Math.min(540, this.scale.width - 32);
    const cx = this.scale.width / 2;
    const cy = this.scale.height / 2;
    const top = cy - 220;

    // Panel
    const bg = this.add.graphics();
    drawPanel(bg, cx - maxW / 2, top, maxW, 420, {
      topColor: COLOR.bgPanelHi,
      botColor: COLOR.bgPanelLo,
      stroke: COLOR.brassDeep,
      strokeWidth: 3,
      highlight: COLOR.brass,
      highlightAlpha: 0.14,
      radius: 18,
      shadowOffset: 6,
      shadowAlpha: 0.36,
    });
    this.container.add(bg);

    // Queen portrait (silhouette, no skin metadata needed at this stage)
    const portrait = drawQueenSilhouette(this, cx, top + 80, 52, null);
    this.container.add(portrait);
    this.container.add(
      crispText(this, cx, top + 150, slide.portraitText,
        labelTextStyle(11, COLOR.textMuted),
      ).setOrigin(0.5, 0),
    );

    this.container.add(
      crispText(this, cx, top + 188, slide.heading,
        displayTextStyle(20, COLOR.textGold, 4),
      ).setOrigin(0.5, 0),
    );
    this.container.add(
      crispText(this, cx, top + 228, slide.body,
        bodyTextStyle(14, COLOR.textPrimary),
      ).setOrigin(0.5, 0).setWordWrapWidth(maxW - 48, true).setAlign('center'),
    );

    const progress = crispText(this, cx, top + 352,
      `Slide ${this.slide + 1} / ${SLIDES.length}`,
      labelTextStyle(11, COLOR.textMuted),
    ).setOrigin(0.5, 0);
    this.container.add(progress);

    const btn = makeHiveButton(this, {
      x: cx,
      y: top + 380,
      width: Math.min(340, maxW - 32),
      height: 48,
      label: slide.cta,
      variant: 'primary',
      fontSize: 15,
      onPress: () => { void this.advance(); },
    });
    this.container.add(btn.container);

    if (this.slide > 0) {
      const backBtn = makeHiveButton(this, {
        x: cx - 180,
        y: top + 380,
        width: 80,
        height: 36,
        label: 'Back',
        variant: 'ghost',
        fontSize: 12,
        onPress: () => { this.slide = Math.max(0, this.slide - 1); this.renderSlide(); },
      });
      this.container.add(backBtn.container);
    }
    // Skip link (tiny) for returning guests
    const skip = crispText(this, this.scale.width - 24, this.scale.height - 24,
      'Skip intro',
      bodyTextStyle(11, COLOR.textMuted),
    ).setOrigin(1, 1).setInteractive({ useHandCursor: true });
    skip.on('pointerdown', () => { void this.finish(); });
    this.container.add(skip);
  }

  private async advance(): Promise<void> {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (runtime) {
      try { await runtime.api.setTutorialStage(this.slide + 1); } catch { /* best effort */ }
    }
    if (this.slide < SLIDES.length - 1) {
      this.slide++;
      this.renderSlide();
      return;
    }
    await this.finish();
  }

  private async finish(): Promise<void> {
    const runtime = this.registry.get('runtime') as HiveRuntime | undefined;
    if (runtime) {
      try { await runtime.api.setTutorialStage(100); } catch { /* best effort */ }
      // Mark first mission as target so RaidScene wires campaign submit.
      this.registry.set('campaignMission', {
        missionId: 101,
        chapterId: 1,
        title: 'Awakening',
      });
      fadeToScene(this, 'RaidScene');
      return;
    }
    fadeToScene(this, 'HomeScene');
  }
}

export function shouldShowPrologue(runtime: HiveRuntime | undefined): boolean {
  if (!runtime?.player) return false;
  const stage = runtime.player.player.tutorialStage ?? 0;
  return stage < 5;
}
