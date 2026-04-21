import { Sim, Types } from '@hive/shared';

// Captures a player-drawn polyline on the raid viewport and emits a
// PheromonePath ready to feed the sim. Uses snap-to-grid waypoints as a
// mobile fallback — drawing smooth curves while zoomed is hard on touch.
//
// Simplification rule: consecutive points within `MIN_SEGMENT_PX` are
// dropped so the polyline stays small (< 30 waypoints) and the replay
// payload stays tiny.

const MIN_SEGMENT_PX = 18;
const MAX_POINTS = 32;

export type TrailListener = (path: Types.PheromonePath) => void;

export interface TrailCapture {
  screenToTile(px: number, py: number): { tx: number; ty: number };
  unitKind: Types.UnitKind;
  count: number;
  spawnLayer: Types.Layer;
}

export class PheromoneTrail {
  private isDrawing = false;
  private screenPoints: Array<{ x: number; y: number }> = [];

  constructor(
    private readonly onCommit: TrailListener,
    private readonly cap: TrailCapture,
  ) {}

  start(x: number, y: number): void {
    this.isDrawing = true;
    this.screenPoints = [{ x, y }];
  }

  move(x: number, y: number): void {
    if (!this.isDrawing) return;
    const last = this.screenPoints[this.screenPoints.length - 1]!;
    const dx = x - last.x;
    const dy = y - last.y;
    if (dx * dx + dy * dy < MIN_SEGMENT_PX * MIN_SEGMENT_PX) return;
    if (this.screenPoints.length >= MAX_POINTS) return;
    this.screenPoints.push({ x, y });
  }

  end(): void {
    if (!this.isDrawing) return;
    this.isDrawing = false;
    if (this.screenPoints.length < 2) {
      this.screenPoints = [];
      return;
    }
    const tilePoints: Types.PheromonePoint[] = this.screenPoints.map((p) => {
      const { tx, ty } = this.cap.screenToTile(p.x, p.y);
      return { x: Sim.fromFloat(tx), y: Sim.fromFloat(ty) };
    });
    this.onCommit({
      pathId: 0, // assigned by sim deploy system
      spawnLayer: this.cap.spawnLayer,
      unitKind: this.cap.unitKind,
      count: this.cap.count,
      points: tilePoints,
    });
    this.screenPoints = [];
  }

  currentScreenPoints(): Array<{ x: number; y: number }> {
    return this.screenPoints;
  }

  get active(): boolean {
    return this.isDrawing;
  }
}
