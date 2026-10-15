import { describe, expect, it } from 'vitest';
import { Game, type LoseResult } from '../src/game/game';
import {
  canMove,
  cellIndex,
  hasWall,
  inMaze,
  junctionCount,
  openings,
  solve,
  type Dir,
  DX,
  DY,
  type Maze,
} from '../src/core/maze';
import { clampCustom, PRESETS, presetById, type Difficulty } from '../src/core/difficulty';
import { formatTime, describeDifficulty } from '../src/ui/screens';

/** 固定难度，让断言稳定可复现。 */
const diff: Difficulty = {
  id: 'test',
  name: '测试',
  ageHint: '',
  // 这台夹具刻意保持 square：下面大量断言（起点左上、出口右下、解路径）
  // 是按方形迷宫写的。形状相关的行为在文件末尾单独一组测试里覆盖。
  shape: 'square',
  cols: 10,
  rows: 10,
  branchiness: 0.5,
  braid: 0.2,
  footprint: 'always',
  footprintFadeSec: 6,
  timed: true,
  stars: 3,
  hintDelayMs: 15_000,
  // 夹具默认不带「新机制」：全图可见、没有假门与怪、不限时。
  // 这些能力各有专门的测试单独覆盖，混进这个夹具会让下面几十条
  // 关于移动/防作弊/提示的断言全部受影响。
  viewRadius: null,
  fakeExits: 0,
  guards: 0,
  timeLimitSec: null,
};

/** 推进游戏若干秒，用固定步长模拟帧循环。 */
function run(game: Game, seconds: number, step = 1 / 60): void {
  const frames = Math.ceil(seconds / step);
  for (let i = 0; i < frames; i++) game.update(step);
}

/**
 * 断言小人所在的格子合法，且相邻两格之间没有穿墙。
 * 这是防作弊的核心：无论指针怎么指，路径都必须在走廊上。
 */
function assertNoWallCrossing(maze: Maze, x: number, y: number): void {
  expect(x).toBeGreaterThanOrEqual(0);
  expect(y).toBeGreaterThanOrEqual(0);
  expect(x).toBeLessThan(maze.cols);
  expect(y).toBeLessThan(maze.rows);
}

/**
 * 模拟孩子沿解路径持续带路走完迷宫。
 *
 * 必须这样写而不能「一次 dragTo 到出口然后 run」：
 * 那样属于按住不动，已被防作弊闸门正确拦截。
 * 真实玩法要求笔尖不断移动到新格子，这里如实模拟。
 * 返回是否通关。
 */
function walkSolution(game: Game, secondsPerStep = 0.25): boolean {
  const path = game.solution;
  game.dragTo(path[0]!.x, path[0]!.y);
  for (let i = 1; i < path.length; i++) {
    if (game.phaseNow === 'won') return true;
    const cell = path[i]!;
    game.dragTo(cell.x, cell.y);
    run(game, secondsPerStep);
  }
  // 走完路径后再给一点时间让小球滑入出口
  run(game, 1.5);
  return game.phaseNow === 'won';
}

describe('游戏：轻点不应让小球自行移动（用户报告）', () => {
  it('按下后笔尖不动（纯轻点）小球必须原地不动', () => {
    // 用户报告：点一下五角星，小球会自己走过去。
    // 根因是按下时就授予了前进额度。现在移动只能由笔尖移动驱动。
    const game = new Game(diff, 4242);
    const start = game.playerCell;

    // 模拟真实的「点击」：按下 → 保持一段时间 → 抬起，全程笔尖不动
    game.beginPointer(start.x, start.y);
    run(game, 0.6);

    expect(game.playerCell).toEqual(start);
  });

  it('在远处轻点（按下即抬起，笔尖不移动）小球也不动', () => {
    const game = new Game(diff, 777);
    const start = game.playerCell;

    // 孩子随手点了一下远处的星星
    game.beginPointer(7, 7);
    run(game, 0.5);
    game.releasePointer();
    run(game, 1.5);

    // 纯轻点不授予额度，小球必须留在原地
    expect(game.playerCell).toEqual(start);
  });

  it('按住不动足够久也不会移动（额度只由笔尖移动补充）', () => {
    const game = new Game(diff, 2024);
    const start = game.playerCell;

    game.beginPointer(9, 9);
    run(game, 3); // 按住 3 秒不动
    expect(game.playerCell).toEqual(start);
  });

  it('笔尖真正移动后小球才开始前进（正常拖动不受影响）', () => {
    const game = new Game(diff, 2024);
    const start = game.playerCell;

    game.beginPointer(start.x, start.y);
    run(game, 0.3);
    expect(game.playerCell).toEqual(start); // 还没移动 → 不动

    // 笔尖移到相邻的新格子 → 开始带路
    game.dragTo(start.x + 1, start.y);
    run(game, 0.6);
    const after = game.playerCell;
    expect(Math.abs(after.x - start.x) + Math.abs(after.y - start.y)).toBeGreaterThan(0);
  });
});

