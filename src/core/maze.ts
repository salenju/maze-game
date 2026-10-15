/**
 * 迷宫数据结构与生成算法。
 *
 * 墙体用位掩码表示，每个格子一个字节：
 *   bit0 = 北墙, bit1 = 东墙, bit2 = 南墙, bit3 = 西墙
 * 初始 15（四面皆墙），打通时同时清除两侧的墙，保证墙体始终成对。
 *
 * 坐标：x 向右、y 向下，原点在左上角。小朋友的直觉是「左上出发、右下到达」。
 *
 * 形状支持：除方形外的形状用 mask 描述「哪些格子属于迷宫」。
 * mask 之外的格子四面皆墙且永远不可进入，因此对生成/寻路/渲染都是透明的。
 */

import { shuffle, type Rng } from './rng';
import { buildMask, type ShapeId } from './shape';

export const N = 0;
export const E = 1;
export const S = 2;
export const W = 3;

export type Dir = 0 | 1 | 2 | 3;

/** 各方向对应的 (dx, dy)，下标与 N/E/S/W 对齐。 */
export const DX = [0, 1, 0, -1] as const;
export const DY = [-1, 0, 1, 0] as const;

/** 相反方向。N<->S, E<->W */
export const OPPOSITE = [S, W, N, E] as const;

const WALL_BIT = [1, 2, 4, 8] as const;
const ALL_WALLS = 15;

export interface Cell {
  x: number;
  y: number;
}

export interface Maze {
  readonly cols: number;
  readonly rows: number;
  /** 长度 cols*rows，每格是墙位掩码。 */
  readonly walls: Uint8Array;
  /**
   * 长度 cols*rows，1 表示该格属于迷宫。
   * 旧测试与旧存档里可能没有这个字段，缺省视为「全是 1」，行为与方形迷宫一致。
   */
  readonly mask?: Uint8Array;
  /**
   * 起点与出口。**生成期间可变**：形状迷宫的起终点要按图上距离挑，
   * 不能像方形那样直接写死左上/右下。生成结束后不应再改动。
   */
  start: Cell;
  exit: Cell;
  /** 迷宫形状，仅用于渲染与说明；缺省按 'square' 处理。 */
  readonly shape?: ShapeId;
}

export interface MazeOptions {
  cols: number;
  rows: number;
  /**
   * 环路强度 0..1。
   * 注意：**值越大迷宫越简单**。它按此概率打通死胡同的墙，
   * 死胡同变少 → 走错后更容易绕回来 → 对小朋友更友好。
   * 这是最容易写反的参数，所以在这里写死注释。
   */
  braid: number;
  /** 形状，缺省方形。 */
  shape?: ShapeId;
  /**
   * 岔路密度 0..1。
   * 注意：**值越大迷宫越难**，方向与 braid 相反。
   *
   * 它控制生长树算法「从最深处继续钻」还是「从已有区域随机挑一处开新岔」：
   *   0 → 一直往最深处钻（纯深度优先）：走廊又长又蜿蜒，岔路极少，最容易走；
   *   1 → 每次都随机挑（纯 Prim）：到处是短岔路与死胡同，决策点最多，最难走。
   * 孩子说的「岔路口太少、没难度」就是这条参数在起作用。
   */
  branchiness?: number;
}

export function cellIndex(maze: Pick<Maze, 'cols'>, x: number, y: number): number {
  return y * maze.cols + x;
}

export function inBounds(maze: Pick<Maze, 'cols' | 'rows'>, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < maze.cols && y < maze.rows;
}

/** 该格是否属于迷宫（界内且在 mask 内）。没有 mask 时等价于 inBounds。 */
export function inMaze(
  maze: Pick<Maze, 'cols' | 'rows'> & { mask?: Uint8Array },
  x: number,
  y: number,
): boolean {
  if (!inBounds(maze, x, y)) return false;
  const mask = maze.mask;
  if (!mask) return true;
  return mask[y * maze.cols + x] === 1;
}

export function hasWall(maze: Maze, x: number, y: number, dir: Dir): boolean {
  const idx = cellIndex(maze, x, y);
  return ((maze.walls[idx] ?? ALL_WALLS) & (WALL_BIT[dir] ?? 0)) !== 0;
}

