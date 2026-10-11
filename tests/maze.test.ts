import { describe, expect, it } from 'vitest';
import {
  deadEndCount,
  generateMaze,
  hasWall,
  openings,
  placeCollectibles,
  solve,
  type Dir,
  DX,
  DY,
} from '../src/core/maze';
import { mulberry32 } from '../src/core/rng';
import { clampCustom, LIMITS, PRESETS, presetById } from '../src/core/difficulty';

/** 从起点做洪水填充，验证所有格子都可达。 */
function reachableCount(cols: number, rows: number, walls: Uint8Array): number {
  const maze = { cols, rows, walls, start: { x: 0, y: 0 }, exit: { x: cols - 1, y: rows - 1 } };
  const seen = new Uint8Array(cols * rows);
  const stack = [0];
  seen[0] = 1;
  let count = 1;
  while (stack.length > 0) {
    const cur = stack.pop() as number;
    const cx = cur % cols;
    const cy = (cur - cx) / cols;
    for (const dir of [0, 1, 2, 3] as Dir[]) {
      if (hasWall(maze, cx, cy, dir)) continue;
      const nx = cx + (DX[dir] ?? 0);
      const ny = cy + (DY[dir] ?? 0);
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const ni = ny * cols + nx;
      if (seen[ni] === 1) continue;
      seen[ni] = 1;
      count++;
      stack.push(ni);
    }
  }
  return count;
}

/** 墙体必须成对：我这侧有墙，邻居那侧也必须有墙。 */
function wallsAreConsistent(cols: number, rows: number, walls: Uint8Array): boolean {
  const OPP: Dir[] = [2, 3, 0, 1];
  const maze = { cols, rows, walls, start: { x: 0, y: 0 }, exit: { x: cols - 1, y: rows - 1 } };
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      for (const dir of [0, 1, 2, 3] as Dir[]) {
        const nx = x + (DX[dir] ?? 0);
        const ny = y + (DY[dir] ?? 0);
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const here = hasWall(maze, x, y, dir);
        const there = hasWall(maze, nx, ny, OPP[dir] as Dir);
        if (here !== there) return false;
      }
    }
  }
  return true;
}

describe('迷宫生成', () => {
  it('所有预设尺寸都能生成完全连通的迷宫（50 个种子）', () => {
    for (const preset of PRESETS) {
      for (let s = 0; s < 50; s++) {
        const maze = generateMaze(
          { cols: preset.cols, rows: preset.rows, braid: preset.braid },
          mulberry32(s * 7919 + 13),
        );
        expect(reachableCount(maze.cols, maze.rows, maze.walls)).toBe(maze.cols * maze.rows);
      }
    }
  });

  it('墙体成对，不存在半面墙', () => {
    for (const preset of PRESETS) {
      for (let s = 0; s < 20; s++) {
        const maze = generateMaze(
          { cols: preset.cols, rows: preset.rows, braid: preset.braid },
          mulberry32(s + 99),
        );
        expect(wallsAreConsistent(maze.cols, maze.rows, maze.walls)).toBe(true);
      }
    }
  });

  it('起点到出口必然有解，且解路径相邻且合法', () => {
    for (const preset of PRESETS) {
      for (let s = 0; s < 30; s++) {
        const maze = generateMaze(
          { cols: preset.cols, rows: preset.rows, braid: preset.braid },
          mulberry32(s * 31 + 7),
        );
        const path = solve(maze);
        expect(path.length).toBeGreaterThan(1);
        expect(path[0]).toEqual(maze.start);
        expect(path[path.length - 1]).toEqual(maze.exit);

        // 每一步必须相邻且无墙
        for (let i = 1; i < path.length; i++) {
          const a = path[i - 1]!;
          const b = path[i]!;
          expect(Math.abs(a.x - b.x) + Math.abs(a.y - b.y)).toBe(1);
          const dir = (b.x > a.x ? 1 : b.x < a.x ? 3 : b.y > a.y ? 2 : 0) as Dir;
          expect(hasWall(maze, a.x, a.y, dir)).toBe(false);
        }
      }
    }
  });

  it('同一难度 + 同一种子生成完全相同的迷宫', () => {
    const a = generateMaze({ cols: 12, rows: 12, braid: 0.3 }, mulberry32(12345));
    const b = generateMaze({ cols: 12, rows: 12, braid: 0.3 }, mulberry32(12345));
    expect(Array.from(a.walls)).toEqual(Array.from(b.walls));
  });

  it('不同种子生成不同迷宫（避免种子被忽略）', () => {
    const a = generateMaze({ cols: 12, rows: 12, braid: 0.3 }, mulberry32(1));
    const b = generateMaze({ cols: 12, rows: 12, braid: 0.3 }, mulberry32(2));
    expect(Array.from(a.walls)).not.toEqual(Array.from(b.walls));
  });

  it('braid 越大死胡同越少（方向性必须正确，这是最容易写反的地方）', () => {
    const size = 16;
    const avg = (braid: number) => {
      let total = 0;
      const n = 25;
      for (let s = 0; s < n; s++) {
        total += deadEndCount(generateMaze({ cols: size, rows: size, braid }, mulberry32(s * 17 + 3)));
      }
      return total / n;
    };

    const none = avg(0);
    const some = avg(0.3);
    const lots = avg(0.9);

    // braid 必须单调降低死胡同数量
    expect(some).toBeLessThan(none);
    expect(lots).toBeLessThan(some);
    // braid=0.9 时应几乎消灭死胡同
    expect(lots).toBeLessThan(none * 0.25);
  });

  it('braid=0 时保留大量死胡同（挑战档的手感基础）', () => {
    const maze = generateMaze({ cols: 14, rows: 14, braid: 0 }, mulberry32(42));
    expect(deadEndCount(maze)).toBeGreaterThan(10);
  });

  it('普通格子的通道数在 1..4 之间', () => {
    const maze = generateMaze({ cols: 10, rows: 10, braid: 0.5 }, mulberry32(5));
    for (let y = 0; y < maze.rows; y++) {
      for (let x = 0; x < maze.cols; x++) {
        const n = openings(maze, x, y).length;
        expect(n).toBeGreaterThanOrEqual(1);
        expect(n).toBeLessThanOrEqual(4);
      }
    }
  });

  it('最小尺寸 2x2 也能工作', () => {
    const maze = generateMaze({ cols: 2, rows: 2, braid: 0 }, mulberry32(1));
    expect(reachableCount(2, 2, maze.walls)).toBe(4);
    expect(solve(maze).length).toBeGreaterThan(1);
  });
});