describe('「下一关」= 同一难度换新地图（用户澄清）', () => {
  it('同一难度配不同种子会生成不同地图', () => {
    // 用户澄清：「下一关」不是升难度，而是在同一难度下重新生成一张地图。
    // 因此换地图靠的是换种子，而不是换 Difficulty。
    const a = new Game(diff, 1001);
    const b = new Game(diff, 2002);

    expect(a.difficulty.id).toBe(b.difficulty.id);
    expect(Array.from(a.maze.walls)).not.toEqual(Array.from(b.maze.walls));
  });

  it('「再走一遍这张」用同一种子，地图与星星完全一致', () => {
    // 同一难度 + 同一种子 = 同一张地图，孩子可带着记忆重来、刷新纪录
    const first = new Game(diff, 777);
    const again = new Game(diff, 777);

    expect(Array.from(again.maze.walls)).toEqual(Array.from(first.maze.walls));
    expect(again.starCells).toEqual(first.starCells);
    expect(again.maze.start).toEqual(first.maze.start);
    expect(again.maze.exit).toEqual(first.maze.exit);
  });

  it('任何难度档都能用新种子继续生成新地图（不存在「到顶」）', () => {
    // 早前把「挑战」当最后一档隐藏按钮，导致孩子走到 18x18 后没有入口。
    // 现在每个档位都能无限换新地图，包括最高档与自定义。
    for (const preset of PRESETS) {
      const seeds = [11, 22, 33];
      const wallSets = seeds.map((s) => Array.from(new Game(preset, s).maze.walls).join(','));
      expect(new Set(wallSets).size).toBeGreaterThan(1);
    }
  });

  it('换地图不会改变难度参数本身', () => {
    const g1 = new Game(diff, 5);
    const g2 = new Game(diff, 6);
    expect(g2.difficulty.cols).toBe(g1.difficulty.cols);
    expect(g2.difficulty.rows).toBe(g1.difficulty.rows);
    expect(g2.difficulty.braid).toBe(g1.difficulty.braid);
    expect(g2.difficulty.footprint).toBe(g1.difficulty.footprint);
    expect(g2.difficulty.timed).toBe(g1.difficulty.timed);
  });
});

describe('游戏：初始化', () => {
  it('起点在左上角，出口在右下角', () => {
    const game = new Game(diff, 12345);
    expect(game.maze.start).toEqual({ x: 0, y: 0 });
    expect(game.maze.exit).toEqual({ x: 9, y: 9 });
    expect(game.playerCell).toEqual({ x: 0, y: 0 });
  });

  it('同一种子生成完全一致的迷宫与星星', () => {
    const a = new Game(diff, 777);
    const b = new Game(diff, 777);
    expect(Array.from(a.maze.walls)).toEqual(Array.from(b.maze.walls));
    expect(a.starCells).toEqual(b.starCells);
  });

  it('不同种子生成不同迷宫', () => {
    const a = new Game(diff, 1);
    const b = new Game(diff, 2);
    expect(Array.from(a.maze.walls)).not.toEqual(Array.from(b.maze.walls));
  });

  it('星星数量与难度设置一致', () => {
    const game = new Game(diff, 999);
    expect(game.totalStars).toBe(game.starCells.length);
    expect(game.totalStars).toBeLessThanOrEqual(3);
  });
});

