/**
 * 应用入口：把核心逻辑、渲染、输入、UI 组装起来。
 *
 * 主循环用 requestAnimationFrame，并对 dt 做上限保护：
 * 平板切到后台再切回来时，rAF 的时间戳可能跳跃好几秒，
 * 不限幅的话小黄球会瞬移穿过大半个迷宫。
 */

import './ui/styles.css';

import { loadCustom, PRESETS, saveCustom, type Difficulty } from './core/difficulty';
import { PointerInput, lockViewport, type PointerSample } from './game/input';
import { Game, type WinResult } from './game/game';
import { Renderer } from './game/renderer';
import { Audio } from './game/audio';
import {
  loadPrefs,
  loadProgress,
  recordWin,
  savePrefs,
  saveProgress,
  type Prefs,
  type Progress,
} from './game/storage';
import {
  detectPlatform,
  formatTime,
  must,
  renderCustomPanel,
  renderDifficultyList,
  renderHomeStats,
  renderInstallGuide,
  renderSettingsPanel,
  renderWinPanel,
  Screens,
  updateCustomSummary,
} from './ui/screens';

/** 单帧最大推进时间（秒）。切后台回来的时间跳跃在此被截断。 */
const MAX_DT = 1 / 20;

/** 底部提示栏的默认文案。 */
const DEFAULT_HINT = '按住笔尖，带着小黄球走';

class App {
  private readonly screens = new Screens();
  private readonly renderer: Renderer;
  private readonly audio = new Audio();
  private readonly canvas: HTMLCanvasElement;
  private readonly canvasWrap: HTMLElement;

  private progress: Progress = loadProgress();
  private prefs: Prefs = loadPrefs();
  private custom: Difficulty = loadCustom();

  private difficulty: Difficulty = PRESETS[0] as Difficulty;
  private game: Game | null = null;
  private input: PointerInput | null = null;

  private rafId = 0;
  private lastTimestamp = 0;
  private dragging = false;
  private targetCell: { x: number; y: number } | null = null;
  private pausedByVisibility = false;
  private installPromptEvent: { prompt: () => Promise<void> } | null = null;
  /** 首次通关后置为 true，回到首页时展示一次安装引导 */
  private pendingInstallGuide = false;
  /** 最近收到的指针类型，仅用于自动化验收确认笔事件被正确识别 */
  private readonly seenPointerTypes: string[] = [];
  /** 提示栏自动复位用的定时器句柄，0 表示没有待执行的复位 */
  private hintTimer = 0;

  constructor() {
    this.canvas = must<HTMLCanvasElement>('#maze-canvas');
    this.canvasWrap = must<HTMLElement>('#canvas-wrap');
    this.renderer = new Renderer(this.canvas);

    this.audio.setEnabled(this.prefs.sound);
    lockViewport();
    this.bindEvents();
    this.setupInstallPrompt();
    this.showHome();
  }

  // ---------- 事件绑定 ----------

