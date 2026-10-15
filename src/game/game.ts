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
  DX,
  DY,
  E,
  generateMaze,
  inMaze,
  N,
  pingPongIndex,
  placeCollectibles,
  placeFakeExits,
  placeGuards,
  S,
  solve,
  W,
  type Cell,
  type Dir,
  type Maze,
} from '../core/maze';
import { mulberry32, randomSeed, type Rng } from '../core/rng';
import { type Difficulty } from '../core/difficulty';

/** 小人的移动速度，单位：格/秒。6 岁孩子也能跟得上，又不至于快到失去控制感。 */
const SPEED_CELLS_PER_SEC = 6.5;
/** 视为「已在格中心」的阈值 */
const ARRIVE_EPSILON = 0.02;
/**
 * 每次「笔尖进入新格子」后，小球最多沿规划路径前进的格数。
 *
 * 这是防作弊的核心闸门，也是整个移动模型的正确性基础：
 * 路径只在小球真正移动笔尖时重算，且每次重算只放行有限格数，
 * 因此「把笔尖按在出口上不动」最多前进这么多格就必然停住 —— 无法自动通关。
 *
 * 手感上的权衡：取 5 格（约 0.77 秒滑行）足以覆盖孩子连续划一笔的推进量，
 * 不会出现走走停停；同时远小于任何迷宫的完整解答长度。
 */
const MOVE_BURST_CELLS = 5;

/**
 * 单次补额度相对本局解路径步数的安全比例。
 *
 * 为什么需要它：方形迷宫靠「解路径步数 ≥ (cols-1)+(rows-1) ≥ 10」论证
 * MOVE_BURST_CELLS=5 一定安全，但**形状迷宫不成立** ——
 * 6×6 星形的图上直径只有 7 步，5 格额度已经是它的 71%，
 * 万一 `dragTo` 的额度在某个边界路径上多补一次，就会逼近甚至走完。
 *
 * 因此把额度再夹一次：`budget = min(5, ceil(步数 * 0.5))`。
 * 任何迷宫下额度都严格小于一半路程，且至少 1 格，手感不受影响。
 */
const MOVE_BURST_RATIO = 0.5;

/**
 * 巡逻怪的移动速度（格/秒）。刻意明显慢于小球的 6.5：
 * 怪是「会动的障碍」，不是「追着人跑的敌人」—— 孩子要能算准时机钻过去，
 * 而不是被一只跑得比自己快的怪反复按在起点上。
 */
const GUARD_SPEED_CELLS_PER_SEC = 2.2;

/** 被抓后回到起点时的无敌时间（秒）。避免刚复活就被同一只怪再抓一次。 */
const CAUGHT_GRACE_SEC = 2;

/** 抓到时红闪的持续时间（秒），纯视觉反馈。 */
const CAUGHT_FLASH_SEC = 0.6;

export type Phase = 'playing' | 'paused' | 'won' | 'lost';

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

/** 超时失败的结果。与 WinResult 分开，避免「失败但字段名叫 win」这种自相矛盾。 */
export interface LoseResult {
  seconds: number;
  timeLimit: number;
  stars: number;
  totalStars: number;
  /** 是否已经撞到过假出口 */
  foundFakeExits: number;
}

export interface GameEvents {
  onStar?(collected: number, total: number): void;
  onBump?(): void;
  onWin?(result: WinResult): void;
  /** 走到假出口上（不是通关，只是一次「此路不通」的反馈） */
  onFakeExit?(index: number): void;
  /** 被巡逻怪碰到，已送回起点 */
  onCaught?(): void;
  /** 限时耗尽 */
  onLose?(result: LoseResult): void;
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

  /**
   * 假出口。它们与真出口长得一模一样，踩上去只会得到「此路不通」的反馈，
   * 绝不触发通关 —— 真正的判定在 checkWin，永远只认真出口。
   */
  readonly fakeExitCells: readonly Cell[];
  private readonly fakeExitFound: boolean[];

  /** 巡逻怪的路线（格序列）。怪沿它在两端之间往返。 */
  private readonly guardPaths: readonly Cell[][];
  /** 每只怪沿路线走过的「节点单位」长度，支持浮点插值 */
  private readonly guardU: number[];
  /** 每只怪当前的插值坐标（格坐标，浮点） */
  private readonly guardPos: { x: number; y: number }[] = [];