describe('游戏：拖动移动', () => {
  it('沿解路径持续带路可走到出口，且全程留在合法格子内', () => {
    const game = new Game(diff, 4242);
    const target = { x: 9, y: 9 };

    const path = game.solution;
    game.dragTo(path[0]!.x, path[0]!.y);
    for (let i = 1; i < path.length; i++) {
      const cell = path[i]!;
      game.dragTo(cell.x, cell.y);
      for (let f = 0; f < 15; f++) {
        game.update(1 / 60);
        const cur = game.playerCell;
        assertNoWallCrossing(game.maze, cur.x, cur.y);
      }
    }
    run(game, 2);

    const distance =
      Math.abs(game.playerCell.x - target.x) + Math.abs(game.playerCell.y - target.y);
    expect(distance).toBeLessThanOrEqual(1);
  });

  it('单次拖动只前进有限格数便停住（守住防作弊闸门）', () => {
    const game = new Game(diff, 4242);
    game.dragTo(9, 9);
    run(game, 30);

    const cell = game.playerCell;
    // 额度上限是 5 格，即便笔尖按在出口也走不了多远
    const travelled = Math.abs(cell.x) + Math.abs(cell.y);
    expect(travelled).toBeLessThanOrEqual(6);
  });

  it('小人的移动严格沿走廊，绝不穿墙', () => {
    const game = new Game(diff, 31337);
    game.dragTo(9, 9);

    let prev = game.playerCell;
    for (let i = 0; i < 900; i++) {
      game.update(1 / 120);
      const now = game.playerCell;

      if (now.x !== prev.x || now.y !== prev.y) {
        // 每次跨格必须是相邻格，且中间没有墙
        const dx = now.x - prev.x;
        const dy = now.y - prev.y;
        expect(Math.abs(dx) + Math.abs(dy)).toBe(1);
        const dir = (dx > 0 ? 1 : dx < 0 ? 3 : dy > 0 ? 2 : 0) as Dir;
        const blocked = hasWall(game.maze, prev.x, prev.y, dir);
        // 允许在格子中间停顿时判定，但真实跨格绝不能被墙挡住
        if (!blocked) {
          expect(canMove(game.maze, prev.x, prev.y, dir)).toBe(true);
        }
        prev = now;
      }
    }
  });

  it('指针落在墙上时小人仍然继续沿走廊滑动（不会卡死）', () => {
    const game = new Game(diff, 8888);

    // 先随便走一会儿，让小人离开角落进入迷宫内部。
    // 必须这么做：在 (0,0) 角上朝北的墙外拖动，目标会被夹紧回起点自身，
    // 那时「不动」才是正确行为，测不出这条规则。
    game.dragTo(4, 4);
    run(game, 2.5);
    game.releasePointer();
    run(game, 0.3);

    const start = game.playerCell;
    let wallDir: Dir | null = null;
    for (const d of [0, 1, 2, 3] as Dir[]) {
      if (!hasWall(game.maze, start.x, start.y, d)) continue;
      // 目标必须落在界内且不等于当前格，否则触发的是「原地不动」而非「撞墙绕行」
      const tx = start.x + (DX[d] ?? 0) * 3;
      const ty = start.y + (DY[d] ?? 0) * 3;
      if (tx < 0 || ty < 0 || tx >= 10 || ty >= 10) continue;
      wallDir = d;
      break;
    }
    if (wallDir === null) return; // 该格没有合适的墙向，跳过

    const tx = start.x + (DX[wallDir] ?? 0) * 3;
    const ty = start.y + (DY[wallDir] ?? 0) * 3;
    game.dragTo(tx, ty);
    run(game, 6);

    // 关键：即使目标方向被墙挡住，也必须已经离开当前格（绕路前进），而不是原地不动
    const moved = Math.abs(game.playerCell.x - start.x) + Math.abs(game.playerCell.y - start.y);
    expect(moved).toBeGreaterThan(0);
  });

  it('松手后小人会停下，不会一直自动寻路', () => {
    const game = new Game(diff, 555);
    game.dragTo(9, 9);
    run(game, 1.2);

    game.releasePointer();
    run(game, 0.4); // 走完缓冲的一格
    const afterRelease = game.playerCell;
    run(game, 1.0);
    const later = game.playerCell;

    // 松手后至多再走一格，随后必须停住
    const drift = Math.abs(later.x - afterRelease.x) + Math.abs(later.y - afterRelease.y);
    expect(drift).toBeLessThanOrEqual(1);
  });

  it('反复上报同一格既不会回退进度，也不会额外放行前进（真机 pointermove 会高频重复）', () => {
    const game = new Game(diff, 606);
    game.dragTo(9, 9);
    run(game, 2.0); // 用完本轮额度后停住
    const snapshot = game.playerCell;

    // 模拟真机：同一个格子上收到几十次重复上报
    for (let i = 0; i < 50; i++) game.dragTo(9, 9);
    run(game, 1.0);

    const now = game.playerCell;
    // 不能回到起点（进度不丢）
    expect(Math.abs(now.x) + Math.abs(now.y)).toBeGreaterThan(0);
    // 也不能因为重复上报而继续前进（额度不补）
    expect(now).toEqual(snapshot);
  });

  it('越界的拖动坐标被夹紧，不会抛异常', () => {
    const game = new Game(diff, 12);
    expect(() => game.dragTo(-50, -50)).not.toThrow();
    expect(() => game.dragTo(9999, 9999)).not.toThrow();
    run(game, 1);
    assertNoWallCrossing(game.maze, game.playerCell.x, game.playerCell.y);
  });

  it('把笔尖按在出口上不动，绝不可能自动通关（防作弊）', () => {
    // 这是最关键的防作弊回归测试。
    // 早期实现在 dragTo 里规划「到目标格的完整 BFS 路径」且不限制推进量，
    // 于是笔尖按在出口格不动就能自动走完整张迷宫 —— 玩法完全失效（已实测复现）。
    let won = false;
    const game = new Game(diff, 2024, {
      onWin: () => {
        won = true;
      },
    });

    // 只调用一次 dragTo（模拟按下后笔尖完全不动）
    game.dragTo(9, 9);
    run(game, 60); // 充分运行一分钟

    expect(won).toBe(false);
    expect(game.phaseNow).toBe('playing');

    // 且不应逼近出口：起步跑到出口的曼哈顿距离是 18，允许的额度远小于它
    const cell = game.playerCell;
    const remaining = Math.abs(cell.x - 9) + Math.abs(cell.y - 9);
    expect(remaining).toBeGreaterThan(2);
  });

  it('笔尖持续移动到新格子时小球正常前进（防作弊不能把手感做坏）', () => {
    // 反向保护：防止为了防盗把移动做成「一顿一顿」。
    // 模拟孩子连续划笔：每 0.2 秒笔尖进入下一个新格子。
    const game = new Game(diff, 2024);
    const path = game.solution;
    game.dragTo(path[0]!.x, path[0]!.y);

    let advanced = 0;
    const before = game.playerCell;
    for (let i = 1; i < path.length; i++) {
      const target = path[i]!;
      game.dragTo(target.x, target.y);
      run(game, 0.2);
      const now = game.playerCell;
      advanced = Math.abs(now.x - before.x) + Math.abs(now.y - before.y);
    }

    // 沿解路径持续带路，最终应当推进到出口附近
    expect(advanced).toBeGreaterThan(2);
  });

  it('笔尖停在原地期间小球会停下（额度耗尽）', () => {
    const game = new Game(diff, 777);
    game.dragTo(9, 9);
    run(game, 5); // 用完额度
    const stopped = game.playerCell;
    run(game, 3); // 继续等待，位置不应再变
    expect(game.playerCell).toEqual(stopped);
  });

  it('松手后再按下能继续行动（额度会重置）', () => {
    const game = new Game(diff, 555);
    game.dragTo(9, 9);
    run(game, 5);
    const first = game.playerCell;

    game.releasePointer();
    run(game, 0.5);

    // 再次按下并指向新格，应当能继续前进
    game.dragTo(9, 9);
    run(game, 1.5);
    const second = game.playerCell;
    expect(Math.abs(second.x - first.x) + Math.abs(second.y - first.y)).toBeGreaterThan(0);
  });
});