/**
 * 从 (x,y) 朝 dir 是否能走。
 *
 * 两个条件缺一不可：目标格必须属于迷宫（形状 mask 之外一格都进不去），
 * 且两侧之间没有墙。
 */
export function canMove(maze: Maze, x: number, y: number, dir: Dir): boolean {
  if (hasWall(maze, x, y, dir)) return false;
  return inMaze(maze, x + (DX[dir] ?? 0), y + (DY[dir] ?? 0));
}

function carve(maze: Maze, x: number, y: number, dir: Dir): void {
  const nx = x + (DX[dir] ?? 0);
  const ny = y + (DY[dir] ?? 0);
  if (!inMaze(maze, nx, ny)) return;
  const a = cellIndex(maze, x, y);
  const b = cellIndex(maze, nx, ny);
  maze.walls[a] = (maze.walls[a] ?? ALL_WALLS) & ~(WALL_BIT[dir] ?? 0);
  maze.walls[b] = (maze.walls[b] ?? ALL_WALLS) & ~(WALL_BIT[OPPOSITE[dir]] ?? 0);
}

/**
 * 生成迷宫：生长树算法（growing tree），用 branchiness 调「纵深 ↔ 岔路」。
 *
 * 为什么不是纯深度优先（递归回溯）：纯 DFS 只从最深处继续钻，
 * 结果是一条长长的蛇形走廊，岔路口极少 —— 孩子会正确地说「没啥难度」。
 * 为什么不是纯 Prim：到处是短岔路，走廊碎，6 岁孩子容易烦躁。
 *
 * 生长树取两者之间：维护一个「已访问但还有未访问邻居」的边界列表，
 * 每次按 branchiness 决定从**最新**（往深处钻）还是从**随机**（开新岔）取。
 * 一个参数就连续覆盖了「长走廊迷宫」到「密集岔路迷宫」的整段手感。
 *
 * 形状支持：mask 之外的格子永远不作为候选，因此圆形/星形等形状天然被尊重，
 * 而且生成出来的图必然连通（生长树从起点出发只会走到可达格）。
 */
export function generateMaze(opts: MazeOptions, rng: Rng): Maze {
  const cols = Math.max(2, Math.floor(opts.cols));
  const rows = Math.max(2, Math.floor(opts.rows));
  const braid = Math.min(1, Math.max(0, opts.braid));
  const branchiness = Math.min(1, Math.max(0, opts.branchiness ?? 0));
  const shape: ShapeId = opts.shape ?? 'square';

  const mask = shape === 'square' ? undefined : buildMask(shape, cols, rows);

  const maze: Maze = {
    cols,
    rows,
    walls: new Uint8Array(cols * rows).fill(ALL_WALLS),
    ...(mask ? { mask } : {}),
    start: { x: 0, y: 0 },
    exit: { x: cols - 1, y: rows - 1 },
    shape,
  };

  const visited = new Uint8Array(cols * rows);
  /** 边界列表：已访问、但还有至少一个未访问邻居的格子 */
  const frontier: number[] = [];

  const startIdx = pickStartCell(maze);
  visited[startIdx] = 1;
  frontier.push(startIdx);

  while (frontier.length > 0) {
    // branchiness=0 → 永远取最新（深度优先）；=1 → 永远随机（Prim）
    const pick = rng() < branchiness ? Math.floor(rng() * frontier.length) : frontier.length - 1;
    const current = frontier[pick] as number;

    const cx = current % cols;
    const cy = (current - cx) / cols;

    // 收集所有「未访问且在迷宫内」的邻居
    const candidates: Dir[] = [];
    for (const dir of [N, E, S, W] as Dir[]) {
      const nx = cx + (DX[dir] ?? 0);
      const ny = cy + (DY[dir] ?? 0);
      if (!inMaze(maze, nx, ny)) continue;
      if (visited[cellIndex(maze, nx, ny)] === 1) continue;
      candidates.push(dir);
    }

    if (candidates.length === 0) {
      // 该格已无未访问邻居：从边界里移除，换一个继续
      frontier.splice(pick, 1);
      continue;
    }

    const dir = shuffle(rng, candidates)[0] as Dir;
    carve(maze, cx, cy, dir);
    const nx = cx + (DX[dir] ?? 0);
    const ny = cy + (DY[dir] ?? 0);
    const next = cellIndex(maze, nx, ny);
    visited[next] = 1;
    frontier.push(next);
  }

  braidMaze(maze, braid, rng);
  placeStartAndExit(maze);

  return maze;
}