  /** 被怪抓到后的无敌剩余时间 */
  private caughtGrace = 0;
  /** 抓到时红闪的剩余强度 0..1，供渲染层做反馈 */
  private caughtFlash = 0;

  /**
   * 视野可见集（沿走廊 BFS，1=可见）。
   * null 表示「本局不做视野限制」，此时一切都可见。
   */
  private visible: Uint8Array | null = null;
  /** 上面那张可见集是以哪一格为中心算出来的，用于避免每帧重算 */
  private visibleCenter: Cell | null = null;

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
  /** 笔尖当前所在格，用于识别「是否移动到了新格子」 */
  private pointerCell: Cell | null = null;
  /** 本轮剩余可前进格数；笔尖每次进入新格子都会重置 */
  private moveBudget = 0;
  /**
   * 本局单次补额度的上限。
   * 形状迷宫的解答可能很短，因此按解路径步数夹紧，见 MOVE_BURST_RATIO。
   */
  private readonly burstCells: number;
  /** 本次按下期间笔尖是否真的移动过（用于区分「拖动」与「轻点」） */
  private pointerMoved = false;
  private readonly footprints: Footprint[] = [];
  private readonly visitedStamp = new Map<number, number>();

  constructor(difficulty: Difficulty, seed: number, events: GameEvents = {}) {
    this.difficulty = difficulty;
    this.seed = seed >>> 0;
    this.rng = mulberry32(this.seed);
    this.events = events;

    // 同一个 rng 依次生成迷宫与收集物 → (难度, 种子) 完全可复现
    this.maze = generateMaze(
      {
        cols: difficulty.cols,
        rows: difficulty.rows,
        braid: difficulty.braid,
        shape: difficulty.shape,
        branchiness: difficulty.branchiness,
      },
      this.rng,
    );
    // 顺序刻意固定：假出口（不用 rng）→ 巡逻怪 → 星星。
    // 数量为 0 时这两个函数在碰随机数之前就返回了，
    // 因此「全图可见、无假门、无怪」的既有档位拿到的地图与从前逐字节相同。
    this.fakeExitCells = placeFakeExits(this.maze, difficulty.fakeExits);
    this.fakeExitFound = this.fakeExitCells.map(() => false);
    this.guardPaths = placeGuards(this.maze, difficulty.guards, this.rng);
    // 多只怪从路线的不同位置起步，一开局不会全叠在一起
    this.guardU = this.guardPaths.map((_, i) => i * 2.5);
    for (const path of this.guardPaths) {
      const head = path[0] as Cell;
      this.guardPos.push({ x: head.x, y: head.y });
    }
    this.starCells = placeCollectibles(this.maze, difficulty.stars);
    this.starTaken = this.starCells.map(() => false);
    this.solution = solve(this.maze);
    this.burstCells = burstCellsFor(this.solution.length);

    this.px = this.maze.start.x;
    this.py = this.maze.start.y;
    this.markVisited(this.px, this.py);
    this.refreshVisibility();
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

  /** 剩余时间（秒）。不限时时为 null，调用方据此决定 HUD 显示什么。 */
  get timeLeft(): number | null {
    const limit = this.difficulty.timeLimitSec;
    if (limit === null) return null;
    return Math.max(0, limit - this.elapsed);
  }

  /** 本局是否开视野限制。null = 全图可见。 */
  get viewRadius(): number | null {
    return this.difficulty.viewRadius;
  }

  /** 被怪抓到时红闪的剩余强度 0..1（渲染层用）。 */
  get caughtFlashLevel(): number {
    return this.caughtFlash;
  }

  /** 是否处于被抓后的无敌时间（渲染层用它把小球画成闪烁状态）。 */
  get isGracePeriod(): boolean {
    return this.caughtGrace > 0;
  }

  /** 某格当前是否在视野内。不做视野限制时恒为 true。 */
  isVisibleCell(x: number, y: number): boolean {
    const vis = this.visible;
    if (!vis) return true;
    if (!inMaze(this.maze, x, y)) return false;
    return vis[cellIndex(this.maze, x, y)] === 1;
  }

  /** 某格是否走过。视野限制下「走过」的格子会留在记忆里，只是变暗。 */
  hasVisitedCell(x: number, y: number): boolean {
    return this.visitedStamp.has(cellIndex(this.maze, x, y));
  }

  /** 该假出口是否已经被识破（渲染层据此把它灰化打叉）。 */
  isFakeExitFound(i: number): boolean {
    return this.fakeExitFound[i] === true;
  }

  get foundFakeExits(): number {
    return this.fakeExitFound.filter(Boolean).length;
  }

  /** 巡逻怪当前的位置（格坐标，浮点）。渲染层直接画。 */
  guardPositions(): readonly { x: number; y: number }[] {
    return this.guardPos;
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

  /**
   * 笔尖当前所在格（已吸附到形状内的合法格），供渲染层画落点方框。
   *
   * 必须用这个而不是拿原始屏幕坐标自己 floor：形状迷宫的指针可能落在
   * 掩码之外，直接换算会在迷宫外面画出一个孤零零的方框。
   */
  get pointerTargetCell(): Cell | null {
    return this.pointerCell;
  }

  /** 该星星是否已被吃掉。 */
  isStarTaken(i: number): boolean {
    return this.starTaken[i] === true;
  }

  footprintList(): readonly Footprint[] {
    return this.footprints;
  }

  pause(): void {
    if (this.phase === 'playing') this.phase = 'paused';
  }

  resume(): void {
    if (this.phase === 'paused') this.phase = 'playing';
  }

  /**
   * 指针按下：只记录落点，**不规划路径、不授予前进额度**。
   *
   * 这是「轻点不会让小球自己走」的关键。移动只能由笔尖的移动产生：
   * 孩子按住小黄球（或随手指一下远处）而笔尖不动时，小球必须原地待命。
   * 早前在按下时就授予 5 格额度，导致点一下星星小球就自己走过去
   * （实测：按住不动 600ms 会移动 4 格）。
   */
  beginPointer(cellX: number, cellY: number): void {
    if (this.phase !== 'playing') return;

    this.pointerCell = this.snapToMaze(cellX, cellY);
    this.pointerMoved = false;
    this.targetCell = null;
    this.path = [];
    this.moveBudget = 0;
  }

  /**
   * 指针拖动：笔尖进入新格子时才规划路径并补充额度。
   *
   * 防作弊的关键：**只有笔尖真的移动到新格子，才重新规划路径并补充前进额度**。
   * 笔尖停在原地不换格时这里直接返回，小球用完当前额度就停住 ——
   * 因此「把笔尖按在出口上不动」不可能自动通关（已实测过此缺陷）。
   */
  dragTo(cellX: number, cellY: number): void {
    if (this.phase !== 'playing') return;

    const snapped = this.snapToMaze(cellX, cellY);
    const tx = snapped.x;
    const ty = snapped.y;

    const sameCell =
      this.pointerCell !== null && this.pointerCell.x === tx && this.pointerCell.y === ty;
    if (sameCell) return; // 笔尖没换格 → 不重算、不补充额度

    this.pointerCell = { x: tx, y: ty };
    this.pointerMoved = true;
    // 笔尖进入新格子：补充前进额度，并重算到该格的路径
    this.moveBudget = this.burstCells;

    const from = this.playerCell;
    this.targetCell = { x: tx, y: ty };

    if (from.x === tx && from.y === ty) {
      this.path = [];
      return;
    }

    // 若指针方向上紧邻的那面是墙，给一次撞墙反馈（纯感官提示，不惩罚）
    this.maybeBump(from, tx, ty);

    this.path = solve(this.maze, from, this.targetCell);
  }

  /**
   * 松手：停止跟随，但保留一格缓冲让小人优雅停下，而不是骤然急停。
   *
   * 纯轻点（笔尖自始至终没换过格）不授予任何额度，小球必须原地不动。
   */
  releasePointer(): void {
    this.targetCell = null;
    this.pointerCell = null;
    this.moveBudget = this.pointerMoved ? 1 : 0;
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
    if (this.caughtGrace > 0) this.caughtGrace = Math.max(0, this.caughtGrace - dt);
    if (this.caughtFlash > 0) {
      this.caughtFlash = Math.max(0, this.caughtFlash - dt / CAUGHT_FLASH_SEC);
    }

    // 限时判定放在推进之前：宁可让孩子在最后一帧被「时间到」拦下，
    // 也不要出现「一帧里既通关又超时」的两种结算同时触发。
    const limit = this.difficulty.timeLimitSec;
    if (limit !== null && this.elapsed >= limit) {
      this.phase = 'lost';
      this.events.onLose?.({
        seconds: this.elapsed,
        timeLimit: limit,
        stars: this.starsCollected,
        totalStars: this.totalStars,
        foundFakeExits: this.foundFakeExits,
      });
      return;
    }

    const hintDelay = this.difficulty.hintDelayMs;
    if (hintDelay !== null && !this.hintVisible) {
      if ((this.elapsed - this.lastProgressAt) * 1000 >= hintDelay) {
        this.hintVisible = true;
        this.usedHint = true;
      }
    }

    this.moveGuards(dt);
    this.advance(dt);
    this.refreshVisibility();
    this.collectStars();
    this.checkFakeExits();
    // 通关判定排在「被抓」之前：小球已经站在出口上就该赢，
    // 不该因为旁边恰好有只怪路过而被抹掉这一局的胜利。
    this.checkWin();
    this.checkCaught();
  }

  /**
   * 让巡逻怪沿各自的路线往返。
   *
   * 位置用「沿路线走过的节点单位数 u」表示，真实下标由 pingPongIndex 折返出来，
   * 再在相邻两格之间线性插值 —— 这样怪是平滑滑行而不是一格一格跳。
   */
  private moveGuards(dt: number): void {
    for (let i = 0; i < this.guardPaths.length; i++) {
      const path = this.guardPaths[i] as Cell[];
      if (path.length < 2) continue;

      this.guardU[i] = (this.guardU[i] ?? 0) + GUARD_SPEED_CELLS_PER_SEC * dt;
      const k = pingPongIndex(this.guardU[i] as number, path.length);
      const a = Math.min(path.length - 2, Math.floor(k));
      const f = k - a;
      const from = path[a] as Cell;
      const to = path[a + 1] as Cell;
      const pos = this.guardPos[i];
      if (!pos) continue;
      pos.x = from.x + (to.x - from.x) * f;
      pos.y = from.y + (to.y - from.y) * f;
    }
  }

  /**
   * 重算视野可见集。
   *
   * 用「沿走廊的 BFS 步数」而不是欧氏半径：后者能隔着墙看见隔壁走廊，
   * 在岔路密集的迷宫里等于白送一半答案。BFS 计步连拐角都看不见，
   * 孩子必须真的走过去才知道那边有什么 —— 这才是迷雾的意义。
   *
   * 只在小球所在的整数格变化时重算，每帧重算没有意义（同一格结果必然相同）。
   */
  private refreshVisibility(): void {
    const radius = this.difficulty.viewRadius;
    if (radius === null) {
      this.visible = null;
      return;
    }

    const cell = this.playerCell;
    if (this.visibleCenter && this.visibleCenter.x === cell.x && this.visibleCenter.y === cell.y) {
      return;
    }
    this.visibleCenter = { x: cell.x, y: cell.y };

    const total = this.maze.cols * this.maze.rows;
    const vis = new Uint8Array(total);
    const dist = new Int16Array(total).fill(-1);
    const start = cellIndex(this.maze, cell.x, cell.y);
    vis[start] = 1;
    dist[start] = 0;

    const queue: number[] = [start];
    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head] as number;
      const d = dist[cur] as number;
      if (d >= radius) continue;
      const cx = cur % this.maze.cols;
      const cy = (cur - cx) / this.maze.cols;
      for (const dir of [N, E, S, W] as Dir[]) {
        if (!canMove(this.maze, cx, cy, dir)) continue;
        const nx = cx + (DX[dir] ?? 0);
        const ny = cy + (DY[dir] ?? 0);
        const ni = cellIndex(this.maze, nx, ny);
        if (dist[ni] !== -1) continue;
        dist[ni] = d + 1;
        vis[ni] = 1;
        queue.push(ni);
      }
    }
    this.visible = vis;
  }

