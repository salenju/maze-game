/**
 * Canvas 2D 渲染层。
 *
 * 三个平板专属的坑都在这里处理：
 *  1. devicePixelRatio：不处理的话在 iPad 视网膜屏上线条发虚，孩子看着「脏」。
 *  2. 画布按「格子整数倍」布局，避免半像素墙线导致粗细不均。
 *  3. 每帧全量重绘而非增量：576 格规模下开销极低，
 *     换来的是零状态同步 bug —— 儿童应用最怕画面与实际状态不一致。
 */

import { N, E, S, W, inMaze, type Cell, type Dir, type Maze } from '../core/maze';
import { type FootprintMode } from '../core/difficulty';
import { type Footprint, type Game } from './game';

const COLORS = {
  bg: '#0f1729',
  wall: '#e8eefc',
  wallGlow: '#7aa2ff',
  floor: '#16233d',
  footprint: '#2f4a7d',
  footprintFade: '#243a63',
  player: '#ffcf4d',
  playerRing: '#fff3c4',
  star: '#ffe066',
  exit: '#4ade80',
  exitDim: '#166534',
  start: '#60a5fa',
  hint: '#ff8fab',
  trail: 'rgba(122, 162, 255, 0.45)',
} as const;

export interface RenderOptions {
  /** 当前游戏时间，用于淡出计算与动画 */
  now: number;
  footprintMode: FootprintMode;
  footprintFadeSec: number;
  /** 是否高亮可行走的走廊（辅助模式） */
  highlightCorridors: boolean;
  /** 目标格（用于显示指针落点） */
  targetCell: Cell | null;
}

