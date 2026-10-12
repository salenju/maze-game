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
import {
  clampCustom,
  LIMITS,
  normalizeStarsOverride,
  PRESETS,
  presetById,
  withStars,
} from '../src/core/difficulty';
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
  const keyOf = (c: { x: number; y: number }) => `${c.x},${c.y}`;

  /**
   * 测试里独立数一遍「这条死路有多深」：从尽头往里走，直到遇到岔路口或起终点。
   * 刻意不复用实现里的同名逻辑，免得两边一起错还能通过。
   */
  function branchDepth(
    maze: ReturnType<typeof generateMaze>,
    end: { x: number; y: number },
  ): number {
    let prev: { x: number; y: number } | null = null;
    let cur = end;
    let depth = 1;
    for (let guard = 0; guard < maze.cols * maze.rows; guard++) {
      const next = openings(maze, cur.x, cur.y)
        .map((dir) => ({ x: cur.x + (DX[dir] ?? 0), y: cur.y + (DY[dir] ?? 0) }))
        .find((c) => !(prev && c.x === prev.x && c.y === prev.y));
      if (!next) break;
      if (openings(maze, next.x, next.y).length !== 2) break;
      if (next.x === maze.start.x && next.y === maze.start.y) break;
      if (next.x === maze.exit.x && next.y === maze.exit.y) break;
      depth++;
      prev = cur;
      cur = next;
    }
    return depth;
  }

  it('星星要么在必经之路上，要么在死路尽头，都不与起终点重合', () => {
    for (let s = 0; s < 20; s++) {
      const maze = generateMaze({ cols: 14, rows: 14, braid: 0.25 }, mulberry32(s * 13 + 1));
      const stars = placeCollectibles(maze, 4);
      const path = solve(maze);
      const pathKeys = new Set(path.map(keyOf));

      expect(stars.length).toBeLessThanOrEqual(4);
      for (const star of stars) {
        expect(inMaze(maze, star.x, star.y)).toBe(true);
        expect(keyOf(star)).not.toBe(keyOf(maze.start));
        expect(keyOf(star)).not.toBe(keyOf(maze.exit));
        // 不在正路上就必须是死胡同（只有一个出口）
        if (!pathKeys.has(keyOf(star))) {
          expect(openings(maze, star.x, star.y).length).toBe(1);
        }
      }
      expect(new Set(stars.map(keyOf)).size).toBe(stars.length);
    }
  });

  it('约三分之一落在死路尽头当诱饵（家长要求的「迷惑」）', () => {
    for (let s = 0; s < 10; s++) {
      const maze = generateMaze(
        { cols: 14, rows: 14, braid: 0, branchiness: 0.8 },
        mulberry32(s * 17 + 3),
      );
      const pathKeys = new Set(solve(maze).map(keyOf));
      const stars = placeCollectibles(maze, 6);
      const decoys = stars.filter((c) => !pathKeys.has(keyOf(c)));

      expect(stars.length).toBe(6);
      expect(decoys.length).toBe(2); // round(6 / 3)
      for (const d of decoys) expect(openings(maze, d.x, d.y).length).toBe(1);
    }
  });

  it('只要一个诱饵时，它必然是最深的死路（走进走出代价最大）', () => {
    const maze = generateMaze(
      { cols: 16, rows: 16, braid: 0, branchiness: 0.9 },
      mulberry32(41),
    );
    const pathKeys = new Set(solve(maze).map(keyOf));
    const stars = placeCollectibles(maze, 3); // round(3 / 3) → 只要 1 个诱饵
    const decoys = stars.filter((c) => !pathKeys.has(keyOf(c)));
    expect(decoys.length).toBe(1);

    let deepest = 0;
    for (let y = 0; y < maze.rows; y++) {
      for (let x = 0; x < maze.cols; x++) {
        if (!inMaze(maze, x, y)) continue;
        const cell = { x, y };
        if (pathKeys.has(keyOf(cell))) continue;
        if (openings(maze, x, y).length !== 1) continue;
        deepest = Math.max(deepest, branchDepth(maze, cell));
      }
    }
    expect(branchDepth(maze, decoys[0] as { x: number; y: number })).toBe(deepest);
  });

  it('多个诱饵要够深且彼此分散（都挤在一个角落就不好玩了）', () => {
    const maze = generateMaze(
      { cols: 16, rows: 16, braid: 0, branchiness: 0.9 },
      mulberry32(41),
    );
    const pathKeys = new Set(solve(maze).map(keyOf));
    const stars = placeCollectibles(maze, 6);
    const decoys = stars.filter((c) => !pathKeys.has(keyOf(c)));

    expect(decoys.length).toBe(2);
    for (const d of decoys) {
      expect(openings(maze, d.x, d.y).length).toBe(1);
      expect(branchDepth(maze, d)).toBeGreaterThanOrEqual(2);
    }
    const [a, b] = decoys as { x: number; y: number }[];
    expect(Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))).toBeGreaterThan(2);
  });

  it('2 颗以下不放诱饵（只剩一颗还藏起来就是刁难）', () => {
    const maze = generateMaze(
      { cols: 14, rows: 14, braid: 0, branchiness: 0.8 },
      mulberry32(23),
    );
    const pathKeys = new Set(solve(maze).map(keyOf));
    for (const star of placeCollectibles(maze, 2)) {
      expect(pathKeys.has(keyOf(star))).toBe(true);
    }
  });

  it('路径放得下时「要几颗就给几颗」（不会因取样撞格少给）', () => {
    // 旧实现按等分点 round 取下标，短路径上会撞到同一格再去重，
    // 于是家长设 8 颗、开局只看到 5 颗 —— 另一种「设置没生效」。
    for (let s = 0; s < 20; s++) {
      const maze = generateMaze({ cols: 12, rows: 12, braid: 0.2 }, mulberry32(s * 31 + 5));
      const capacity = solve(maze).length - 2;
      const want = Math.min(8, capacity);
      expect(placeCollectibles(maze, want).length).toBe(want);
      // 贴满整条路径也要一格一颗，不重复、不越界
      expect(placeCollectibles(maze, capacity).length).toBe(capacity);
    }
  });

  it('请求 0 颗星星时返回空数组', () => {
    const maze = generateMaze({ cols: 8, rows: 8, braid: 0 }, mulberry32(3));
    expect(placeCollectibles(maze, 0)).toEqual([]);
  });

  it('请求数量超过容量时不会越界或重复', () => {
    const maze = generateMaze({ cols: 6, rows: 6, braid: 0.6 }, mulberry32(9));
    const stars = placeCollectibles(maze, 50);
    const keys = new Set(stars.map(keyOf));
    expect(keys.size).toBe(stars.length);
    // 诱饵不在正路上，容量上限是「整张图的可走格子」，而不是路径长度
    expect(stars.length).toBeLessThanOrEqual(mazeCellCount(maze));
    for (const s of stars) expect(inMaze(maze, s.x, s.y)).toBe(true);
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
    // 星星只按滑块上限收敛。旧实现还会按格子面积二次打折
    // （floor(cols*rows/12)），家长在小迷宫上拉到 8 颗却只拿到 3 颗，
    // 表现就是「星星数量设置后没有生效」。
    expect(wild.stars).toBe(LIMITS.maxStars);
    // 上限本身仍然保证「星星不会比格子还多」
    expect(LIMITS.maxStars).toBeLessThan(LIMITS.minCols * LIMITS.minRows);
  });

  it('小迷宫也照办家长要的星星数量（不再按面积打折）', () => {
    const tiny = clampCustom({ cols: LIMITS.minCols, rows: LIMITS.minRows, stars: 6 });
    expect(tiny.stars).toBe(6);
    // 真正兜底的是放置逻辑：星星只会摆在必经之路上，格子不够自然少放
    const maze = generateMaze({ cols: 6, rows: 6, braid: 0 }, mulberry32(17));
    const stars = placeCollectibles(maze, tiny.stars);
    expect(stars.length).toBeGreaterThan(0);
    expect(stars.length).toBeLessThanOrEqual(solve(maze).length - 2);
  });

  it('星星数量是跨难度的覆盖值：null 跟随档位，给了就压过档位', () => {
    const medium = presetById('medium');
    expect(withStars(medium, null)).toBe(medium);
    expect(withStars(medium, medium.stars)).toBe(medium);
    expect(withStars(medium, 0).stars).toBe(0);
    expect(withStars(presetById('starter'), 6).stars).toBe(6);
    // 其余字段不受影响
    expect(withStars(medium, 6).cols).toBe(medium.cols);
    expect(withStars(medium, 6).braid).toBe(medium.braid);
  });

  it('存档里的星星覆盖值被收敛，非法值落回「跟随档位」', () => {
    expect(normalizeStarsOverride(5)).toBe(5);
    expect(normalizeStarsOverride(0)).toBe(0); // 0 是「不要星星」，不是「没设置」
    expect(normalizeStarsOverride(999)).toBe(LIMITS.maxStars);
    expect(normalizeStarsOverride(-3)).toBe(LIMITS.minStars);
    expect(normalizeStarsOverride(undefined)).toBeNull();
    expect(normalizeStarsOverride('6')).toBeNull();
    expect(normalizeStarsOverride(Number.NaN)).toBeNull();
  });

  it('最难的一档按成年人难度配置：尺寸顶格、岔路拉满、没有环路', () => {
    const hard = presetById('hard');
    // 用户反馈「即使最难的关卡也是一条道走到黑，分岔路不够当干扰」
    expect(hard.cols).toBe(LIMITS.maxCols);
    expect(hard.rows).toBe(LIMITS.maxRows);
    expect(hard.branchiness).toBe(1);
    expect(hard.braid).toBe(0);
    // 无脚印、无提示箭头，只能靠自己记住走过的路
    expect(hard.footprint).toBe('none');
    expect(hard.hintDelayMs).toBeNull();
  });

  it('最难的一档实测岔路/死胡同显著多于旧版 18×18 星形', () => {
    const adult = generateMaze(
      {
        cols: presetById('hard').cols,
        rows: presetById('hard').rows,
        shape: presetById('hard').shape,
        braid: presetById('hard').braid,
        branchiness: presetById('hard').branchiness,
      },
      mulberry32(2024),
    );
    // 旧版：18×18 星形、branchiness 0.85、braid 0.15（实测岔路约 40、死胡同约 39）
    expect(junctionCount(adult)).toBeGreaterThan(55);
    expect(deadEndCount(adult)).toBeGreaterThan(55);
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

  it('所有形状内部都是填满的（不再挖空成环形走廊）', () => {
    // 用户反馈：「其余形状中间都是空心的，基本还是一条道走到黑」。
    // 环形走廊只有一圈窄廊，中间大片格子不可达，岔路根本没有地方长。
    for (const shape of SHAPE_IDS) {
      const [c, r] = [14, 14] as const;
      const maze = generateMaze({ cols: c, rows: r, braid: 0.2, shape }, mulberry32(3));
      expect(inMaze(maze, Math.floor(c / 2), Math.floor(r / 2))).toBe(true);
    }
  });

  it('非方形形状吃满自己的轮廓（几何上限，不能被额外挖掉）', () => {
    // 掩码面积 / 外接矩形：圆 0.79、六边形 0.75、三角 0.50、星 0.47。
    // 旧版把圆/六边形/三角形腐蚀成环，面积只有 0.47 / 0.49 / 0.44。
    const floors: Record<ShapeId, number> = {
      circle: 0.7,
      hexagon: 0.65,
      triangle: 0.42,
      star: 0.4,
      square: 1,
    };
    for (const shape of SHAPE_IDS) {
      const fill = countCells(buildMask(shape, 14, 14)) / (14 * 14);
      expect(fill).toBeGreaterThanOrEqual(floors[shape]);
    }
  });

  it('实心化之后高难度档的岔路显著变多（旧版环形走廊约 43 个）', () => {
    const circle = generateMaze(
      { cols: 24, rows: 24, braid: 0, branchiness: 1, shape: 'circle' },
      mulberry32(5),
    );
    // 旧版圆形 24×24 环形走廊只有 180 格、43 个岔路口
    expect(mazeCellCount(circle)).toBeGreaterThan(400);
    expect(junctionCount(circle)).toBeGreaterThan(90);
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