/** 起点：优先左上角；形状在那里没有格子时，退到最靠近左上角的一格。 */
function pickStartCell(maze: Maze): number {
  return nearestCellTo(maze, 0, 0, () => true);
}

function toCell(maze: Maze, idx: number): Cell {
  const x = idx % maze.cols;
  return { x, y: (idx - x) / maze.cols };
}

/**
 * 找出离 (tx,ty) 最近、满足 accept 的迷宫格子。
 *
 * 用「先按距离排序、再取第一个」而不是贪心逐格试探：
 * 距离并列时贪心会偏向扫描顺序，圆形迷宫的起点会跑到奇怪的位置。
 */
function nearestCellTo(maze: Maze, tx: number, ty: number, accept: (idx: number) => boolean): number {
  let best = -1;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let y = 0; y < maze.rows; y++) {
    for (let x = 0; x < maze.cols; x++) {
      const idx = y * maze.cols + x;
      if (!inMaze(maze, x, y)) continue;
      if (!accept(idx)) continue;
      // +0.001*idx 只是给并列距离一个稳定的打破规则，避免结果依赖实现细节
      const score = Math.abs(x - tx) + Math.abs(y - ty) + idx * 1e-6;
      if (score < bestScore) {
        bestScore = score;
        best = idx;
      }
    }
  }
  return best >= 0 ? best : 0;
}

/**
 * 起终点解路径长度的**目标值**（软下界），不是安全保证。
 *
 * 形状迷宫上新出现的问题：方形迷宫的旧论证是「曼哈顿距离 ≥ (cols-1)+(rows-1)，
 * 最小 6×6 也有 10 格」，但形状下这个论证不成立 —— 6×6 星形的图上直径只有 8 格（7 步）。
 * 这里把它当作「挑起终点时的目标」：达不到就改用精确最远点对，尽量挑得远一些。
 *
 * 真正的安全保证在 game.ts：单次补额度会被压到严格小于本局解路径步数，
 * 因此即便图形本身很扁，「按住笔尖不动」也永远走不完。两处配套，缺一不可。
 */
export const MIN_SOLUTION_CELLS = 9;

/**
 * 决定起点与出口。
 *
 * 方形沿用「左上出发、右下到达」—— 这是小朋友的直觉，也是原本的设计；
 * 方形本身也满足解路径长度下界，无需兜底。
 *
 * 其他形状的左上角与右下角根本不在图形里，因此改用图上距离：
 * 先从任意格做两次 BFS 取近似直径端点，再检查长度是否够长，
 * 不够就对所有格子做一次全源 BFS 取真正的最远点对（只在极小图上会触发）。
 */
function placeStartAndExit(maze: Maze): void {
  const shape = maze.shape ?? 'square';
  if (shape === 'square') {
    maze.start = { x: 0, y: 0 };
    maze.exit = { x: maze.cols - 1, y: maze.rows - 1 };
    return;
  }

  const diameter = approximateDiameter(maze);
  let pair = diameter;

  if (pair.dist < MIN_SOLUTION_CELLS - 1) {
    // 罕见的小图/怪比例：近似直径不够长，老实算一次精确最远点对
    pair = exactDiameter(maze);
  }

  maze.start = toCell(maze, pair.a);
  maze.exit = toCell(maze, pair.b);

  // 兜底：极端退化（比如只剩两格）时至少保证起终点不同
  const si = cellIndex(maze, maze.start.x, maze.start.y);
  const ei = cellIndex(maze, maze.exit.x, maze.exit.y);
  if (si === ei) {
    const other = nearestCellTo(maze, maze.cols - 1, maze.rows - 1, (idx) => idx !== si);
    if (other !== si) maze.exit = toCell(maze, other);
  }
}

interface CellPair {
  a: number;
  b: number;
  /** 图上距离（步数） */
  dist: number;
}

/**
 * 近似直径：从任意格出发找最远点，再从该点找最远点。
 * 树上是精确的；编织出环路后略有偏差，但足够用来挑「分居两端」的起终点。
 * 起点刻意从左上角附近取，让结果在同样子的多次调用下稳定。
 */