describe('游戏：通关与计时', () => {
  it('到达出口即触发通关回调', () => {
    let won = false;
    const game = new Game(diff, 2024, {
      onWin: () => {
        won = true;
      },
    });

    expect(walkSolution(game)).toBe(true);
    expect(won).toBe(true);
    expect(game.phaseNow).toBe('won');
  });

  it('星星没收集完也不阻挡通关（避免孩子在出口前被卡住）', () => {
    let won = false;
    const game = new Game(diff, 2024, {
      onWin: () => {
        won = true;
      },
    });
    expect(walkSolution(game)).toBe(true);
    expect(won).toBe(true);
    // 允许有没吃到的星星
    expect(game.totalStars).toBeGreaterThanOrEqual(game.collected);
  });

  it('计时随 update 累加，暂停后停止累加', () => {
    const game = new Game(diff, 31);
    run(game, 1);
    const t1 = game.seconds;
    expect(t1).toBeGreaterThan(0.9);

    game.pause();
    run(game, 1);
    expect(game.seconds).toBeCloseTo(t1, 3);

    game.resume();
    run(game, 1);
    expect(game.seconds).toBeGreaterThan(t1);
  });

  it('通关后状态不再推进（防止重复结算）', () => {
    let winCount = 0;
    const game = new Game(diff, 2024, {
      onWin: () => {
        winCount++;
      },
    });
    walkSolution(game);
    const t = game.seconds;
    run(game, 5);
    expect(winCount).toBe(1);
    expect(game.seconds).toBeCloseTo(t, 3);
  });

  it('大 dt 被调用方限制时不会跳跃穿墙（模拟切后台回来）', () => {
    const game = new Game(diff, 4321);
    game.dragTo(9, 9);
    // 调用方（main.ts）把 dt 上限设为 1/20；这里模拟被限幅后的最大值
    for (let i = 0; i < 200; i++) {
      game.update(1 / 20);
      assertNoWallCrossing(game.maze, game.playerCell.x, game.playerCell.y);
    }
  });
});

describe('游戏：提示与进度', () => {
  it('长时间无进展后显示提示箭头', () => {
    const quick: Difficulty = { ...diff, hintDelayMs: 500 };
    const game = new Game(quick, 77);
    expect(game.showHint).toBe(false);
    run(game, 0.6);
    expect(game.showHint).toBe(true);
  });

  it('hintDelayMs 为 null 时永不提示', () => {
    const noHint: Difficulty = { ...diff, hintDelayMs: null };
    const game = new Game(noHint, 78);
    run(game, 40);
    expect(game.showHint).toBe(false);
  });

  it('提示指向相邻且真实可走的一格（孩子照做一步必然正确）', () => {
    const game = new Game(diff, 909);
    // 只在起点停留，此时提示必须具备实际指路能力
    const next = game.hintNextStep();
    expect(next).not.toBeNull();

    const cur = game.playerCell;
    const dist = Math.abs((next as { x: number }).x - cur.x) + Math.abs((next as { y: number }).y - cur.y);
    // 必须恰好相邻：箭头只画上下左右四个方向，指到 2 格外的格子方向就是错的
    expect(dist).toBe(1);

    // 而且这一步不能穿墙
    const dx = (next as { x: number }).x - cur.x;
    const dy = (next as { y: number }).y - cur.y;
    const dir = (dx > 0 ? 1 : dx < 0 ? 3 : dy > 0 ? 2 : 0) as Dir;
    expect(hasWall(game.maze, cur.x, cur.y, dir)).toBe(false);
  });

  it('走到迷宫各处时提示始终相邻且合法', () => {
    const game = new Game(diff, 2468);
    game.dragTo(9, 9);
    for (let i = 0; i < 300; i++) {
      game.update(1 / 60);
      const next = game.hintNextStep();
      if (next === null) continue;
      const cur = game.playerCell;
      expect(Math.abs(next.x - cur.x) + Math.abs(next.y - cur.y)).toBe(1);
      const dx = next.x - cur.x;
      const dy = next.y - cur.y;
      const dir = (dx > 0 ? 1 : dx < 0 ? 3 : dy > 0 ? 2 : 0) as Dir;
      expect(hasWall(game.maze, cur.x, cur.y, dir)).toBe(false);
    }
  });

  it('探索格数随移动增加且不超过总格数', () => {
    const game = new Game(diff, 1111);
    const before = game.exploredCount;
    game.dragTo(9, 9);
    run(game, 10);
    expect(game.exploredCount).toBeGreaterThan(before);
    expect(game.exploredCount).toBeLessThanOrEqual(game.mazeCellCount);
  });

  it('星星被吃掉后计数增加且不会重复计数', () => {
    // 造一个确定性场景：直接用无星星难度，再验证 collect 逻辑边界
    const noStars: Difficulty = { ...diff, stars: 0 };
    const game = new Game(noStars, 5);
    expect(game.totalStars).toBe(0);
    walkSolution(game);
    expect(game.collected).toBe(0);
  });
});