describe('星星放置', () => {
  it('星星落在解答路径上，且不与起终点重合', () => {
    for (let s = 0; s < 20; s++) {
      const maze = generateMaze({ cols: 14, rows: 14, braid: 0.25 }, mulberry32(s * 13 + 1));
      const stars = placeCollectibles(maze, 4);
      const path = solve(maze);
      const key = (c: { x: number; y: number }) => `${c.x},${c.y}`;
      const pathKeys = new Set(path.map(key));

      expect(stars.length).toBeLessThanOrEqual(4);
      for (const star of stars) {
        expect(pathKeys.has(key(star))).toBe(true);
        expect(key(star)).not.toBe(key(maze.start));
        expect(key(star)).not.toBe(key(maze.exit));
      }
      // 无重复
      expect(new Set(stars.map(key)).size).toBe(stars.length);
    }
  });

  it('请求 0 颗星星时返回空数组', () => {
    const maze = generateMaze({ cols: 8, rows: 8, braid: 0 }, mulberry32(3));
    expect(placeCollectibles(maze, 0)).toEqual([]);
  });

  it('请求数量超过路径容量时不会越界或重复', () => {
    const maze = generateMaze({ cols: 6, rows: 6, braid: 0.6 }, mulberry32(9));
    const stars = placeCollectibles(maze, 50);
    const keys = new Set(stars.map((c) => `${c.x},${c.y}`));
    expect(keys.size).toBe(stars.length);
    expect(stars.length).toBeLessThanOrEqual(solve(maze).length - 2);
  });
});

describe('难度配置', () => {
  it('预设的 braid 与难度递减关系一致：越简单 braid 越高', () => {
    // PRESETS 按从易到难排列，braid 必须单调不增
    for (let i = 1; i < PRESETS.length; i++) {
      const easier = PRESETS[i - 1]!;
      const harder = PRESETS[i]!;
      expect(harder.braid).toBeLessThanOrEqual(easier.braid);
      expect(harder.cols).toBeGreaterThanOrEqual(easier.cols);
    }
  });

  it('低龄档不计时且保留足迹，挑战档才收紧', () => {
    expect(presetById('starter').timed).toBe(false);
    expect(presetById('starter').footprint).toBe('always');
    expect(presetById('hard').timed).toBe(true);
    expect(presetById('hard').footprint).toBe('none');
  });

  it('未知 id 回退到入门档而不是崩溃', () => {
    expect(presetById('不存在的难度').id).toBe('starter');
  });

  it('自定义参数被夹紧到合法范围', () => {
    const wild = clampCustom({
      cols: 999,
      rows: -5,
      braid: 7,
      stars: 100,
      footprintFadeSec: 0,
    });
    expect(wild.cols).toBe(LIMITS.maxCols);
    expect(wild.rows).toBe(LIMITS.minRows);
    expect(wild.braid).toBe(1);
    expect(wild.footprintFadeSec).toBe(1);
    // 星星数量随格子数收敛，不会出现「星星比格子还多」
    expect(wild.stars).toBeLessThanOrEqual((wild.cols * wild.rows) / 12);
  });

  it('自定义的空输入给出可用默认值', () => {
    const d = clampCustom({});
    expect(d.id).toBe('custom');
    expect(d.cols).toBeGreaterThanOrEqual(LIMITS.minCols);
    expect(d.rows).toBeGreaterThanOrEqual(LIMITS.minRows);
  });
});

describe('随机数', () => {
  it('同一种子产生相同序列', () => {
    const a = mulberry32(777);
    const b = mulberry32(777);
    for (let i = 0; i < 100; i++) expect(a()).toBe(b());
  });

  it('输出落在 [0,1)', () => {
    const r = mulberry32(2024);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