function approximateDiameter(maze: Maze): CellPair {
  const seed = pickStartCell(maze);
  const first = bfsFarthest(maze, seed);
  const second = bfsFarthest(maze, first.cell);
  return orderTopLeftFirst(maze, {
    a: first.cell,
    b: second.cell,
    dist: second.dist,
  });
}

/** 精确直径：对每格做一次 BFS。n 最大 576，只在近似结果不够长时才调用。 */
function exactDiameter(maze: Maze): CellPair {
  let best: CellPair = { a: 0, b: 0, dist: -1 };
  for (let y = 0; y < maze.rows; y++) {
    for (let x = 0; x < maze.cols; x++) {
      if (!inMaze(maze, x, y)) continue;
      const r = bfsFarthest(maze, cellIndex(maze, x, y));
      if (r.dist > best.dist) best = { a: cellIndex(maze, x, y), b: r.cell, dist: r.dist };
    }
  }
  return orderTopLeftFirst(maze, best);
}

/** 把更靠左上的那格作为起点：孩子习惯从左上往右下走。 */
function orderTopLeftFirst(maze: Maze, pair: CellPair): CellPair {
  const a = toCell(maze, pair.a);
  const b = toCell(maze, pair.b);
  return a.x + a.y <= b.x + b.y ? pair : { a: pair.b, b: pair.a, dist: pair.dist };
}

/** 从 from 出发 BFS，返回距离最远的一格及其距离（并列取更靠左上的）。 */
function bfsFarthest(maze: Maze, from: number): { cell: number; dist: number } {
  const dist = new Int32Array(maze.cols * maze.rows).fill(-1);
  dist[from] = 0;
  const queue = [from];
  let best = from;
  let bestDist = 0;

  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head] as number;
    const cx = cur % maze.cols;
    const cy = (cur - cx) / maze.cols;
    for (const dir of [N, E, S, W] as Dir[]) {
      if (!canMove(maze, cx, cy, dir)) continue;
      const nx = cx + (DX[dir] ?? 0);
      const ny = cy + (DY[dir] ?? 0);
      const ni = cellIndex(maze, nx, ny);
      if (dist[ni] !== -1) continue;
      dist[ni] = (dist[cur] ?? 0) + 1;
      queue.push(ni);

      const d = dist[ni] as number;
      if (d > bestDist) {
        bestDist = d;
        best = ni;
      } else if (d === bestDist) {
        // 并列时取更靠左上的格子，保证同种子结果稳定
        const bc = toCell(maze, best);
        const nc = toCell(maze, ni);
        if (nc.x + nc.y < bc.x + bc.y) best = ni;
      }
    }
  }
  return { cell: best, dist: bestDist };
}

/**
 * 编织：按概率打通死胡同，制造环路。
 * 环路越多 → 死路越少 → 迷宫越简单（对儿童越宽容）。
 * 只连「尚未连通」的邻居，因此不会产生多余的重复通路。
 *
 * 注意方向性：本函数**只减不增**岔路与死路。孩子抱怨的「岔路口太少」
 * 由生成阶段的 branchiness 负责，不要试图用 braid 去补，那只会把难度调反。
 */
function braidMaze(maze: Maze, braid: number, rng: Rng): void {
  if (braid <= 0) return;

  const cells: Cell[] = [];
  for (let y = 0; y < maze.rows; y++) {
    for (let x = 0; x < maze.cols; x++) {
      if (!inMaze(maze, x, y)) continue;
      cells.push({ x, y });
    }
  }
  // 打乱处理顺序，避免环路系统性地偏向某种走向
  shuffle(rng, cells);

  for (const { x, y } of cells) {
    if (openings(maze, x, y).length !== 1) continue; // 只处理死胡同
    if (rng() >= braid) continue;

    const closed: Dir[] = [];
    for (const dir of [N, E, S, W] as Dir[]) {
      if (hasWall(maze, x, y, dir) && inMaze(maze, x + (DX[dir] ?? 0), y + (DY[dir] ?? 0))) {
        closed.push(dir);
      }
    }
    if (closed.length === 0) continue;

    carve(maze, x, y, shuffle(rng, closed)[0] as Dir);
  }
}