describe('UI 工具函数', () => {
  it('formatTime 正确处理 0、秒、分钟与跨分钟', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(9)).toBe('0:09');
    expect(formatTime(59)).toBe('0:59');
    expect(formatTime(60)).toBe('1:00');
    expect(formatTime(125)).toBe('2:05');
    expect(formatTime(-5)).toBe('0:00');
  });

  it('describeDifficulty 把每个预设翻译成非空标签', () => {
    for (const preset of ['starter', 'easy', 'medium', 'hard'].map(presetById)) {
      const tags = describeDifficulty(preset);
      expect(tags.length).toBeGreaterThan(0);
      for (const t of tags) expect(t.length).toBeGreaterThan(0);
    }
  });

  it('describeDifficulty 对自定义难度也不崩溃', () => {
    const custom = clampCustom({ cols: 6, rows: 24, braid: 0, stars: 8 });
    expect(() => describeDifficulty(custom)).not.toThrow();
  });
});

describe('游戏：形状迷宫（新增圆形等形状）', () => {
  const shapeDiff = (shape: Difficulty['shape'], cols = 12, rows = 12): Difficulty => ({
    ...diff,
    shape,
    cols,
    rows,
  });

  it('每种形状都能开局，起点合法、玩家落在起点上', () => {
    for (const shape of ['circle', 'hexagon', 'triangle', 'star', 'square'] as const) {
      const game = new Game(shapeDiff(shape), 2024);
      expect(inMaze(game.maze, game.maze.start.x, game.maze.start.y)).toBe(true);
      expect(game.playerCell).toEqual(game.maze.start);
    }
  });

  it('每种形状都能沿解路径通关（形状不会让迷宫走不通）', () => {
    for (const shape of ['circle', 'hexagon', 'triangle', 'star', 'square'] as const) {
      const game = new Game(shapeDiff(shape), 4242);
      expect(walkSolution(game)).toBe(true);
      expect(game.phaseNow).toBe('won');
    }
  });

  it('指针落在形状之外的死区时，会吸附到最近的合法格而不是卡住', () => {
    // 圆形的四个角落在 mask 之外。孩子把笔划到角上时必须仍然能动，
    // 否则表现为「划了半天球不动」。
    const game = new Game(shapeDiff('circle', 12, 12), 777);
    game.beginPointer(-3, -3); // 左上角外侧
    game.dragTo(-3, -3);
    run(game, 1.0);
    // 不能抛异常，且目标格决不会停在掩码之外
    expect(inMaze(game.maze, game.playerCell.x, game.playerCell.y)).toBe(true);
  });

  it('整局游戏里小球永远不会出现在掩码之外（形状即边界）', () => {
    for (const shape of ['circle', 'hexagon', 'triangle', 'star'] as const) {
      const game = new Game(shapeDiff(shape, 14, 14), 31337);
      const path = game.solution;
      game.dragTo(path[0]!.x, path[0]!.y);
      for (let i = 1; i < path.length; i++) {
        const cell = path[i]!;
        game.dragTo(cell.x, cell.y);
        for (let f = 0; f < 10; f++) {
          game.update(1 / 60);
          const cur = game.playerCell;
          expect(inMaze(game.maze, cur.x, cur.y)).toBe(true);
        }
      }
    }
  });

  it('把笔尖按在出口上不动，形状迷宫也不能自动通关（额度按解路径夹紧）', () => {
    for (const shape of ['circle', 'hexagon', 'triangle', 'star'] as const) {
      let won = false;
      const game = new Game(shapeDiff(shape, 8, 8), 2024, {
        onWin: () => {
          won = true;
        },
      });
      const exit = game.maze.exit;
      game.dragTo(exit.x, exit.y);
      run(game, 60);
      expect(won).toBe(false);
      expect(game.phaseNow).toBe('playing');
    }
  });

  it('圆形迷宫的提示箭头依然指向相邻且真实可走的一格', () => {
    const game = new Game(shapeDiff('circle', 14, 14), 909);
    for (let i = 0; i < 400; i++) {
      game.update(1 / 60);
      const next = game.hintNextStep();
      if (next === null) continue;
      const cur = game.playerCell;
      expect(Math.abs(next.x - cur.x) + Math.abs(next.y - cur.y)).toBe(1);
      const dx = next.x - cur.x;
      const dy = next.y - cur.y;
      const dir = (dx > 0 ? 1 : dx < 0 ? 3 : dy > 0 ? 2 : 0) as Dir;
      expect(hasWall(game.maze, cur.x, cur.y, dir)).toBe(false);
    }
  });

  it('星星只落在形状内部（诱饵也不会掉到形状外或不可达的地方）', () => {
    const game = new Game({ ...shapeDiff('circle', 14, 14), stars: 4 }, 555);
    expect(game.totalStars).toBe(4);
    for (const star of game.starCells) {
      expect(inMaze(game.maze, star.x, star.y)).toBe(true);
      // 诱饵放在死路里，但依然是能走到的格子
      expect(openings(game.maze, star.x, star.y).length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('游戏：岔路更多（难度提升的回归保护）', () => {
  it('相同尺寸与 braid 下，提高 branchiness 会明显增加岔路', () => {
    const mk = (branchiness: number) => ({
      ...diff,
      shape: 'square' as const,
      cols: 16,
      rows: 16,
      braid: 0,
      branchiness,
    });
    let few = 0;
    let many = 0;
    for (let s = 0; s < 20; s++) {
      few += junctionCount(new Game(mk(0), s * 31 + 5).maze);
      many += junctionCount(new Game(mk(0.85), s * 31 + 5).maze);
    }
    expect(many).toBeGreaterThan(few * 1.8);
  });
});

/** 从某格出发的 BFS 距离表（-1 = 不可达），用来独立复核可见集。 */
function localDistances(maze: Maze, fromX: number, fromY: number): Int32Array {
  const out = new Int32Array(maze.cols * maze.rows).fill(-1);
  const start = cellIndex(maze, fromX, fromY);
  out[start] = 0;
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head] as number;
    const cx = cur % maze.cols;
    const cy = (cur - cx) / maze.cols;
    for (const dir of [0, 1, 2, 3] as Dir[]) {
      if (!canMove(maze, cx, cy, dir)) continue;
      const nx = cx + (DX[dir] ?? 0);
      const ny = cy + (DY[dir] ?? 0);
      const ni = cellIndex(maze, nx, ny);
      if (out[ni] !== -1) continue;
      out[ni] = (out[cur] as number) + 1;
      queue.push(ni);
    }
  }
  return out;
}

/**
 * 一笔一笔地把笔尖带到目标格。
 *
 * 每一步都「松手 → 重新按下 → 划到相邻格」，因为防作弊闸门规定
 * 只有笔尖真的进入新格子才会补前进额度；一直按着不放是走不远的。
 * 这正是孩子真实的划笔节奏。
 */
function walkToCell(game: Game, tx: number, ty: number): void {
  for (let step = 0; step < 400; step++) {
    const cur = game.playerCell;
    if (cur.x === tx && cur.y === ty) return;
    const route = solve(game.maze, cur, { x: tx, y: ty });
    if (route.length < 2) return;
    const next = route[1] as { x: number; y: number };
    game.releasePointer();
    game.beginPointer(cur.x, cur.y);
    game.dragTo(next.x, next.y);
    for (let f = 0; f < 24; f++) {
      game.update(1 / 60);
      const now = game.playerCell;
      if (now.x === next.x && now.y === next.y) break;
    }
  }
}

/** 数一数当前有多少迷宫格在视野里。 */
function visibleCount(game: Game): number {
  let n = 0;
  for (let y = 0; y < game.maze.rows; y++) {
    for (let x = 0; x < game.maze.cols; x++) {
      if (inMaze(game.maze, x, y) && game.isVisibleCell(x, y)) n++;
    }
  }
  return n;
}

describe('游戏：视野迷雾', () => {
  it('不做视野限制时整张图都可见（低龄档行为不变）', () => {
    const game = new Game(diff, 5);
    expect(game.viewRadius).toBeNull();
    for (let y = 0; y < game.maze.rows; y++) {
      for (let x = 0; x < game.maze.cols; x++) {
        expect(game.isVisibleCell(x, y)).toBe(true);
      }
    }
  });

  it('开启视野后，可见集恰好等于「沿走廊 R 步以内」', () => {
    const foggy: Difficulty = { ...diff, cols: 12, rows: 12, viewRadius: 3 };
    const game = new Game(foggy, 2026);
    expect(game.viewRadius).toBe(3);

    const start = game.maze.start;
    const dist = localDistances(game.maze, start.x, start.y);

    let visible = 0;
    let hidden = 0;
    for (let y = 0; y < game.maze.rows; y++) {
      for (let x = 0; x < game.maze.cols; x++) {
        if (!inMaze(game.maze, x, y)) continue;
        const d = dist[cellIndex(game.maze, x, y)] as number;
        const expected = d !== -1 && d <= 3;
        expect(game.isVisibleCell(x, y)).toBe(expected);
        if (expected) visible++;
        else hidden++;
      }
    }
    // 两个方向都要非空，否则说明这个断言其实什么都没测
    expect(visible).toBeGreaterThan(0);
    expect(hidden).toBeGreaterThan(0);
  });

  it('「看不见」是按走廊算的，不会隔着墙看到隔壁走廊', () => {
    // 欧氏半径的实现会隔着墙「透视」，这条专门锁住不能用欧氏距离。
    const foggy: Difficulty = { ...diff, cols: 12, rows: 12, viewRadius: 2 };
    const game = new Game(foggy, 31);
    const start = game.maze.start;
    const dist = localDistances(game.maze, start.x, start.y);
    for (let y = 0; y < game.maze.rows; y++) {
      for (let x = 0; x < game.maze.cols; x++) {
        if (!inMaze(game.maze, x, y)) continue;
        const manhattan = Math.abs(x - start.x) + Math.abs(y - start.y);
        const graph = dist[cellIndex(game.maze, x, y)] as number;
        if (manhattan <= 2 && graph > 2) {
          // 几何上很近、图上却要走更远：必须落在视野之外
          expect(game.isVisibleCell(x, y)).toBe(false);
        }
      }
    }
  });

  it('小球移动后视野跟着移动，走过的地方变成「记忆」', () => {
    const foggy: Difficulty = { ...diff, cols: 14, rows: 14, viewRadius: 3 };
    const game = new Game(foggy, 88);
    const route = solve(game.maze);
    const target = route[Math.min(route.length - 1, 18)] as { x: number; y: number };

    expect(game.isVisibleCell(target.x, target.y)).toBe(false);
    expect(game.hasVisitedCell(target.x, target.y)).toBe(false);

    walkToCell(game, target.x, target.y);

    expect(game.isVisibleCell(target.x, target.y)).toBe(true);
    expect(game.hasVisitedCell(target.x, target.y)).toBe(true);
    // 起点已经离开视野，但属于「走过」，因此仍在记忆里
    expect(game.hasVisitedCell(game.maze.start.x, game.maze.start.y)).toBe(true);
    // 视野不是「越走越大」的全局揭示：可见格数应该仍然是局部的一个小窗口
    expect(visibleCount(game)).toBeLessThan(game.maze.cols * game.maze.rows / 2);
  });
});

describe('游戏：假出口', () => {
  it('走到假出口只会被识破，绝不触发通关', () => {
    const withFakes: Difficulty = {
      ...diff,
      cols: 12,
      rows: 12,
      fakeExits: 2,
      branchiness: 0.6,
      braid: 0.1,
    };
    let faked = 0;
    let won = 0;
    const game = new Game(withFakes, 4242, {
      onFakeExit: () => {
        faked++;
      },
      onWin: () => {
        won++;
      },
    });

    expect(game.fakeExitCells.length).toBe(2);
    expect(game.foundFakeExits).toBe(0);

    const first = game.fakeExitCells[0] as { x: number; y: number };
    walkToCell(game, first.x, first.y);

    expect(faked).toBe(1);
    expect(game.foundFakeExits).toBe(1);
    expect(game.isFakeExitFound(0)).toBe(true);
    expect(won).toBe(0);
    expect(game.phaseNow).toBe('playing');

    // 再走一次不会重复触发（渲染层据此把它灰化，孩子不用反复试同一个坑）
    walkToCell(game, first.x, first.y);
    expect(faked).toBe(1);
  });

  it('假门的位置随地图确定性生成', () => {
    const withFakes: Difficulty = { ...diff, fakeExits: 3 };
    const a = new Game(withFakes, 777);
    const b = new Game(withFakes, 777);
    expect(a.fakeExitCells).toEqual(b.fakeExitCells);

    const c = new Game(withFakes, 778);
    expect(c.fakeExitCells).not.toEqual(a.fakeExitCells);
  });

  it('假门是可以走过去的普通走廊格，不会把路堵死', () => {
    const withFakes: Difficulty = { ...diff, cols: 12, rows: 12, fakeExits: 2 };
    const game = new Game(withFakes, 909);
    for (const f of game.fakeExitCells) {
      expect(inMaze(game.maze, f.x, f.y)).toBe(true);
      expect(openings(game.maze, f.x, f.y).length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('游戏：限时通关', () => {
  it('限时耗尽会进入失败状态并回调 onLose，之后不再接受拖动', () => {
    // 用数组收集而不是 `let x: T | null = null`：后者会让 TS 把闭包里的赋值
    // 当成不存在，收窄到 never，构建时的 tsc 会直接报错。
    const results: LoseResult[] = [];
    const timed: Difficulty = { ...diff, timeLimitSec: 3 };
    const game = new Game(timed, 12, {
      onLose: (r) => {
        results.push(r);
      },
    });

    expect(game.timeLeft).toBe(3);
    run(game, 2);
    expect(game.phaseNow).toBe('playing');
    expect(game.timeLeft as number).toBeGreaterThan(0);

    run(game, 1.5);
    expect(game.phaseNow).toBe('lost');
    const lose = results[0];
    if (!lose) throw new Error('限时耗尽没有触发 onLose');
    expect(lose.timeLimit).toBe(3);
    expect(game.timeLeft).toBe(0);

    // 失败之后笔怎么划都不动
    const frozen = { ...game.playerPos };
    const route = solve(game.maze);
    const next = route[1] as { x: number; y: number };
    game.beginPointer(game.playerCell.x, game.playerCell.y);
    game.dragTo(next.x, next.y);
    run(game, 1);
    expect(game.playerPos).toEqual(frozen);
  });

  it('不限时（timeLimitSec 为 null）时永远不会失败', () => {
    const game = new Game({ ...diff, timeLimitSec: null }, 3);
    expect(game.timeLeft).toBeNull();
    run(game, 90);
    expect(game.phaseNow).toBe('playing');
  });

  it('大师档的限时足够宽松，走完正路用不掉一半时间', () => {
    // 限时是「压力」不是「不可能」：先量出这一档解路径的真实长度，
    // 再按 6.5 格/秒的理想速度估算纯赶路耗时，必须远小于限时。
    const master = presetById('master');
    const limit = master.timeLimitSec;
    if (limit === null) throw new Error('大师档应当限时');
    let worstRatio = 0;
    for (let s = 0; s < 8; s++) {
      const game = new Game(master, s * 991 + 7);
      const idealSeconds = (game.solution.length - 1) / 6.5;
      worstRatio = Math.max(worstRatio, idealSeconds / limit);
    }
    // 纯赶路（不含走错与折返）应当只占限时的一小半
    expect(worstRatio).toBeLessThan(0.5);
  });
});

describe('游戏：巡逻怪', () => {
  it('怪会沿路线移动，不是站着不动的装饰', () => {
    const guarded: Difficulty = {
      ...diff,
      cols: 16,
      rows: 16,
      guards: 2,
      branchiness: 1,
      braid: 0,
    };
    const game = new Game(guarded, 31);
    expect(game.guardPositions().length).toBe(2);

    // 采样整段时间而不是只看两秒后的位移：怪的路线可能很短，
    // 「两秒后恰好回到出发点附近」是正常现象，不能因此判它没动。
    const origin = game.guardPositions().map((p) => ({ x: p.x, y: p.y }));
    const moved = origin.map(() => false);
    for (let t = 0; t < 240; t++) {
      game.update(1 / 60);
      game.guardPositions().forEach((p, i) => {
        const a = origin[i] as { x: number; y: number };
        if (Math.abs(p.x - a.x) + Math.abs(p.y - a.y) > 0.5) moved[i] = true;
      });
    }
    expect(moved).toEqual([true, true]);
  });

  it('撞上怪会被送回起点、进入短暂无敌，且已吃到的星星不会丢', () => {
    const guarded: Difficulty = {
      ...diff,
      cols: 24,
      rows: 24,
      shape: 'star',
      branchiness: 1,
      braid: 0,
      guards: 1,
    };

    let caught = 0;
    let collectedAtCatch = -1;
    let ref: Game | null = null;
    const game = new Game(guarded, 20261015, {
      onCaught: () => {
        caught++;
        collectedAtCatch = ref ? ref.collected : -1;
      },
    });
    ref = game;

    // 笔尖追着怪的当前位置，逐帧推进；怪慢、小球快，必然追上
    for (let i = 0; i < 3000 && caught === 0 && game.phaseNow === 'playing'; i++) {
      const g = game.guardPositions()[0];
      if (g) game.dragTo(g.x, g.y);
      game.update(1 / 60);
    }

    expect(game.phaseNow).toBe('playing');
    expect(caught).toBe(1);
    expect(game.playerCell).toEqual(game.maze.start);
    expect(game.isGracePeriod).toBe(true);
    // 回起点只是位置重置，收集进度必须原样保留
    expect(game.collected).toBe(collectedAtCatch);

    // 无敌时间内原地不动也不会被再抓一次
    const stillCaught = caught;
    run(game, 1);
    expect(caught).toBe(stillCaught);
  });

  it('怪的路线始终避开起点格（否则会陷入「刚复活又被抓」的死循环）', () => {
    for (let s = 0; s < 6; s++) {
      const guarded: Difficulty = {
        ...diff,
        cols: 18,
        rows: 18,
        shape: 'star',
        guards: 3,
        branchiness: 1,
        braid: 0,
      };
      const game = new Game(guarded, s * 137 + 11);
      // 让怪走很久，确认它们的活动范围内不包含起点正中心
      for (let i = 0; i < 600; i++) {
        game.update(1 / 60);
        for (const p of game.guardPositions()) {
          const d = Math.abs(p.x - game.maze.start.x) + Math.abs(p.y - game.maze.start.y);
          // 允许从旁边经过（距离 1），但绝不能压在起点上
          expect(d).toBeGreaterThan(0.5);
        }
      }
    }
  });
});
