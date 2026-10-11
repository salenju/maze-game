/**
 * 游戏状态机与移动逻辑。
 *
 * 移动模型（关键设计）：
 * 不做像素级碰撞，而是「把指针位置映射成目标格 → 在迷宫图上 BFS 求路径 → 沿路径匀速滑行」。
 * 理由：
 *   - 不可能穿墙（路径只在走廊上走），不需要调参碰撞盒；
 *   - 不会抖动或卡在墙角（格子图是离散的，没有胶着状态）；
 *   - 指针落在哪个方向就朝哪个方向绕过去，天然产生「顺着走廊滑」的手感；
 *   - 每次目标格变化做一次 BFS，576 格规模下开销可忽略。
 * 代价：小人不会完全跟手贴住笔尖，而是沿合法路径追赶 —— 这正是我们要的「被墙约束」。
 */

import {
  canMove,
  cellIndex,
  generateMaze,
  placeCollectibles,
  solve,
  type Cell,
  type Maze,
} from '../core/maze';
import { mulberry32, randomSeed, type Rng } from '../core/rng';
import { type Difficulty } from '../core/difficulty';

/** 小人的移动速度，单位：格/秒。6 岁孩子也能跟得上，又不至于快到失去控制感。 */
const SPEED_CELLS_PER_SEC = 6.5;
/** 视为「已在格中心」的阈值 */
const ARRIVE_EPSILON = 0.02;

export type Phase = 'playing' | 'paused' | 'won';

export interface Footprint {
  index: number;
  /** 记录时间（秒），用于淡出与限长 */
  at: number;
}

export interface WinResult {
  seconds: number;
  stars: number;
  totalStars: number;
  /** 是否曾显示过提示箭头 */
  usedHint: boolean;
}

export interface GameEvents {
  onStar?(collected: number, total: number): void;
  onBump?(): void;
  onWin?(result: WinResult): void;
}

export class Game {
  readonly maze: Maze;
  readonly difficulty: Difficulty;
  readonly seed: number;
  /** 星星位置（固定不变），是否已吃用 starTaken 标记 */
  readonly starCells: readonly Cell[];
  readonly solution: readonly Cell[];

  private readonly events: GameEvents;
  private readonly rng: Rng;
  private readonly starTaken: boolean[];

  /** 小人位置（格坐标，浮点表示格与格之间的插值） */
  private px: number;
  private py: number;
  /** 剩余路径（格中心序列） */
  private path: Cell[] = [];
  private targetCell: Cell | null = null;

  private phase: Phase = 'playing';
  private elapsed = 0;
  private starsCollected = 0;
  private usedHint = false;
  private lastProgressAt = 0;
  private hintVisible = false;
  private bumpCooldown = 0;
  private readonly footprints: Footprint[] = [];
  private readonly visitedStamp = new Map<number, number>();

  constructor(difficulty: Difficulty, seed: number, events: GameEvents = {}) {
    this.difficulty = difficulty;
    this.seed = seed >>> 0;
    this.rng = mulberry32(this.seed);
    this.events = events;

    // 同一个 rng 依次生成迷宫与收集物 → (难度, 种子) 完全可复现
    this.maze = generateMaze(
      { cols: difficulty.cols, rows: difficulty.rows, braid: difficulty.braid },
      this.rng,
    );
    this.starCells = placeCollectibles(this.maze, difficulty.stars);
    this.starTaken = this.starCells.map(() => false);
    this.solution = solve(this.maze);

    this.px = this.maze.start.x;
    this.py = this.maze.start.y;
    this.markVisited(this.px, this.py);
  }

  static newSeed(): number {
    return randomSeed();
  }

  get phaseNow(): Phase {
    return this.phase;
  }

  get seconds(): number {
    return this.elapsed;
  }

  get collected(): number {
    return this.starsCollected;
  }

  get totalStars(): number {
    return this.starCells.length;
  }