/** 该格所有「可通行」的方向。 */
export function openings(maze: Maze, x: number, y: number): Dir[] {
  const result: Dir[] = [];
  for (const dir of [N, E, S, W] as Dir[]) {
    if (canMove(maze, x, y, dir)) result.push(dir);
  }
  return result;
}

/** 死胡同数量（仅一个出口的格子）。用于难度自检与测试。 */
export function deadEndCount(maze: Maze): number {
  let count = 0;
  for (let y = 0; y < maze.rows; y++) {
    for (let x = 0; x < maze.cols; x++) {
      if (!inMaze(maze, x, y)) continue;
      if (openings(maze, x, y).length === 1) count++;
    }
  }
  return count;
}

/**
 * 岔路口数量：有三个及以上出口的格子。
 *
 * 这是「迷宫难不难」最贴近孩子感受的指标 —— 孩子说的「岔路口太少、没啥难度」
 * 指的就是它。死胡同只制造「走错了」，岔路口才制造「要选哪条」。
 * 它被测试锁住：branchiness 必须单调提高它，与 braid 的方向正好相反。
 */
export function junctionCount(maze: Maze): number {
  let count = 0;
  for (let y = 0; y < maze.rows; y++) {
    for (let x = 0; x < maze.cols; x++) {
      if (!inMaze(maze, x, y)) continue;
      if (openings(maze, x, y).length >= 3) count++;
    }
  }
  return count;
}

/** 属于迷宫的格子数（形状 mask 之外的不计）。 */
export function mazeCellCount(maze: Maze): number {
  let count = 0;
  for (let y = 0; y < maze.rows; y++) {
    for (let x = 0; x < maze.cols; x++) {
      if (inMaze(maze, x, y)) count++;
    }
  }
  return count;
}

/**
 * BFS 求最短路径，返回含起点与终点的格子序列。
 * 找不到时返回空数组（生成算法保证连通，正常不会发生）。
 */
export function solve(maze: Maze, from: Cell = maze.start, to: Cell = maze.exit): Cell[] {
  const total = maze.cols * maze.rows;
  const prev = new Int32Array(total).fill(-1);
  const seen = new Uint8Array(total);

  const fromIdx = cellIndex(maze, from.x, from.y);
  const toIdx = cellIndex(maze, to.x, to.y);
  if (fromIdx === toIdx) return [from];

  const queue: number[] = [fromIdx];
  seen[fromIdx] = 1;

  for (let head = 0; head < queue.length; head++) {
    const current = queue[head] as number;
    if (current === toIdx) break;
    const cx = current % maze.cols;
    const cy = (current - cx) / maze.cols;

    for (const dir of [N, E, S, W] as Dir[]) {
      if (!canMove(maze, cx, cy, dir)) continue;
      const nx = cx + (DX[dir] ?? 0);
      const ny = cy + (DY[dir] ?? 0);
      const next = cellIndex(maze, nx, ny);
      if (seen[next] === 1) continue;
      seen[next] = 1;
      prev[next] = current;
      queue.push(next);
    }
  }

  if (seen[toIdx] !== 1) return [];

  const path: Cell[] = [];
  for (let cur = toIdx; cur !== -1; cur = prev[cur] as number) {
    const x = cur % maze.cols;
    const y = (cur - x) / maze.cols;
    path.push({ x, y });
    if (cur === fromIdx) break;
  }
  path.reverse();
  return path;
}

/** 从一个死胡同尽头往回走，直到遇到岔路口或起点/终点，途中的格子数。 */
function deadEndDepth(maze: Maze, end: Cell): number {
  let prev: Cell | null = null;
  let cur = end;
  let depth = 1;
  // 死胡同是树上的枝，不会绕回来；但要防御被人为构造的环路，加个硬上限
  for (let guard = 0; guard < maze.cols * maze.rows; guard++) {
    const next = openings(maze, cur.x, cur.y)
      .map((dir) => ({ x: cur.x + (DX[dir] ?? 0), y: cur.y + (DY[dir] ?? 0) }))
      .find((c) => !(prev && c.x === prev.x && c.y === prev.y));
    if (!next) break;
    // 走到岔路口/起终点就停：再往前就是「正路」了
    if (openings(maze, next.x, next.y).length !== 2) break;
    if (next.x === maze.start.x && next.y === maze.start.y) break;
    if (next.x === maze.exit.x && next.y === maze.exit.y) break;
    depth++;
    prev = cur;
    cur = next;
  }
  return depth;
}