  /**
   * 踩到假出口。
   *
   * 刻意**不惩罚**（不送回起点、不扣时间）：假门只是「此路不通」，
   * 真正让它有代价的是限时 —— 白跑一趟就烧掉了时间。
   * 一旦识破就永久标记，渲染层会把它灰化打叉，孩子下次不用再试。
   */
  private checkFakeExits(): void {
    for (let i = 0; i < this.fakeExitCells.length; i++) {
      if (this.fakeExitFound[i] === true) continue;
      const f = this.fakeExitCells[i] as Cell;
      // 容差与吃星星一致（半格）：孩子是「滑过」这一格的，不会精确停在格心，
      // 容差收紧到 0.4 会出现「明明走过去了却没反应」。
      if (Math.abs(this.px - f.x) > 0.5 || Math.abs(this.py - f.y) > 0.5) continue;
      this.fakeExitFound[i] = true;
      this.events.onFakeExit?.(i);
    }
  }

  /** 撞上巡逻怪：红闪 + 送回起点，已收集的星星保留。 */
  private checkCaught(): void {
    // 本帧已经通关时就不要再抓人了：checkWin 排在前面，
    // 若此刻仍执行抓捕，小球会被送回起点、并留下一个再也衰减不掉的红色闪光
    // （update 在结算后不再被调用），结算页背后会一直透出红光。
    if (this.phase !== 'playing') return;
    if (this.caughtGrace > 0) return;

    for (const p of this.guardPos) {
      const dx = p.x - this.px;
      const dy = p.y - this.py;
      if (dx * dx + dy * dy > 0.36) continue; // 0.6 格以内算撞上
      this.sendBackToStart();
      return;
    }
  }