  get showHint(): boolean {
    return this.hintVisible;
  }

  get playerPos(): { x: number; y: number } {
    return { x: this.px, y: this.py };
  }

  get playerCell(): Cell {
    return { x: Math.round(this.px), y: Math.round(this.py) };
  }

  /** 该星星是否已被吃掉。 */
  isStarTaken(i: number): boolean {
    return this.starTaken[i] === true;
  }

  footprintList(): readonly Footprint[] {
    return this.footprints;
  }

  visitedAt(x: number, y: number): number | null {
    const v = this.visitedStamp.get(cellIndex(this.maze, x, y));
    return v === undefined ? null : v;
  }

  pause(): void {
    if (this.phase === 'playing') this.phase = 'paused';
  }

  resume(): void {
    if (this.phase === 'paused') this.phase = 'playing';
  }

  /**
   * 指针拖动：设定目标格。
   * 只在按下期间调用（由 UI 层保证）。松手即停止跟随，
   * 否则「点一下远处就自动走过去」会把迷宫变成自动寻路，玩法就没了。
   */
  dragTo(cellX: number, cellY: number): void {
    if (this.phase !== 'playing') return;

    const tx = clamp(Math.floor(cellX), 0, this.maze.cols - 1);
    const ty = clamp(Math.floor(cellY), 0, this.maze.rows - 1);

    if (this.targetCell && this.targetCell.x === tx && this.targetCell.y === ty) return;

    const from = this.playerCell;
    this.targetCell = { x: tx, y: ty };

    if (from.x === tx && from.y === ty) {
      this.path = [];
      return;
    }

    // 若指针方向上紧邻的那面是墙，给一次撞墙反馈。
    // 注意：路径仍会绕过去，所以这是纯粹的感官提示，不是惩罚。
    this.maybeBump(from, tx, ty);

    this.path = solve(this.maze, from, this.targetCell);
  }

  /** 松手：停止跟随，但保留一格缓冲让小人优雅停下，而不是骤然急停。 */
  releasePointer(): void {
    this.targetCell = null;
    if (this.path.length > 1) this.path = this.path.slice(0, 2);
  }

  private maybeBump(from: Cell, tx: number, ty: number): void {
    if (this.bumpCooldown > 0) return;

    const dx = tx - from.x;
    const dy = ty - from.y;
    if (dx === 0 && dy === 0) return;

    // 取主导轴作为「孩子想去的方向」
    const dir = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 1 : 3) : dy > 0 ? 2 : 0;
    if (canMove(this.maze, from.x, from.y, dir as 0 | 1 | 2 | 3)) return;