/**
 * 挑一批死路尽头当「诱饵」。
 *
 * 优先挑最长的死路：越长的支线，走进去再退出来的代价越大，
 * 「这条路到底对不对」的犹豫也越久 —— 这正是要的迷惑感。
 * 同时尽量让诱饵彼此分散开，免得两个诱饵挤在同一个小角落。
 */
function pickDeadEndDecoys(maze: Maze, count: number, onPath: ReadonlySet<number>): Cell[] {
  if (count <= 0) return [];

  const candidates: { cell: Cell; depth: number }[] = [];
  for (let y = 0; y < maze.rows; y++) {
    for (let x = 0; x < maze.cols; x++) {
      if (!inMaze(maze, x, y)) continue;
      if (onPath.has(cellIndex(maze, x, y))) continue;
      if (openings(maze, x, y).length !== 1) continue;
      if (x === maze.start.x && y === maze.start.y) continue;
      if (x === maze.exit.x && y === maze.exit.y) continue;
      candidates.push({ cell: { x, y }, depth: deadEndDepth(maze, { x, y }) });
    }
  }
  // 只保留真正的「走廊尽头」，一点点小凸起（1 格深）不值得当诱饵
  const deep = candidates.filter((c) => c.depth >= 2);
  const pool = deep.length >= count ? deep : candidates;

  // 深 → 浅；同深度按格子下标，保证同一种子每次结果一致
  pool.sort(
    (a, b) => b.depth - a.depth || cellIndex(maze, a.cell.x, a.cell.y) - cellIndex(maze, b.cell.x, b.cell.y),
  );

  const MIN_GAP = 2;
  const picked: Cell[] = [];
  const farEnough = (cell: Cell) =>
    picked.every((p) => Math.max(Math.abs(p.x - cell.x), Math.abs(p.y - cell.y)) > MIN_GAP);
  for (const c of pool) {
    if (picked.length >= count) break;
    if (farEnough(c.cell)) picked.push(c.cell);
  }
  // 分散不开（小迷宫）就放宽：宁可挤一点也不少放
  for (const c of pool) {
    if (picked.length >= count) break;
    if (!picked.some((p) => p.x === c.cell.x && p.y === c.cell.y)) picked.push(c.cell);
  }
  return picked;
}

/**
 * 放置收集物（星星）：多数落在必经之路上，约三分之一扔进死路尽头当诱饵。
 *
 * 必经之路上的那些：6 岁孩子不会为了收集而绕路，全放支线上只会变成
 * 「看得见吃不到」的挫败来源，所以主星仍然沿着解答路径均匀铺开。
 *
 * 但主星全在必经之路上时，收集就毫无取舍 —— 顺着唯一正确方向走必然全吃到。
 * 于是留一部分放进死路尽头：看到岔路深处的星星得先判断那是不是正路，
 * 走错了要原路退回来。这是成年难度的「迷惑与趣味」，也是家长明确要求的做法。
 * 星星始终不是通关条件，不捡也能走出迷宫。
 *
 * 下标用「每个等分段的中心」而不是「等分点四舍五入」：
 * 后者在路径较短或星星较多时会撞格（例如 8 颗星落在 8 格路径上只能放出 5 颗），
 * 表现为「家长设了 8 颗，开局却只看到 5 颗」。中心取样在 n ≤ 路径长度时
 * 逐格递增的步长恒 ≥ 1，因此必定取到互不相同的 n 个位置，且两端各留半格。
 */
