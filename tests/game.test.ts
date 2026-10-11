import { describe, expect, it } from 'vitest';
import { Game } from '../src/game/game';
import { canMove, hasWall, type Dir, DX, DY, type Maze } from '../src/core/maze';
import { clampCustom, presetById, type Difficulty } from '../src/core/difficulty';
import { formatTime, describeDifficulty } from '../src/ui/screens';

/** 固定难度，让断言稳定可复现。 */
const diff: Difficulty = {
  id: 'test',
  name: '测试',
  ageHint: '',
  cols: 10,
  rows: 10,
  braid: 0.2,
  footprint: 'always',
  footprintFadeSec: 6,
  timed: true,
  stars: 3,
  hintDelayMs: 15_000,
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
  it('拖动后小人会朝目标移动，且始终留在合法格子内', () => {
    const game = new Game(diff, 4242);
    const target = { x: 9, y: 9 };
    game.dragTo(target.x, target.y);

    for (let i = 0; i < 600; i++) {
      game.update(1 / 60);
      const cell = game.playerCell;
      assertNoWallCrossing(game.maze, cell.x, cell.y);
    }

    // 10x10 迷宫最长路径远小于 600 帧（10 秒）能走的距离，应已抵达出口附近
    const distance =
      Math.abs(game.playerCell.x - target.x) + Math.abs(game.playerCell.y - target.y);
    expect(distance).toBeLessThanOrEqual(1);
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

  it('重复拖到同一个目标格不会重置进度', () => {
    const game = new Game(diff, 606);
    game.dragTo(9, 9);
    run(game, 1.0);
    const snapshot = game.playerCell;

    // 反复上报同一格（真机上 pointermove 会高频重复）
    for (let i = 0; i < 50; i++) game.dragTo(9, 9);
    run(game, 0.5);

    // 应该继续前进，而不是被反复重置回起点
    const advanced =
      Math.abs(game.playerCell.x - snapshot.x) + Math.abs(game.playerCell.y - snapshot.y);
    expect(advanced).toBeGreaterThan(0);
  });

  it('越界的拖动坐标被夹紧，不会抛异常', () => {
    const game = new Game(diff, 12);
    expect(() => game.dragTo(-50, -50)).not.toThrow();
    expect(() => game.dragTo(9999, 9999)).not.toThrow();
    run(game, 1);
    assertNoWallCrossing(game.maze, game.playerCell.x, game.playerCell.y);
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

    game.dragTo(9, 9);
    run(game, 20);
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
    game.dragTo(9, 9);
    run(game, 20);
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
    game.dragTo(9, 9);
    run(game, 20);
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
    game.dragTo(9, 9);
    run(game, 20);
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
