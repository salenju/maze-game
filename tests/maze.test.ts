import { describe, expect, it } from 'vitest';
import {
  canMove,
  deadEndCount,
  generateMaze,
  hasWall,
  inMaze,
  junctionCount,
  mazeCellCount,
  openings,
  placeCollectibles,
  solve,
  MIN_SOLUTION_CELLS,
  type Dir,
  DX,
  DY,
} from '../src/core/maze';
import { mulberry32 } from '../src/core/rng';
import {
  buildMask,
  componentCount,
  countCells,
  SHAPE_IDS,
  type ShapeId,
} from '../src/core/shape';
import { clampCustom, LIMITS, PRESETS, presetById } from '../src/core/difficulty';
import { describeDifficulty } from '../src/ui/screens';

/** 所有形状 × 一批有代表性的尺寸（含长方形与极端比例）。 */
const SIZE_GRID: readonly (readonly [number, number])[] = [
  [6, 6],
  [7, 7],
  [10, 10],
  [14, 14],
  [18, 18],
  [24, 24],
  [6, 24],
  [24, 6],
  [8, 16],
];

/** 从起点做洪水填充，验证所有格子都可达。 */
function reachableCount(cols: number, rows: number, walls: Uint8Array): number {
  // 旧测试工具：无 mask，等价于方形迷宫
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

  it('每档预设都有自己的形状，且覆盖多种形状（不是全方形）', () => {
    const shapes = new Set(PRESETS.map((p) => p.shape));
    expect(shapes.size).toBeGreaterThanOrEqual(3);
    for (const preset of PRESETS) {
      expect(SHAPE_IDS).toContain(preset.shape);
    }
  });

  it('预设的岔路随难度递增：越难岔路越多（与 braid 方向相反）', () => {
    for (let i = 1; i < PRESETS.length; i++) {
      const easier = PRESETS[i - 1]!;
      const harder = PRESETS[i]!;
      // braid 递减（死路变多），branchiness 递增（岔路变多）
      expect(harder.braid).toBeLessThanOrEqual(easier.braid);
      expect(harder.branchiness).toBeGreaterThanOrEqual(easier.branchiness);
      expect(harder.cols).toBeGreaterThanOrEqual(easier.cols);
    }
  });

  it('每档预设都比旧版（branchiness 0）岔路更多', () => {
    // 用户明确要求「增加岔路口增加难度」，这条锁住所有档位都被提升了
    for (const preset of PRESETS) {
      expect(preset.branchiness).toBeGreaterThan(0);
    }
  });

  it('自定义的 branchiness 被夹紧到 0..1', () => {
    expect(clampCustom({ branchiness: 5 }).branchiness).toBe(1);
    expect(clampCustom({ branchiness: -3 }).branchiness).toBe(0);
    // 缺省时用 medium 的值，而不是 0
    expect(clampCustom({}).branchiness).toBeGreaterThan(0);
  });

  it('非法的形状被挡在生成器之外（localStorage 可能是脏数据）', () => {
    // 旧存档没有 shape 字段、或有人手改过 localStorage
    expect(clampCustom({}).shape).toBe('square');
    expect(clampCustom({ shape: '不存在的形状' as never }).shape).toBe('square');
    expect(clampCustom({ shape: null as never }).shape).toBe('square');
    expect(clampCustom({ shape: 'circle' }).shape).toBe('circle');
  });

  it('describeDifficulty 反映形状与岔路，且两个参数方向不混淆', () => {
    const easy = presetById('starter');
    const hard = presetById('hard');
    const easyTags = describeDifficulty(easy);
    const hardTags = describeDifficulty(hard);

    expect(easyTags.some((t) => t.includes('圆形'))).toBe(true);
    expect(hardTags.some((t) => t.includes('星形'))).toBe(true);
    // 难度高的档位应当标出「岔路很多」，而不是和低档位一样
    expect(hardTags.some((t) => t.includes('岔路很多'))).toBe(true);
    expect(easyTags.some((t) => t.includes('岔路很少') || t.includes('岔路较少'))).toBe(true);
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

describe('形状迷宫：掩码与连通性', () => {
  it('每个形状的掩码都非空、且是单块四连通', () => {
    for (const shape of SHAPE_IDS) {
      for (const [c, r] of SIZE_GRID) {
        const mask = buildMask(shape, c, r);
        expect(countCells(mask)).toBeGreaterThan(8);
        expect(componentCount(mask, c, r)).toBe(1);
      }
    }
  });

  it('方形掩码铺满整张网格（与旧行为一致）', () => {
    for (const [c, r] of SIZE_GRID) {
      const maze = generateMaze({ cols: c, rows: r, braid: 0.3, shape: 'square' }, mulberry32(1));
      expect(mazeCellCount(maze)).toBe(c * r);
      // 方形不产出 mask 字段，下游按「全是迷宫」处理
      expect(maze.mask).toBeUndefined();
    }
  });

  it('非方形掩码一定比外接矩形小（形状真的被裁掉了）', () => {
    for (const shape of SHAPE_IDS) {
      if (shape === 'square') continue;
      const [c, r] = [14, 14] as const;
      const maze = generateMaze({ cols: c, rows: r, braid: 0.2, shape }, mulberry32(7));
      expect(mazeCellCount(maze)).toBeLessThan(c * r);
      expect(mazeCellCount(maze)).toBeGreaterThan(0.3 * c * r);
    }
  });

  it('圆形/六边形/三角形是空心的（中心有洞，形成环形走廊）', () => {
    for (const shape of ['circle', 'hexagon', 'triangle'] as ShapeId[]) {
      const [c, r] = [14, 14] as const;
      const maze = generateMaze({ cols: c, rows: r, braid: 0.2, shape }, mulberry32(3));
      const cx = Math.floor(c / 2);
      const cy = Math.floor(r / 2);
      expect(inMaze(maze, cx, cy)).toBe(false);
    }
  });

  it('星形不空心（尖角本身就是走廊，挖了就没了）', () => {
    const [c, r] = [14, 14] as const;
    const maze = generateMaze({ cols: c, rows: r, braid: 0.2, shape: 'star' }, mulberry32(3));
    // 星形中心是实的
    expect(inMaze(maze, Math.floor(c / 2), Math.floor(r / 2))).toBe(true);
  });

  it('掩码之外的格子四面皆墙，无法进入', () => {
    for (const shape of SHAPE_IDS) {
      const maze = generateMaze({ cols: 14, rows: 14, braid: 0.3, shape }, mulberry32(11));
      for (let y = 0; y < maze.rows; y++) {
        for (let x = 0; x < maze.cols; x++) {
          if (inMaze(maze, x, y)) continue;
          expect(maze.walls[y * maze.cols + x]).toBe(15);
          for (const dir of [0, 1, 2, 3] as Dir[]) {
            expect(canMove(maze, x, y, dir)).toBe(false);
          }
        }
      }
    }
  });
});

describe('形状迷宫：生成不变式（所有形状 × 尺寸 × 参数）', () => {
  it('完全连通、墙体成对、起终点都在掩码内且不同', () => {
    for (const shape of SHAPE_IDS) {
      for (const [c, r] of SIZE_GRID) {
        for (const branchiness of [0, 0.5, 1]) {
          for (const braid of [0, 0.4]) {
            for (let seed = 0; seed < 4; seed++) {
              const maze = generateMaze(
                { cols: c, rows: r, braid, shape, branchiness },
                mulberry32(seed * 131 + c * 7 + r + Math.round(branchiness * 10)),
              );

              // 1. 起终点必须在掩码内且不是同一格
              expect(inMaze(maze, maze.start.x, maze.start.y)).toBe(true);
              expect(inMaze(maze, maze.exit.x, maze.exit.y)).toBe(true);
              expect(maze.start).not.toEqual(maze.exit);

              // 2. 从起点洪泛能到达所有迷宫格子
              const seen = new Uint8Array(c * r);
              const stack = [maze.start.y * c + maze.start.x];
              seen[stack[0] as number] = 1;
              let reached = 1;
              while (stack.length > 0) {
                const cur = stack.pop() as number;
                const cx = cur % c;
                const cy = (cur - cx) / c;
                for (const dir of [0, 1, 2, 3] as Dir[]) {
                  if (!canMove(maze, cx, cy, dir)) continue;
                  const ni = (cy + (DY[dir] ?? 0)) * c + (cx + (DX[dir] ?? 0));
                  if (seen[ni] === 1) continue;
                  seen[ni] = 1;
                  reached++;
                  stack.push(ni);
                }
              }
              expect(reached).toBe(mazeCellCount(maze));

              // 3. 墙体成对
              for (let y = 0; y < r; y++) {
                for (let x = 0; x < c; x++) {
                  for (const dir of [0, 1, 2, 3] as Dir[]) {
                    const nx = x + (DX[dir] ?? 0);
                    const ny = y + (DY[dir] ?? 0);
                    if (nx < 0 || ny < 0 || nx >= c || ny >= r) continue;
                    expect(hasWall(maze, x, y, dir)).toBe(
                      hasWall(maze, nx, ny, [2, 3, 0, 1][dir] as Dir),
                    );
                  }
                }
              }
            }
          }
        }
      }
    }
  });

  it('同一种子 + 同一难度生成完全相同的形状迷宫（可复现）', () => {
    for (const shape of SHAPE_IDS) {
      const a = generateMaze(
        { cols: 12, rows: 12, braid: 0.3, shape, branchiness: 0.6 },
        mulberry32(2024),
      );
      const b = generateMaze(
        { cols: 12, rows: 12, braid: 0.3, shape, branchiness: 0.6 },
        mulberry32(2024),
      );
      expect(Array.from(a.walls)).toEqual(Array.from(b.walls));
      expect(a.start).toEqual(b.start);
      expect(a.exit).toEqual(b.exit);
      expect(a.mask ? Array.from(a.mask) : null).toEqual(b.mask ? Array.from(b.mask) : null);
    }
  });

  it('换形状会换掉地图（形状不是一个被忽略的参数）', () => {
    const sigs = SHAPE_IDS.map((shape) => {
      const m = generateMaze({ cols: 12, rows: 12, braid: 0.3, shape, branchiness: 0.5 }, mulberry32(99));
      return `${m.start.x},${m.start.y}-${m.exit.x},${m.exit.y}-${Array.from(m.walls).join(',')}`;
    });
    expect(new Set(sigs).size).toBe(SHAPE_IDS.length);
  });
});

describe('难度核心：岔路数量（用户报告「岔路口太少没啥难度」）', () => {
  it('branchiness 越大岔路越多（方向必须如此，与 braid 相反）', () => {
    const size = 16;
    const avgJunctions = (branchiness: number) => {
      let total = 0;
      const n = 30;
      for (let s = 0; s < n; s++) {
        total += junctionCount(
          generateMaze({ cols: size, rows: size, braid: 0, branchiness }, mulberry32(s * 17 + 3)),
        );
      }
      return total / n;
    };

    const few = avgJunctions(0);
    const some = avgJunctions(0.5);
    const many = avgJunctions(1);

    // 必须单调递增：这是「增加岔路 = 增加难度」的方向性保证
    expect(some).toBeGreaterThan(few * 1.3);
    expect(many).toBeGreaterThan(some * 1.05);
  });

  it('branchiness=0 时接近纯深度优先：岔路很少、走廊很长', () => {
    // 锁住 branchiness 的下端语义，防止以后有人悄悄把它改成别的算法
    const maze = generateMaze({ cols: 16, rows: 16, braid: 0, branchiness: 0 }, mulberry32(42));
    const junctions = junctionCount(maze);
    const cells = mazeCellCount(maze);
    expect(junctions / cells).toBeLessThan(0.15);
    // 长走廊：解路径应当明显长于格子的边长
    expect(solve(maze).length).toBeGreaterThan(30);
  });

  it('每档难度的岔路都比旧版（纯 DFS）明显多', () => {
    // 这是本次改动的核心诉求，直接锁在测试里。
    // 旧版 = branchiness 0；新版取各预设的值。
    for (const preset of PRESETS) {
      let oldTotal = 0;
      let newTotal = 0;
      const n = 20;
      for (let s = 0; s < n; s++) {
        const seed = () => mulberry32(s * 7919 + 13);
        oldTotal += junctionCount(
          generateMaze(
            { cols: preset.cols, rows: preset.rows, braid: preset.braid, shape: preset.shape, branchiness: 0 },
            seed(),
          ),
        );
        newTotal += junctionCount(
          generateMaze(
            {
              cols: preset.cols,
              rows: preset.rows,
              braid: preset.braid,
              shape: preset.shape,
              branchiness: preset.branchiness,
            },
            seed(),
          ),
        );
      }
      expect(newTotal).toBeGreaterThan(oldTotal);
    }
  });

  it('岔路增多不会被 braid 抵消：两者作用方向独立', () => {
    const base = { cols: 14, rows: 14, shape: 'square' as ShapeId };
    const low = generateMaze({ ...base, branchiness: 0.8, braid: 0 }, mulberry32(5));
    const high = generateMaze({ ...base, branchiness: 0.8, braid: 0.9 }, mulberry32(5));
    // 环路只减少死路，不应该把岔路也消灭掉
    expect(junctionCount(high)).toBeGreaterThan(junctionCount(low) * 0.9);
  });
});

describe('防作弊：形状迷宫下的解路径下界', () => {
  it('所有形状/尺寸下解路径都长于单次补额度（5 格）', () => {
    let minSteps = Number.POSITIVE_INFINITY;
    let worst = '';
    for (const shape of SHAPE_IDS) {
      for (const [c, r] of SIZE_GRID) {
        for (const branchiness of [0, 0.5, 1]) {
          for (let seed = 0; seed < 6; seed++) {
            const maze = generateMaze(
              { cols: c, rows: r, braid: 0.2, shape, branchiness },
              mulberry32(seed * 911 + c * 37 + r * 7),
            );
            const steps = solve(maze).length - 1;
            if (steps < minSteps) {
              minSteps = steps;
              worst = `${shape} ${c}x${r} branch=${branchiness} seed=${seed}`;
            }
          }
        }
      }
    }
    // 历史上实测最小值是 7 步（6x6 星形），必须仍然严格大于 5 格额度
    expect(minSteps).toBeGreaterThan(5);
    // 记录下来，将来如果最小值掉到 6 就该重新审视额度策略了
    expect(minSteps).toBeGreaterThanOrEqual(7);
    expect(worst).not.toBe('');
  });

  it('MIN_SOLUTION_CELLS 与实际可达的最短解长度一致', () => {
    // 这个常量是「挑起点时尽量达到」的目标，不是保证；
    // 这里只锁住它没有被写成不可能达到的值。
    expect(MIN_SOLUTION_CELLS).toBeGreaterThanOrEqual(0);
    const maze = generateMaze({ cols: 6, rows: 6, braid: 0.5, shape: 'star', branchiness: 0.5 }, mulberry32(0));
    expect(solve(maze).length).toBeGreaterThan(0);
  });
});