export function placeCollectibles(maze: Maze, count: number): Cell[] {
  if (count <= 0) return [];
  const path = solve(maze);
  if (path.length <= 2) return [];

  const interior = path.slice(1, -1); // 排除起点与终点
  if (interior.length === 0) return [];

  const pathKeys = new Set<number>();
  for (const c of path) pathKeys.add(cellIndex(maze, c.x, c.y));

  // 2 颗以下不放诱饵：只剩一颗星还藏进死路，就纯粹是刁难了
  const decoyTarget = count >= 3 ? Math.round(count / 3) : 0;
  const decoys = pickDeadEndDecoys(maze, decoyTarget, pathKeys);

  const onPathCount = Math.min(count - decoys.length, interior.length);
  const result: Cell[] = [...decoys];
  for (let i = 0; i < onPathCount; i++) {
    const idx = Math.floor(((i + 0.5) * interior.length) / onPathCount);
    const cell = interior[Math.min(interior.length - 1, idx)] as Cell;
    // 兜底去重：上面的取法本就不会重复，留一道保险以防公式被改动
    if (!result.some((c) => c.x === cell.x && c.y === cell.y)) result.push(cell);
  }
  return result;
}

/** 从 from 出发的 BFS 距离表；不可达为 -1。 */
function bfsDistances(maze: Maze, from: number): Int32Array {
  const dist = new Int32Array(maze.cols * maze.rows).fill(-1);
  dist[from] = 0;
  const queue: number[] = [from];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head] as number;
    const cx = cur % maze.cols;
    const cy = (cur - cx) / maze.cols;
    const d = dist[cur] as number;
    for (const dir of [N, E, S, W] as Dir[]) {
      if (!canMove(maze, cx, cy, dir)) continue;
      const nx = cx + (DX[dir] ?? 0);
      const ny = cy + (DY[dir] ?? 0);
      const ni = cellIndex(maze, nx, ny);
      if (dist[ni] !== -1) continue;
      dist[ni] = d + 1;
      queue.push(ni);
    }
  }
  return dist;
}

/**
 * 假出口与真出口的最小距离，占迷宫「图上直径」的比例。
 *
 * 为什么要有这个下限：紧挨着真出口的假门不产生任何迷惑 ——
 * 孩子走到那儿时真门已经在视野里了。假门必须真的在「另一个方向」。
 */
const FAKE_EXIT_DISTANCE_RATIO = 0.35;

/**
 * 布置假出口。
 *
 * 三条硬规则（每条都对应一种「不公平」）：
 *  1. **绝不放在解路径上**。正路上摆一个假门，等于孩子明明走在唯一正确的
 *     方向上却被弹回来，那是「游戏坏了」而不是「难」。
 *  2. **离真出口足够远**（图上距离 ≥ 直径的 35%）。否则假门就在真门旁边，
 *     一眼就能分辨，毫无迷惑价值。
 *  3. **优先挑死路尽头**，并让假门彼此分开。死路尽头的「门」最像一个目的地；
 *     挤在一起的话孩子撞一次就顺手排除一片。
 *
 * 这里刻意不用随机数：给定迷宫，假门位置就完全确定。
 * 于是「同一难度 + 同一种子」依旧整局可复现，也不会动到既有档位的随机数序列
 * （序列一变，README 里实测的岔路/死胡同数字就全对不上了）。
 */
export function placeFakeExits(maze: Maze, count: number): Cell[] {
  if (count <= 0) return [];

  const route = solve(maze);
  const onRoute = new Set<number>();
  for (const c of route) onRoute.add(cellIndex(maze, c.x, c.y));

  const distFromExit = bfsDistances(maze, cellIndex(maze, maze.exit.x, maze.exit.y));
  let diameter = 0;
  for (const d of distFromExit) {
    if (d > diameter) diameter = d;
  }
  const minDist = Math.max(4, Math.round(diameter * FAKE_EXIT_DISTANCE_RATIO));

  const candidates: { cell: Cell; deadEnd: boolean; dist: number }[] = [];
  for (let y = 0; y < maze.rows; y++) {
    for (let x = 0; x < maze.cols; x++) {
      if (!inMaze(maze, x, y)) continue;
      if (x === maze.start.x && y === maze.start.y) continue;
      if (x === maze.exit.x && y === maze.exit.y) continue;
      const idx = cellIndex(maze, x, y);
      if (onRoute.has(idx)) continue;
      const d = distFromExit[idx] as number;
      if (d < minDist) continue;
      candidates.push({ cell: { x, y }, deadEnd: openings(maze, x, y).length === 1, dist: d });
    }
  }

  // 死路尽头优先 → 离真出口更远优先 → 下标升序兜底（保证同一种子结果稳定）
  candidates.sort(
    (a, b) =>
      Number(b.deadEnd) - Number(a.deadEnd) ||
      b.dist - a.dist ||
      cellIndex(maze, a.cell.x, a.cell.y) - cellIndex(maze, b.cell.x, b.cell.y),
  );

  const MIN_GAP = 3;
  const picked: Cell[] = [];
  const farEnough = (cell: Cell) =>
    picked.every((p) => Math.max(Math.abs(p.x - cell.x), Math.abs(p.y - cell.y)) > MIN_GAP);
  for (const c of candidates) {
    if (picked.length >= count) break;
    if (farEnough(c.cell)) picked.push(c.cell);
  }
  // 小迷宫上分散不开就放宽：宁可挨着一点，也不能少放一个假门
  for (const c of candidates) {
    if (picked.length >= count) break;
    if (!picked.some((p) => p.x === c.cell.x && p.y === c.cell.y)) picked.push(c.cell);
  }
  return picked;
}