export class Renderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private cellSize = 32;
  private originX = 0;
  private originY = 0;
  private cssWidth = 0;
  private cssHeight = 0;
  private dpr = 1;

  /** 星星的弹跳动画相位 */
  private starPhase = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('无法获取 Canvas 2D 上下文');
    this.ctx = ctx;
  }

  /**
   * 按容器尺寸与迷宫规模重新计算布局。
   * 返回格子边长（CSS 像素），供输入层做坐标换算。
   */
  resize(maze: Maze, availWidth: number, availHeight: number): number {
    const dpr = Math.min(3, Math.max(1, globalThis.devicePixelRatio || 1));
    this.dpr = dpr;
    this.cssWidth = availWidth;
    this.cssHeight = availHeight;

    // 留出边距，避免最外圈墙贴着屏幕边缘（平板上手指/笔容易误触系统手势区）
    const pad = Math.max(6, Math.min(availWidth, availHeight) * 0.02);
    const usableW = Math.max(1, availWidth - pad * 2);
    const usableH = Math.max(1, availHeight - pad * 2);

    // 格子的线宽需要空间，所以按 (cols + 0.5) 估算
    const cell = Math.min(usableW / (maze.cols + 0.5), usableH / (maze.rows + 0.5));

    // 取整到 0.5 的倍数：让墙面线落在这类坐标上更锐利，又不会因强取整丢失太多尺寸
    this.cellSize = Math.max(6, Math.floor(cell * 2) / 2);

    const totalW = this.cellSize * maze.cols;
    const totalH = this.cellSize * maze.rows;
    this.originX = Math.round((availWidth - totalW) / 2);
    this.originY = Math.round((availHeight - totalH) / 2);

    this.canvas.width = Math.round(availWidth * dpr);
    this.canvas.height = Math.round(availHeight * dpr);
    this.canvas.style.width = `${availWidth}px`;
    this.canvas.style.height = `${availHeight}px`;

    return this.cellSize;
  }

  get cell(): number {
    return this.cellSize;
  }

  get origin(): { x: number; y: number } {
    return { x: this.originX, y: this.originY };
  }

  /** 屏幕坐标（相对画布左上角的 CSS 像素）→ 迷宫的浮点格坐标 */
  toCellCoords(screenX: number, screenY: number): { x: number; y: number } {
    return {
      x: (screenX - this.originX) / this.cellSize,
      y: (screenY - this.originY) / this.cellSize,
    };
  }

  render(game: Game, opts: RenderOptions): void {
    const ctx = this.ctx;
    const maze = game.maze;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);

    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);

    this.starPhase = opts.now;

    const c = this.cellSize;
    const ox = this.originX;
    const oy = this.originY;

    // 地板：逐格画，形状之外留空（露出背景色），轮廓才是形状本身。
    // 早先是整块 fillRect，圆形迷宫会露出一块方形地板，形状感全没了。
    this.drawFloor(maze, c, ox, oy);

    if (opts.highlightCorridors) this.drawCorridors(maze, c, ox, oy);
    this.drawFootprints(game, opts, c, ox, oy);
    this.drawStartAndExit(maze, game, c, ox, oy);
    this.drawStars(game, c, ox, oy);
    if (opts.targetCell) this.drawTarget(opts.targetCell, c, ox, oy);
    if (game.showHint) this.drawHint(game, c, ox, oy);
    this.drawWalls(maze, c, ox, oy);
    this.drawPlayer(game, c, ox, oy);
  }

  /**
   * 地板：只画属于迷宫的格子。
   *
   * 形状迷宫必须逐格画 —— 整块矩形会让圆形看起来还是方的。
   * 为了不让格子边缘出现「细细的网格缝」，每格向外多画 0.5px 让相邻格重叠。
   */
  private drawFloor(maze: Maze, c: number, ox: number, oy: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = COLORS.floor;
    const bleed = 0.5;
    for (let y = 0; y < maze.rows; y++) {
      for (let x = 0; x < maze.cols; x++) {
        if (!inMaze(maze, x, y)) continue;
        ctx.fillRect(ox + x * c - bleed, oy + y * c - bleed, c + bleed * 2, c + bleed * 2);
      }
    }
    ctx.restore();
  }

  /** 辅助模式：把可通行的格子连成走廊，帮助低龄孩子建立「路」的概念。 */
  private drawCorridors(maze: Maze, c: number, ox: number, oy: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = 'rgba(122, 162, 255, 0.16)';
    ctx.lineWidth = c * 0.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let y = 0; y < maze.rows; y++) {
      for (let x = 0; x < maze.cols; x++) {
        const cx = ox + (x + 0.5) * c;
        const cy = oy + (y + 0.5) * c;
        for (const dir of [E, S] as Dir[]) {
          const dx = dir === E ? 1 : 0;
          const dy = dir === S ? 1 : 0;
          const nx = x + dx;
          const ny = y + dy;
          if (!inMaze(maze, nx, ny)) continue;
          if (this.hasWall(maze, x, y, dir)) continue;
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx + dx * c, cy + dy * c);
        }
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawFootprints(
    game: Game,
    opts: RenderOptions,
    c: number,
    ox: number,
    oy: number,
  ): void {
    if (opts.footprintMode === 'none') return;

    const ctx = this.ctx;
    const maze = game.maze;
    const list: readonly Footprint[] = game.footprintList();

    ctx.save();
    for (const fp of list) {
      const x = fp.index % maze.cols;
      const y = (fp.index - x) / maze.cols;

      let alpha = 1;
      if (opts.footprintMode === 'fade') {
        const age = opts.now - fp.at;
        const life = Math.max(0.5, opts.footprintFadeSec);
        alpha = 1 - age / life;
        if (alpha <= 0.02) continue;
        alpha = Math.min(1, alpha);
      }

      ctx.globalAlpha = alpha * 0.85;
      ctx.fillStyle = opts.footprintMode === 'fade' ? COLORS.footprintFade : COLORS.footprint;
      const inset = c * 0.26;
      roundRect(ctx, ox + x * c + inset, oy + y * c + inset, c - inset * 2, c - inset * 2, c * 0.16);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawStartAndExit(maze: Maze, game: Game, c: number, ox: number, oy: number): void {
    const ctx = this.ctx;

    // 起点
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = COLORS.start;
    const sx = ox + maze.start.x * c + c * 0.18;
    const sy = oy + maze.start.y * c + c * 0.18;
    roundRect(ctx, sx, sy, c * 0.64, c * 0.64, c * 0.18);
    ctx.fill();
    ctx.restore();

    // 出口：脉冲动画吸引注意（孩子需要知道目标在哪）
    const pulse = 0.72 + 0.28 * Math.sin(game.seconds * 3.2);
    ctx.save();
    ctx.globalAlpha = 0.35 + 0.3 * pulse;
    ctx.fillStyle = COLORS.exit;
    const ex = ox + maze.exit.x * c;
    const ey = oy + maze.exit.y * c;
    roundRect(ctx, ex + c * 0.1, ey + c * 0.1, c * 0.8, c * 0.8, c * 0.2);
    ctx.fill();

    ctx.globalAlpha = 0.95;
    ctx.fillStyle = COLORS.exitDim;
    // 画成「拱门/旗杆」而不是实心三角：
    // 实心三角在绿色圆角底上会读成播放按钮，孩子会去点它。
    drawGoalMarker(ctx, ex + c * 0.5, ey + c * 0.5, c * 0.5);
    ctx.restore();
  }

  private drawStars(game: Game, c: number, ox: number, oy: number): void {
    const ctx = this.ctx;
    ctx.save();
    for (let i = 0; i < game.starCells.length; i++) {
      if (game.isStarTaken(i)) continue;
      const s = game.starCells[i] as Cell;
      const bob = Math.sin(this.starPhase * 3 + i * 1.3) * c * 0.06;
      const cx = ox + (s.x + 0.5) * c;
      const cy = oy + (s.y + 0.5) * c + bob;

      ctx.shadowColor = COLORS.star;
      ctx.shadowBlur = c * 0.45;
      ctx.fillStyle = COLORS.star;
      drawStar(ctx, cx, cy, c * 0.3, c * 0.13);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawTarget(cell: Cell, c: number, ox: number, oy: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
    ctx.lineWidth = Math.max(1.5, c * 0.06);
    const inset = c * 0.22;
    roundRect(ctx, ox + cell.x * c + inset, oy + cell.y * c + inset, c - inset * 2, c - inset * 2, c * 0.2);
    ctx.stroke();
    ctx.restore();
  }

  /** 提示箭头：画在小人当前格上，指向解路径的下一步。 */
  private drawHint(game: Game, c: number, ox: number, oy: number): void {
    const next = game.hintNextStep();
    if (!next) return;

    const ctx = this.ctx;
    const cur = game.playerCell;
    const dx = next.x - cur.x;
    const dy = next.y - cur.y;

    const cx = ox + (cur.x + 0.5) * c;
    const cy = oy + (cur.y + 0.5) * c;
    const bob = Math.sin(this.starPhase * 5) * c * 0.08;

    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = COLORS.hint;
    ctx.translate(cx + dx * c * 0.45, cy + dy * c * 0.45 + bob);

    const angle = dx > 0 ? 0 : dx < 0 ? Math.PI : dy > 0 ? Math.PI / 2 : -Math.PI / 2;
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(c * 0.3, 0);
    ctx.lineTo(-c * 0.1, -c * 0.18);
    ctx.lineTo(-c * 0.1, c * 0.18);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  private drawWalls(maze: Maze, c: number, ox: number, oy: number): void {
    const ctx = this.ctx;
    const lineWidth = Math.max(2, c * 0.13);

    ctx.save();
    ctx.strokeStyle = COLORS.wall;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // 轻微发光让墙在深色底上更「实」，小朋友更容易分辨边界
    ctx.shadowColor = COLORS.wallGlow;
    ctx.shadowBlur = lineWidth * 1.2;

    ctx.beginPath();
    for (let y = 0; y < maze.rows; y++) {
      for (let x = 0; x < maze.cols; x++) {
        // 形状之外的格子不画墙：它们本来就不属于迷宫，
        // 画出来会在圆形/星形外面多出一圈「外接矩形」的轮廓。
        if (!inMaze(maze, x, y)) continue;
        const px = ox + x * c;
        const py = oy + y * c;

        if (this.hasWall(maze, x, y, N)) {
          ctx.moveTo(px, py);
          ctx.lineTo(px + c, py);
        }
        if (this.hasWall(maze, x, y, S)) {
          ctx.moveTo(px, py + c);
          ctx.lineTo(px + c, py + c);
        }
        if (this.hasWall(maze, x, y, W)) {
          ctx.moveTo(px, py);
          ctx.lineTo(px, py + c);
        }
        if (this.hasWall(maze, x, y, E)) {
          ctx.moveTo(px + c, py);
          ctx.lineTo(px + c, py + c);
        }
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawPlayer(game: Game, c: number, ox: number, oy: number): void {
    const ctx = this.ctx;
    const pos = game.playerPos;
    const cx = ox + (pos.x + 0.5) * c;
    const cy = oy + (pos.y + 0.5) * c;
    const r = c * 0.3;

    ctx.save();
    // 外发光 + 白圈：在深色底和高亮墙上都能看清，平板上尤其重要
    ctx.shadowColor = COLORS.player;
    ctx.shadowBlur = c * 0.6;
    ctx.fillStyle = COLORS.player;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.strokeStyle = COLORS.playerRing;
    ctx.lineWidth = Math.max(1.5, c * 0.07);
    ctx.stroke();

    // 小眼睛，给孩子的角色感
    ctx.fillStyle = '#1a2338';
    const eyeR = Math.max(1, r * 0.16);
    ctx.beginPath();
    ctx.arc(cx - r * 0.32, cy - r * 0.18, eyeR, 0, Math.PI * 2);
    ctx.arc(cx + r * 0.32, cy - r * 0.18, eyeR, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private hasWall(maze: Maze, x: number, y: number, dir: Dir): boolean {
    const bit = 1 << dir;
    const idx = y * maze.cols + x;
    return ((maze.walls[idx] ?? 15) & bit) !== 0;
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function drawStar(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  outer: number,
  inner: number,
): void {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (Math.PI / 5) * i - Math.PI / 2;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/** 出口标记：一个门洞形状，明确表达「从这儿出去」。 */
function drawGoalMarker(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
): void {
  const w = size * 0.62;
  const h = size * 0.78;
  const x = cx - w / 2;
  const y = cy - h / 2 + size * 0.04;

  ctx.beginPath();
  // 拱门：两侧直边 + 顶部半圆
  ctx.moveTo(x, y + h);
  ctx.lineTo(x, y + w / 2);
  ctx.arc(cx, y + w / 2, w / 2, Math.PI, 0);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
  ctx.fill();
}