  private sendBackToStart(): void {
    this.px = this.maze.start.x;
    this.py = this.maze.start.y;
    this.path = [];
    this.targetCell = null;
    this.pointerCell = null;
    this.pointerMoved = false;
    this.moveBudget = 0;
    this.caughtGrace = CAUGHT_GRACE_SEC;
    this.caughtFlash = 1;
    // 被送回去不算「卡住」，把提示计时的基准也刷新一下
    this.lastProgressAt = this.elapsed;
    this.hintVisible = false;
    this.refreshVisibility();
    this.events.onCaught?.();
  }

  private advance(dt: number): void {
    if (this.path.length === 0) return;

    // 前进额度耗尽 → 停住等待孩子继续移动笔尖。
    // 这是防止「按住远处不动就自动通关」的闸门（额度由 dragTo 在换格时补充）。
    if (this.moveBudget <= 0) return;

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
        this.moveBudget--;
        continue;
      }

      if (budget >= dist) {
        this.px = next.x;
        this.py = next.y;
        this.path.shift();
        this.markVisited(this.px, this.py);
        budget -= dist;
        // 每完整走完一格消耗一点额度；额度用尽即停下等待笔尖继续移动
        this.moveBudget--;
        if (this.moveBudget <= 0) return;
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

  /**
   * 把指针所在的浮点格坐标吸附到最近的合法迷宫格。
   *
   * 形状迷宫（圆/六边形/三角/星）有一大片「外接矩形内、图形外」的死区。
   * 如果只按外接矩形夹紧，孩子在圆形四角划笔时，目标格会跑到图形外的角上：
   * 那里四面皆墙、不可达，BFS 直接返回空路径 —— 表现为「划了半天球不动」。
   *
   * 因此：不在 mask 内时，改成找最近的 mask 内格子。
   * 效果上等同于「笔尖贴着墙走」，与方形迷宫撞墙绕行的手感一致。
   */
  private snapToMaze(cellX: number, cellY: number): Cell {
    const maze = this.maze;
    const bx = clamp(Math.floor(cellX), 0, maze.cols - 1);
    const by = clamp(Math.floor(cellY), 0, maze.rows - 1);
    if (inMaze(maze, bx, by)) return { x: bx, y: by };

    let bestX = bx;
    let bestY = by;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let y = 0; y < maze.rows; y++) {
      for (let x = 0; x < maze.cols; x++) {
        if (!inMaze(maze, x, y)) continue;
        // 用平方距离，避免开方；并列时取更靠左上的格子，保证结果稳定
        const d = (x - bx) * (x - bx) + (y - by) * (y - by);
        if (d < bestDist || (d === bestDist && x + y < bestX + bestY)) {
          bestDist = d;
          bestX = x;
          bestY = y;
        }
      }
    }
    return { x: bestX, y: bestY };
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

/**
 * 单次补额度：常规取 MOVE_BURST_CELLS，但绝不超过本局解路径步数的一半。
 *
 * 这是形状迷宫带来的新要求。方形迷宫可以靠「起终点曼哈顿距离 ≥ 10」证明
 * MOVE_BURST_CELLS=5 永远安全，但形状迷宫的图上直径可能只有 7 步
 * （实测 6×6 星形），5 格额度就太大了。
 * 夹到一半以后，任何迷宫下「按住不动」最多走到路程的一半，绝不可能通关。
 * 下限取 1：再短的迷宫也保证孩子拖一下能动，不会变成完全不走。
 */
function burstCellsFor(solutionLength: number): number {
  const steps = Math.max(1, solutionLength - 1);
  return Math.max(1, Math.min(MOVE_BURST_CELLS, Math.ceil(steps * MOVE_BURST_RATIO)));
}