/**
 * 巡逻怪的路线。
 *
 * 为什么起点必须取在**解路径上**：随机游走如果从角落里出发，
 * 怪会在孩子根本不会去的死角里来回走，看着有威胁其实挡不住任何事。
 * 从必经之路上取起点，怪就必然在「孩子一定要经过的地方」附近活动。
 * 多只怪按比例沿解路径均匀取起点，避免全挤在一起。
 *
 * 路线本身是一段不立即回头的随机游走；运行时让怪沿路线往返（乒乓），
 * 于是它的巡逻是**可预测**的 —— 孩子看两次就能背下路线并算准时机钻过去，
 * 这才是「动脑」而不是「撞运气」。
 *
 * 路线刻意避开起点格与出口格：碰撞后小球会被送回起点，
 * 若怪正好堵在起点上就会陷入「刚复活又被抓」的死循环。
 */
export function placeGuards(maze: Maze, count: number, rng: Rng): Cell[][] {
  if (count <= 0) return [];

  const route = solve(maze);
  if (route.length < 3) return [];

  const cellTotal = mazeCellCount(maze);
  const steps = Math.min(24, Math.max(6, Math.round(cellTotal * 0.06)));

  const lo = Math.max(1, Math.round(route.length * 0.15));
  const hi = Math.max(lo, route.length - 2);

  const paths: Cell[][] = [];
  for (let g = 0; g < count; g++) {
    // 沿解路径均匀取起点：count 只怪各自守一段，不会全堆在同一处
    const frac = (g + 1) / (count + 1);
    const idx = Math.min(hi, lo + Math.round((hi - lo) * frac));
    let cur: Cell = route[idx] as Cell;
    const path: Cell[] = [{ x: cur.x, y: cur.y }];
    let prev: Cell | null = null;

    for (let i = 0; i < steps; i++) {
      const options: Cell[] = [];
      for (const dir of openings(maze, cur.x, cur.y)) {
        const nx = cur.x + (DX[dir] ?? 0);
        const ny = cur.y + (DY[dir] ?? 0);
        if (prev && nx === prev.x && ny === prev.y) continue; // 不立即原路折返
        if (nx === maze.start.x && ny === maze.start.y) continue;
        if (nx === maze.exit.x && ny === maze.exit.y) continue;
        options.push({ x: nx, y: ny });
      }
      if (options.length === 0) break;
      const next = options[Math.floor(rng() * options.length)] as Cell;
      path.push(next);
      prev = cur;
      cur = next;
    }

    // 只有一格的路线上怪站着不动，起不到巡逻作用，丢弃
    if (path.length >= 2) paths.push(path);
  }
  return paths;
}

/**
 * 怪沿路线往返（乒乓）时，连续位置对应的「浮点节点下标」。
 *
 * 把路线当成一条来回走的线段：u 从 0 增到 L-1 再折返到 0，如此循环。
 * 相比在每个节点上翻转方向标志位，这种表示不会出现「在端点上抖两下」的边界 bug。
 * 调用方按 floor(u)/frac 在相邻两格之间线性插值即可。
 */
export function pingPongIndex(u: number, pathLength: number): number {
  if (pathLength < 2) return 0;
  const period = 2 * (pathLength - 1);
  let x = u % period;
  if (x < 0) x += period;
  return x <= pathLength - 1 ? x : period - x;
}