    this.bumpCooldown = 0.3;
    this.events.onBump?.();
  }

  update(dt: number): void {
    if (this.phase !== 'playing') return;

    this.elapsed += dt;
    if (this.bumpCooldown > 0) this.bumpCooldown = Math.max(0, this.bumpCooldown - dt);

    const hintDelay = this.difficulty.hintDelayMs;
    if (hintDelay !== null && !this.hintVisible) {
      if ((this.elapsed - this.lastProgressAt) * 1000 >= hintDelay) {
        this.hintVisible = true;
        this.usedHint = true;
      }
    }

    this.advance(dt);
    this.collectStars();
    this.checkWin();
  }

  private advance(dt: number): void {
    if (this.path.length === 0) return;

    let budget = SPEED_CELLS_PER_SEC * dt;

    while (budget > 0) {
      // 已是路径最后一个节点
      if (this.path.length < 2) {
        this.path = [];
        return;
      }

      const next = this.path[1] as Cell;
      // 只接受相邻的一步；否则路径已失效，安全丢弃
      if (!this.isAdjacentStep(this.px, this.py, next.x, next.y)) {
        this.path = [];
        return;
      }

      const dx = next.x - this.px;
      const dy = next.y - this.py;
      const dist = Math.abs(dx) + Math.abs(dy);

      if (dist <= ARRIVE_EPSILON) {
        this.px = next.x;
        this.py = next.y;
        this.path.shift();
        this.markVisited(this.px, this.py);
        continue;
      }

      if (budget >= dist) {
        this.px = next.x;
        this.py = next.y;
        this.path.shift();
        this.markVisited(this.px, this.py);
        budget -= dist;
      } else {
        this.px += (dx / dist) * budget;
        this.py += (dy / dist) * budget;
        budget = 0;
        // 停在格子中间也留足迹，避免视觉断点
        this.markVisited(this.px, this.py);
      }
    }
  }

  /** 浮点位置与目标格是否构成「同一格或紧邻一格」。 */
  private isAdjacentStep(px: number, py: number, bx: number, by: number): boolean {
    const axr = Math.round(px);
    const ayr = Math.round(py);
    if (axr === bx && ayr === by) return true;
    return Math.abs(axr - bx) + Math.abs(ayr - by) === 1;
  }

  private atCell(cell: Cell): boolean {
    return Math.abs(this.px - cell.x) < 0.12 && Math.abs(this.py - cell.y) < 0.12;
  }

  private markVisited(x: number, y: number): void {
    const xi = clamp(Math.round(x), 0, this.maze.cols - 1);
    const yi = clamp(Math.round(y), 0, this.maze.rows - 1);
    const idx = cellIndex(this.maze, xi, yi);
    if (this.visitedStamp.has(idx)) return;
    this.visitedStamp.set(idx, this.elapsed);
    this.footprints.push({ index: idx, at: this.elapsed });
  }

  private collectStars(): void {
    for (let i = 0; i < this.starCells.length; i++) {
      if (this.starTaken[i] === true) continue;
      const s = this.starCells[i] as Cell;
      if (Math.abs(this.px - s.x) > 0.5 || Math.abs(this.py - s.y) > 0.5) continue;

      this.starTaken[i] = true;
      this.starsCollected++;
      this.lastProgressAt = this.elapsed;
      this.hintVisible = false;
      this.events.onStar?.(this.starsCollected, this.totalStars);
    }
  }

  /**
   * 通关判定：**只要到达出口就算赢**，星星是额外奖励而非门槛。
   * 刻意如此：环路迷宫允许绕开星星直达出口，
   * 若把星星设为必要条件，孩子会在出口前被莫名拦住，那是最典型的挫败点。
   */
  private checkWin(): void {
    if (this.phase !== 'playing') return;
    if (!this.atCell(this.maze.exit)) return;

    this.phase = 'won';
    this.events.onWin?.({
      seconds: this.elapsed,
      stars: this.starsCollected,
      totalStars: this.totalStars,
      usedHint: this.usedHint,
    });
  }

  /**
   * 提示：返回「从当前格出发应该走的下一格」。
   *
   * 这里刻意不用预计算的 start→exit 解路径去匹配最近点：
   * 那样算出来的目标可能离当前位置有 2 格以上（孩子偏离主线时尤其明显），
   * 而箭头只按上下左右四个方向绘制，指到 2 格外的格子方向就是错的。
   * 改为从当前位置直接 BFS 到出口，取路径第 2 格 —— 必定与当前位置相邻，
   * 且在当前走廊网络内真实可走，孩子照着走一步就一定是对的。
   */
  hintNextStep(): Cell | null {
    const route = solve(this.maze, this.playerCell, this.maze.exit);
    if (route.length < 2) return null;
    return route[1] ?? null;
  }

  /** 当前位置到出口还剩几格。 */
  remainingSteps(): number {
    const route = solve(this.maze, this.playerCell, this.maze.exit);
    return Math.max(0, route.length - 1);
  }

  /** 已走过的格子数，用于结算展示「探索度」。 */
  get exploredCount(): number {
    return this.visitedStamp.size;
  }

  get mazeCellCount(): number {
    return this.maze.cols * this.maze.rows;
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
