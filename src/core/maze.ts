/**
 * 迷宫数据结构与生成算法。
 *
 * 墙体用位掩码表示，每个格子一个字节：
 *   bit0 = 北墙, bit1 = 东墙, bit2 = 南墙, bit3 = 西墙
 * 初始 15（四面皆墙），打通时同时清除两侧的墙，保证墙体始终成对。
 *
 * 坐标：x 向右、y 向下，原点在左上角。小朋友的直觉是「左上出发、右下到达」。
 */

import { shuffle, type Rng } from './rng';

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
  readonly start: Cell;
  readonly exit: Cell;
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
}

export function cellIndex(maze: Pick<Maze, 'cols'>, x: number, y: number): number {
  return y * maze.cols + x;
}

export function inBounds(maze: Pick<Maze, 'cols' | 'rows'>, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < maze.cols && y < maze.rows;
}

export function hasWall(maze: Maze, x: number, y: number, dir: Dir): boolean {
  const idx = cellIndex(maze, x, y);
  return ((maze.walls[idx] ?? ALL_WALLS) & (WALL_BIT[dir] ?? 0)) !== 0;
}

/** 从 (x,y) 朝 dir 是否能走（目标格在界内且无墙）。 */
export function canMove(maze: Maze, x: number, y: number, dir: Dir): boolean {
  if (hasWall(maze, x, y, dir)) return false;
  const nx = x + (DX[dir] ?? 0);
  const ny = y + (DY[dir] ?? 0);
  return inBounds(maze, nx, ny);
}

function carve(maze: Maze, x: number, y: number, dir: Dir): void {
  const nx = x + (DX[dir] ?? 0);
  const ny = y + (DY[dir] ?? 0);
  if (!inBounds(maze, nx, ny)) return;
  const a = cellIndex(maze, x, y);
  const b = cellIndex(maze, nx, ny);
  maze.walls[a] = (maze.walls[a] ?? ALL_WALLS) & ~(WALL_BIT[dir] ?? 0);
  maze.walls[b] = (maze.walls[b] ?? ALL_WALLS) & ~(WALL_BIT[OPPOSITE[dir]] ?? 0);
}

/**
 * 递归回溯（深度优先）生成迷宫。
 *
 * 选用它的原因：走廊又长又蜿蜒，几乎不产生「只能直走」的无聊长通道，
 * 对儿童比 Prim / Kruskal 的细碎分叉更好看也更好走。
 * 用显式栈而非递归，避免最大 24x24=576 格时的调用栈压力。
 */
export function generateMaze(opts: MazeOptions, rng: Rng): Maze {
  const cols = Math.max(2, Math.floor(opts.cols));
  const rows = Math.max(2, Math.floor(opts.rows));
  const braid = Math.min(1, Math.max(0, opts.braid));

  const maze: Maze = {
    cols,
    rows,
    walls: new Uint8Array(cols * rows).fill(ALL_WALLS),
    start: { x: 0, y: 0 },
    exit: { x: cols - 1, y: rows - 1 },
  };

  const visited = new Uint8Array(cols * rows);
  const stack: number[] = [];

  // 起点固定在左上角。若随机起点，出口位置会显得毫无规律，小朋友会困惑。
  const seedIdx = cellIndex(maze, maze.start.x, maze.start.y);
  visited[seedIdx] = 1;
  stack.push(seedIdx);

  while (stack.length > 0) {
    const current = stack[stack.length - 1] as number;
    const cx = current % cols;
    const cy = (current - cx) / cols;

    // 收集所有「未访问且在界内」的邻居
    const candidates: Dir[] = [];
    for (const dir of [N, E, S, W] as Dir[]) {
      const nx = cx + (DX[dir] ?? 0);
      const ny = cy + (DY[dir] ?? 0);
      if (!inBounds(maze, nx, ny)) continue;
      if (visited[cellIndex(maze, nx, ny)] === 1) continue;
      candidates.push(dir);
    }

    if (candidates.length === 0) {
      stack.pop();
      continue;
    }

    const dir = shuffle(rng, candidates)[0] as Dir;
    carve(maze, cx, cy, dir);
    const nx = cx + (DX[dir] ?? 0);
    const ny = cy + (DY[dir] ?? 0);
    const next = cellIndex(maze, nx, ny);
    visited[next] = 1;
    stack.push(next);
  }

  braidMaze(maze, braid, rng);

  return maze;
}

/**
 * 编织：按概率打通死胡同，制造环路。
 * 环路越多 → 死路越少 → 迷宫越简单（对儿童越宽容）。
 * 只连「尚未连通」的邻居，因此不会产生多余的重复通路。
 */
function braidMaze(maze: Maze, braid: number, rng: Rng): void {
  if (braid <= 0) return;

  const cells: Cell[] = [];
  for (let y = 0; y < maze.rows; y++) {
    for (let x = 0; x < maze.cols; x++) cells.push({ x, y });
  }
  // 打乱处理顺序，避免环路系统性地偏向某种走向
  shuffle(rng, cells);

  for (const { x, y } of cells) {
    if (openings(maze, x, y).length !== 1) continue; // 只处理死胡同
    if (rng() >= braid) continue;

    const closed: Dir[] = [];
    for (const dir of [N, E, S, W] as Dir[]) {
      if (hasWall(maze, x, y, dir) && inBounds(maze, x + (DX[dir] ?? 0), y + (DY[dir] ?? 0))) {
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
      if (openings(maze, x, y).length === 1) count++;
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

/**
 * 在解答路径上均匀放置收集物（星星）。
 * 刻意放在必经之路上：6 岁孩子不会为了收集而绕路，
 * 放在支线上只会变成「看得见吃不到」的挫败来源。
 */
export function placeCollectibles(maze: Maze, count: number): Cell[] {
  if (count <= 0) return [];
  const path = solve(maze);
  if (path.length <= 2) return [];

  const interior = path.slice(1, -1); // 排除起点与终点
  if (interior.length === 0) return [];

  const n = Math.min(count, interior.length);
  const result: Cell[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / (n + 1);
    const idx = Math.min(interior.length - 1, Math.round(t * (interior.length - 1)));
    const cell = interior[idx] as Cell;
    // 去重：路径较短时 round 可能命中同一格
    if (!result.some((c) => c.x === cell.x && c.y === cell.y)) result.push(cell);
  }
  return result;
}