  private bindEvents(): void {
    must('#btn-play').addEventListener('click', () => {
      this.audio.unlock();
      this.audio.play('click');
      // 首次游玩先给操作引导，避免孩子握着笔不知道怎么开始
      if (!this.prefs.tutorialSeen) {
        this.screens.show('howto');
      } else {
        this.startGame(this.difficulty, Game.newSeed());
      }
    });

    must('#btn-difficulty').addEventListener('click', () => {
      this.audio.unlock();
      this.audio.play('click');
      this.showDifficulty();
    });

    must('#btn-howto').addEventListener('click', () => this.screens.show('howto'));

    must('#btn-settings').addEventListener('click', () => {
      this.audio.unlock();
      this.audio.play('click');
      this.showSettings();
    });

    must('#btn-settings-ok').addEventListener('click', () => this.screens.show('home'));

    must('#btn-howto-ok').addEventListener('click', () => {
      this.prefs = { ...this.prefs, tutorialSeen: true };
      savePrefs(this.prefs);
      this.startGame(this.difficulty, Game.newSeed());
    });

    must('#btn-start').addEventListener('click', () => {
      this.audio.unlock();
      this.audio.play('click');
      this.startGame(this.difficulty, Game.newSeed());
    });

    for (const el of document.querySelectorAll('[data-back]')) {
      el.addEventListener('click', () => this.screens.back());
    }

    // 游戏内
    must('#btn-pause').addEventListener('click', () => this.pauseGame());
    must('#btn-resume').addEventListener('click', () => this.resumeGame());
    must('#btn-restart').addEventListener('click', () => {
      // 重开同一关用同一种子：孩子失败后能带着记忆重来，不被随机性惩罚
      this.startGame(this.difficulty, this.game?.seed ?? Game.newSeed());
    });
    must('#btn-quit').addEventListener('click', () => this.showHome());

    // 结算
    must('#btn-next').addEventListener('click', () => {
      this.audio.play('click');
      const next = this.nextDifficulty();
      this.startGame(next, Game.newSeed());
    });
    must('#btn-retry').addEventListener('click', () => {
      this.audio.play('click');
      this.startGame(this.difficulty, Game.newSeed());
    });
    must('#btn-home').addEventListener('click', () => this.showHome());

    must('#btn-install-ok').addEventListener('click', () => {
      this.progress = { ...this.progress, installHintSeen: true };
      saveProgress(this.progress);
      this.screens.show('home');
    });

    // 安卓：调用浏览器原生安装流程
    must('#btn-install-now').addEventListener('click', () => {
      const evt = this.installPromptEvent;
      if (!evt) return;
      void evt.prompt();
      this.installPromptEvent = null;
      must<HTMLButtonElement>('#btn-install-now').hidden = true;
      this.progress = { ...this.progress, installHintSeen: true };
      saveProgress(this.progress);
    });

    window.addEventListener('resize', () => this.relayout());
    window.addEventListener('orientationchange', () => {
      // iOS 上方向变化后尺寸不会立刻稳定，延后一帧再量
      setTimeout(() => this.relayout(), 260);
    });

    // 切到后台自动暂停：孩子退出去接电话回来，计时不该继续跑
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (this.screens.active === 'game' && this.game?.phaseNow === 'playing') {
          this.pausedByVisibility = true;
          this.pauseGame();
        }
      } else if (this.pausedByVisibility) {
        this.pausedByVisibility = false;
      }
    });
  }

  /** 安装引导：安卓可程序化触发，iOS 只能给图示。 */
  private setupInstallPrompt(): void {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.installPromptEvent = e as unknown as { prompt: () => Promise<void> };
    });
  }

  // ---------- 屏幕流转 ----------

  private showHome(): void {
    this.stopLoop();
    this.game = null;
    renderHomeStats(must('#home-stats'), this.progress);

    // 第一次通关后回首页时再给安装引导：此刻家长通常就在旁边，引导才有人看
    if (this.pendingInstallGuide && this.maybeShowInstallGuide()) {
      this.pendingInstallGuide = false;
      this.screens.show('install');
      return;
    }

    this.screens.show('home');
  }

  /**
   * 安装引导。
   *
   * 时机是刻意选的：不在首次进站就弹（那时孩子只想玩），
   * 而是在第一次通关后 —— 此时家长往往就在旁边，引导才有人看。
   * iOS 没有任何安装提示 API，只能给出图示步骤，这是平台限制不是实现偷懒。
   */
  private maybeShowInstallGuide(): boolean {
    if (this.progress.installHintSeen) return false;
    if (this.isInstalled()) return false;

    renderInstallGuide(
      must('#install-lead'),
      must('#install-steps'),
      detectPlatform(),
    );

    // 安卓/Chromium 支持程序化安装：直接给一个「立即安装」按钮，一步到位。
    // iOS 完全没有这个能力，只能显示图示步骤 —— 这是平台限制，不是实现取舍。
    const installNow = must<HTMLButtonElement>('#btn-install-now');
    installNow.hidden = this.installPromptEvent === null;
    return true;
  }

  private showDifficulty(): void {
    this.refreshDifficultyUI();
    this.screens.show('difficulty');
  }

  /** 声音与辅助设置。改动即时生效并落盘，不需要「保存」按钮。 */
  private showSettings(): void {
    renderSettingsPanel(must('#settings-list'), this.prefs, (updated) => {
      this.prefs = updated;
      savePrefs(updated);
      // 音效开关要立刻反映到音频层，否则家长会觉得开关没反应
      this.audio.setEnabled(updated.sound);
    });
    this.screens.show('settings');
  }

  /** 重绘难度列表与自定义面板。 */
  private refreshDifficultyUI(): void {
    renderDifficultyList(
      must('#diff-list'),
      this.difficulty.id,
      (diff) => {
        this.difficulty = diff;
        this.audio.play('click');
        // 只改选中态，不重建列表：重建会打断自定义面板正在进行的滑块拖动
        this.syncDifficultySelection();
        if (diff.id === 'custom') this.refreshCustomPanel();
      },
      this.custom,
    );
    this.refreshCustomPanel();
  }

  /** 让列表高亮与 this.difficulty 保持一致（自定义项永远排在最后）。 */
  private syncDifficultySelection(): void {
    const items = Array.from(document.querySelectorAll<HTMLElement>('.diff-item'));
    const ids = [...PRESETS.map((p) => p.id), 'custom'];
    const selectedIndex = ids.indexOf(this.difficulty.id);
    items.forEach((el, i) => {
      el.setAttribute('aria-pressed', i === selectedIndex ? 'true' : 'false');
    });
  }

  /** 单独重绘自定义面板，供滑块实时反馈使用。 */
  private refreshCustomPanel(): void {
    // 传 getter 而非快照：滑块拖动期间面板不会重建，
    // 快照会过期并导致「改了后一个滑块、前一个被回退」。
    renderCustomPanel(
      must('#custom-panel'),
      () => this.custom,
      (updated) => {
        this.custom = updated;
        saveCustom(updated);
        // 正在使用自定义难度时，改动立即生效
        if (this.difficulty.id === 'custom') {
          this.difficulty = updated;
        }
        // 同步列表里「自定义」卡片的尺寸与标签，但不重建列表
        updateCustomSummary(must('#diff-list'), updated);
      },
    );
  }

  private nextDifficulty(): Difficulty {
    const idx = PRESETS.findIndex((p) => p.id === this.difficulty.id);
    if (idx < 0) return this.difficulty;
    return PRESETS[Math.min(PRESETS.length - 1, idx + 1)] as Difficulty;
  }

  private isInstalled(): boolean {
    const nav = navigator as Navigator & { standalone?: boolean };
    return nav.standalone === true || matchMedia('(display-mode: standalone)').matches;
  }

  // ---------- 游戏生命周期 ----------

  private startGame(difficulty: Difficulty, seed: number): void {
    this.audio.unlock();
    this.difficulty = difficulty;

    this.game = new Game(difficulty, seed, {
      onStar: () => this.audio.play('star'),
      onBump: () => {
        this.audio.play('bump');
        this.flashHint('这边是墙，换个方向试试');
      },
      onWin: (result) => this.handleWin(result),
    });

    must('#hud-diff').textContent = `${difficulty.name}　${difficulty.cols}×${difficulty.rows}`;
    must('#hud-time').textContent = difficulty.timed ? '0:00' : '--:--';
    must('#hud-stars').textContent = this.starsLabel();

    // 每局重置底部提示，避免沿用上一局残留的「这边是墙」
    if (this.hintTimer !== 0) {
      window.clearTimeout(this.hintTimer);
      this.hintTimer = 0;
    }
    must('#hint-bar').textContent = DEFAULT_HINT;

    this.screens.show('game');
    this.relayout();
    this.attachInput();
    this.startLoop();
  }

  private starsLabel(): string {
    const g = this.game;
    if (!g || g.totalStars === 0) return '';
    return `★ ${g.collected}/${g.totalStars}`;
  }

  /**
   * 短暂显示一条提示，随后自动恢复默认文案。
   * 不恢复的话，撞一次墙之后底部会永远停在「这边是墙」，
   * 孩子会以为游戏卡住了。
   */
  private flashHint(text: string): void {
    const bar = must('#hint-bar');
    bar.textContent = text;
    if (this.hintTimer !== 0) window.clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => {
      this.hintTimer = 0;
      bar.textContent = DEFAULT_HINT;
    }, 2500);
  }

  private pauseGame(): void {
    this.game?.pause();
    this.detachInput();
    this.stopLoop();
    this.screens.show('pause');
  }

  /**
   * 继续游戏。
   *
   * 必须重新挂载输入并重启循环 —— pauseGame() 把它们都拆掉了。
   * 早期版本这里只做 screens.show('game') + resume()，
   * 结果暂停一次之后画笔就彻底失效、画面也停住，属于致命缺陷。
   */
  private resumeGame(): void {
    const g = this.game;
    if (!g) {
      this.showHome();
      return;
    }
    g.resume();
    this.screens.show('game');
    this.relayout();
    this.attachInput();
    this.startLoop();
  }

  private handleWin(result: WinResult): void {
    if (!this.game) return;
    this.audio.play('win');
    this.detachInput();
    this.stopLoop();

    const prevBest = this.progress.best[this.difficulty.id];
    const isBest = !prevBest || result.seconds < prevBest.seconds;

    this.progress = recordWin(
      this.progress,
      this.difficulty.id,
      result.seconds,
      result.stars,
    );
    saveProgress(this.progress);

    // 首次通关后，回首页时给一次安装引导
    if (!this.progress.installHintSeen) this.pendingInstallGuide = true;

    renderWinPanel(must('#win-title'), must('#win-stars'), must('#win-stats'), {
      seconds: result.seconds,
      stars: result.stars,
      totalStars: result.totalStars,
      usedHint: result.usedHint,
      isBest,
      explored: this.game.exploredCount,
      mazeCells: this.game.mazeCellCount,
    });

    // 已经是最后一档就不再显示「下一关」
    const nextBtn = must<HTMLButtonElement>('#btn-next');
    nextBtn.hidden = this.difficulty.id === (PRESETS[PRESETS.length - 1] as Difficulty).id;

    this.screens.show('win');
  }

  // ---------- 输入与渲染 ----------

  private attachInput(): void {
    this.detachInput();
    this.input = new PointerInput(this.canvas, {
      onStart: (s) => this.onPointerStart(s),
      onMove: (samples) => this.onPointerMove(samples),
      onEnd: () => this.onPointerEnd(),
    });
  }

  private detachInput(): void {
    this.input?.destroy();
    this.input = null;
    this.dragging = false;
    this.targetCell = null;
  }

  private onPointerStart(sample: PointerSample): void {
    // 在真实用户手势里解锁音频（iOS 强要求）
    this.audio.unlock();
    this.recordPointerType(sample.pointerType);
    this.dragging = true;
    this.applyPointer(sample);
  }

  private onPointerMove(samples: PointerSample[]): void {
    if (!this.dragging) return;
    // 合并事件可能带来一批采样点，逐点更新即可；
    // 最终位置由最后一次调用决定，中间点只是让轨迹更贴合笔尖。
    const last = samples[samples.length - 1];
    if (last) {
      this.recordPointerType(last.pointerType);
      this.applyPointer(last);
    }
  }

  private recordPointerType(type: string): void {
    if (this.seenPointerTypes[this.seenPointerTypes.length - 1] === type) return;
    this.seenPointerTypes.push(type);
    if (this.seenPointerTypes.length > 20) this.seenPointerTypes.shift();
  }

  private onPointerEnd(): void {
    this.dragging = false;
    this.targetCell = null;
    this.game?.releasePointer();
  }

  private applyPointer(sample: PointerSample): void {
    if (!this.game) return;
    const cell = this.renderer.toCellCoords(sample.x, sample.y);
    this.targetCell = { x: Math.floor(cell.x), y: Math.floor(cell.y) };
    this.game.dragTo(cell.x, cell.y);
  }

  private relayout(): void {
    // 游戏未开始时无需测量：切进游戏时 startGame() 会立刻调用一次
    if (!this.game) return;

    const rect = this.canvasWrap.getBoundingClientRect();
    const width = Math.max(120, rect.width);
    const height = Math.max(120, rect.height);
    this.renderer.resize(this.game.maze, width, height);
  }

  private startLoop(): void {
    this.stopLoop();
    this.lastTimestamp = performance.now();
    const tick = (now: number) => {
      this.rafId = requestAnimationFrame(tick);
      const dt = Math.min(MAX_DT, Math.max(0, (now - this.lastTimestamp) / 1000));
      this.lastTimestamp = now;
      this.frame(dt);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopLoop(): void {
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  // ---------- 自动化验收探针（只读） ----------

  debugPlayerCell(): { x: number; y: number } {
    return this.game?.playerCell ?? { x: -1, y: -1 };
  }

  /** 小人当前的屏幕坐标（相对视口），供脚本把笔尖对准小人。 */
  debugPlayerScreenPos(): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const p = this.game?.playerPos ?? { x: 0, y: 0 };
    const origin = this.renderer.origin;
    const cell = this.renderer.cell;
    return {
      x: rect.left + origin.x + (p.x + 0.5) * cell,
      y: rect.top + origin.y + (p.y + 0.5) * cell,
    };
  }

  debugMazeInfo(): {
    cols: number;
    rows: number;
    footprints: number;
    stars: number;
    cell: number;
  } {
    const g = this.game;
    return {
      cols: g?.maze.cols ?? 0,
      rows: g?.maze.rows ?? 0,
      footprints: g?.footprintList().length ?? 0,
      stars: g?.totalStars ?? 0,
      cell: this.renderer.cell,
    };
  }

  /** 最近一次指针事件的类型序列，用于确认笔事件确实被识别为 pen。 */
  debugPointerTypes(): string[] {
    return [...this.seenPointerTypes];
  }

  /**
   * 当前位置到出口的完整解路径（格坐标）。
   * 仅供自动化验收沿真实路径走完迷宫的用，不提供任何写操作。
   */
  debugSolution(): { x: number; y: number }[] {
    return this.game?.solution.map((c) => ({ x: c.x, y: c.y })) ?? [];
  }

  /** 把格坐标换算成画布内的屏幕坐标，供脚本把笔尖移到指定格。 */
  debugCellToScreen(x: number, y: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const origin = this.renderer.origin;
    const cell = this.renderer.cell;
    return {
      x: rect.left + origin.x + (x + 0.5) * cell,
      y: rect.top + origin.y + (y + 0.5) * cell,
    };
  }

  private frame(dt: number): void {
    const g = this.game;
    if (!g) return;

    g.update(dt);

    if (this.difficulty.timed) {
      must('#hud-time').textContent = formatTime(g.seconds);
    }
    if (g.totalStars > 0) {
      must('#hud-stars').textContent = this.starsLabel();
    }

    this.renderer.render(g, {
      now: g.seconds,
      footprintMode: this.difficulty.footprint,
      footprintFadeSec: this.difficulty.footprintFadeSec,
      highlightCorridors: this.prefs.highlightCorridors,
      targetCell: this.targetCell,
    });
  }
}

// 启动
try {
  const app = new App();

  // 自动化验收用的只读探针。
  // 存在的理由：迷宫游戏的核心是「笔拖动是否真的生效」，
  // 而这件事只能靠真实浏览器输入管线来验证，无法用纯单元测试覆盖。
  // 只暴露读取接口，不提供任何修改游戏状态的入口。
  (window as unknown as { __mazeDebug?: unknown }).__mazeDebug = {
    playerCell: () => app.debugPlayerCell(),
    playerScreenPos: () => app.debugPlayerScreenPos(),
    mazeInfo: () => app.debugMazeInfo(),
    lastPointerTypes: () => app.debugPointerTypes(),
    solution: () => app.debugSolution(),
    cellToScreen: (x: number, y: number) => app.debugCellToScreen(x, y),
  };
} catch (error) {
  // 平板上没有控制台，把错误直接画到页面上，方便远程排查
  const message = error instanceof Error ? error.message : String(error);
  document.body.innerHTML =
    `<div style="padding:24px;color:#e8eefc;font-family:system-ui;line-height:1.7">` +
    `<h2 style="color:#ffcf4d">启动失败</h2><p>${message}</p>` +
    `<p style="color:#9fb0d0;font-size:14px">请刷新重试。</p></div>`;
}

export {};
