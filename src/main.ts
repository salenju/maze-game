/**
 * 应用入口：把核心逻辑、渲染、输入、UI 组装起来。
 *
 * 主循环用 requestAnimationFrame，并对 dt 做上限保护：
 * 平板切到后台再切回来时，rAF 的时间戳可能跳跃好几秒，
 * 不限幅的话小黄球会瞬移穿过大半个迷宫。
 */

import './ui/styles.css';

import {
  loadCustom,
  presetById,
  PRESETS,
  saveCustom,
  withShape,
  withStars,
  type Difficulty,
} from './core/difficulty';
import type { ShapeId } from './core/shape';
import { deadEndCount, junctionCount, mazeCellCount } from './core/maze';
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
  describeSize,
  detectPlatform,
  formatTime,
  must,
  renderCustomPanel,
  renderDifficultyList,
  renderHomeStats,
  renderInstallGuide,
  renderSettingsPanel,
  renderShapeField,
  renderStarsField,
  renderWinPanel,
  Screens,
  updateCustomSummary,
} from './ui/screens';
import { appVersion, versionLabel } from './ui/version';

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

  /**
   * 当前难度 = 选中档位 + 家长的形状/星星覆盖。
   *
   * 两者都是跨难度的：进了「挑战」仍然用家长选的形状，而不是档位自带的星形；
   * 星星数量同理 —— 家长调一次就该对每一档生效，否则「设了星星却没出现」。
   */
  private difficulty: Difficulty = withStars(
    withShape(PRESETS[0] as Difficulty, this.prefs.shapeOverride),
    this.prefs.starsOverride,
  );
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
  /**
   * 说明页是从「开始游戏」进入的（true）还是从首页「怎么玩」进入的（false）。
   * 两者的「我知道啦」行为必须不同：
   *   - 从开始游戏进入 → 确认后开局
   *   - 从「怎么玩」进入 → 只是查阅说明，确认后回首页，且不得消耗首次引导
   */
  private howtoStartsGame = false;

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
        this.howtoStartsGame = true;
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

    // 首页的「怎么玩」只是查阅说明：不置 howtoStartsGame，确认后应回首页
    must('#btn-howto').addEventListener('click', () => {
      this.howtoStartsGame = false;
      this.screens.show('howto');
    });

    must('#btn-settings').addEventListener('click', () => {
      this.audio.unlock();
      this.audio.play('click');
      this.showSettings();
    });

    must('#btn-settings-ok').addEventListener('click', () => this.screens.show('home'));

    must('#btn-howto-ok').addEventListener('click', () => {
      if (!this.howtoStartsGame) {
        // 只是查阅说明：回首页，且不消耗首次引导（否则孩子真正第一次玩时就没有引导了）
        this.screens.show('home');
        return;
      }
      // 首次游玩引导：确认后标记已读并开局
      this.howtoStartsGame = false;
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
    // 「下一关」= 同一难度换一张新地图（不是升难度）。
    // 早前误把它做成升难度阶梯（7x7 → 10x10 → …），但那不是孩子的预期：
    // 他们想在同一难度下一直玩新地图。换难度是家长在「难度设置」里做的事。
    must('#btn-next').addEventListener('click', () => {
      this.audio.play('click');
      this.startGame(this.difficulty, Game.newSeed());
    });
    // 「再玩一次」= 同一难度、同一张地图。
    // 用同一个种子重开，孩子可以带着记忆再走一遍、刷新自己的纪录。
    must('#btn-retry').addEventListener('click', () => {
      this.audio.play('click');
      this.startGame(this.difficulty, this.game?.seed ?? Game.newSeed());
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
    // 每次回首页都刷新一次版本徽标：SW 自动更新后无需重开页面就能看到新版本号
    must('#app-version').textContent = versionLabel();

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

  /** 重绘形状与星星选择行、难度列表与自定义面板。 */
  private refreshDifficultyUI(): void {
    this.refreshShapePanel();
    this.refreshStarsPanel();
    this.refreshDifficultyCards();
    this.refreshCustomPanel();
  }

  /**
   * 重画难度卡片（卡片上的形状/尺寸/星星摘要都跟着覆盖值走）。
   *
   * 刻意与上面两行分开：滑块拖动期间绝不能重建自己所在的那一行，
   * 否则 range 元素被换掉、指针捕获丢失，家长只能拖动一格 ——
   * 这正是「自定义滑块拖不动」那类缺陷的成因。
   */
  private refreshDifficultyCards(): void {
    renderDifficultyList(
      must('#diff-list'),
      this.difficulty.id,
      (diff) => {
        // diff 是档位本身（预设或自定义）：形状与星星覆盖在这里统一叠加上去，
        // 于是「选了形状再选难度」时形状不会被档位自带的形状顶掉
        this.difficulty = this.effective(diff);
        this.audio.play('click');
        // 只改选中态，不重建列表：重建会打断自定义面板正在进行的滑块拖动
        this.syncDifficultySelection();
        // 「跟随难度」时两行上的默认值来自当前档位，换档必须重画
        this.refreshShapePanel();
        this.refreshStarsPanel();
        if (diff.id === 'custom') this.refreshCustomPanel();
      },
      this.custom,
      this.prefs.shapeOverride,
      this.prefs.starsOverride,
    );
  }

  /**
   * 星星数量行：与形状一样对所有难度生效。
   *
   * 这一行曾经是「家长自定义」面板里的一个滑块，改动只写进自定义档位，
   * 于是家长在默认选中的「入门」档下把它拉到 6 颗、开局却一颗都没有。
   * 提到外层并落进 prefs 之后，任何档位开局都按这个数量放星星。
   */
  private refreshStarsPanel(): void {
    renderStarsField(must('#stars-panel'), {
      value: this.prefs.starsOverride,
      fallback: this.selectedStars(),
      onInput: (stars: number | null) => {
        this.prefs = { ...this.prefs, starsOverride: stars };
        savePrefs(this.prefs);
        this.difficulty = this.effective(this.selected());
        // 卡片上写着「N 颗星星」：只重画卡片，不动正在拖的滑块
        this.refreshDifficultyCards();
      },
    });
  }

  /** 形状选择行：形状对所有难度生效，改动后难度卡片上的形状也要立刻跟着变。 */
  private refreshShapePanel(): void {
    renderShapeField(must('#shape-panel'), {
      value: this.prefs.shapeOverride,
      fallback: this.selectedShape(),
      onInput: (shape: ShapeId | null) => {
        this.prefs = { ...this.prefs, shapeOverride: shape };
        savePrefs(this.prefs);
        this.audio.play('click');
        this.difficulty = this.effective(this.selected());
        // 卡片上写的是「星形 18×18」这类摘要，形状一改就必须重画，
        // 否则家长看到的和真开出来的不是同一张图。
        // 形状行自己是按钮，重画不会打断任何拖动，仍然可以整块刷新。
        this.refreshDifficultyUI();
      },
    });
  }

  /** 当前选中的档位本身（不含形状覆盖）。预设是常量，自定义存在 this.custom。 */
  private selected(): Difficulty {
    return this.difficulty.id === 'custom' ? this.custom : presetById(this.difficulty.id);
  }

  /** 选中档位自带的形状，即「跟随难度」时会用到的形状。 */
  private selectedShape(): ShapeId {
    return this.selected().shape;
  }

  /** 选中档位自带的星星数量，即「跟随难度」时会用到的数量。 */
  private selectedStars(): number {
    return this.selected().stars;
  }

  /** 把家长的形状与星星覆盖叠加到给定难度上。 */
  private effective(diff: Difficulty): Difficulty {
    return withStars(withShape(diff, this.prefs.shapeOverride), this.prefs.starsOverride);
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
        // 正在使用自定义难度时，改动立即生效（形状覆盖照旧叠加在自定义之上）
        if (this.difficulty.id === 'custom') {
          this.difficulty = this.effective(updated);
        }
        // 同步列表里「自定义」卡片的尺寸与标签，但不重建列表
        updateCustomSummary(
          must('#diff-list'),
          updated,
          this.prefs.shapeOverride,
          this.prefs.starsOverride,
        );
      },
    );
  }

  private isInstalled(): boolean {
    const nav = navigator as Navigator & { standalone?: boolean };
    return nav.standalone === true || matchMedia('(display-mode: standalone)').matches;
  }

  // ---------- 游戏生命周期 ----------

  private startGame(difficulty: Difficulty, seed: number): void {
    this.audio.unlock();
    // 兜底再叠加一次形状覆盖：首页「开始游戏」等入口传进来的可能是档位本身
    const diff = this.effective(difficulty);
    this.difficulty = diff;

    this.game = new Game(diff, seed, {
      onStar: () => this.audio.play('star'),
      onBump: () => {
        this.audio.play('bump');
        this.flashHint('这边是墙，换个方向试试');
      },
      onWin: (result) => this.handleWin(result),
    });

    // HUD 上把形状也写出来：孩子玩到一半被家长换过形状时，
    // 一行「圆形 7×7」比只有尺寸更能说明这一局是什么。
    must('#hud-diff').textContent = `${diff.name}　${describeSize(diff)}`;
    must('#hud-time').textContent = diff.timed ? '0:00' : '--:--';
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

    // 结算页三个按钮的语义（清晰区分，避免孩子困惑）：
    //   下一关   → 同一难度，换一张新地图（永远可用）
    //   再玩一次 → 同一难度，同一张地图，用来刷新纪录
    //   回首页   → 回家
    // 不再有「升到顶就隐藏按钮」的逻辑：任何难度下都永远可以继续玩。
    must<HTMLButtonElement>('#btn-next').hidden = false;

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
    // 只记录落点，不授予前进额度：
    // 这样「轻点一下」不会让小球自己走过去，移动必须由笔尖移动驱动。
    const cell = this.renderer.toCellCoords(sample.x, sample.y);
    this.game?.beginPointer(cell.x, cell.y);
    this.targetCell = this.game?.pointerTargetCell ?? null;
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
    this.game.dragTo(cell.x, cell.y);
    // 落点方框用游戏吸附后的格子：形状迷宫里原始坐标可能落在图形之外
    this.targetCell = this.game.pointerTargetCell;
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
    shape: string;
    /** 属于迷宫的格子数（形状 mask 之外的格不计入） */
    mazeCells: number;
    /** 岔路口数量（三个及以上出口的格子），用来实测难度提升 */
    junctions: number;
    /** 死胡同数量 */
    deadEnds: number;
    footprints: number;
    /** 本局星星总数（固定值，不随收集变化） */
    starsTotal: number;
    /** 已吃到的星星数 */
    starsCollected: number;
    cell: number;
  } {
    const g = this.game;
    return {
      cols: g?.maze.cols ?? 0,
      rows: g?.maze.rows ?? 0,
      // 形状与岔路是本次新增的能力，验收脚本要能实测它们真的生效
      shape: g?.maze.shape ?? 'square',
      mazeCells: g ? mazeCellCount(g.maze) : 0,
      junctions: g ? junctionCount(g.maze) : 0,
      deadEnds: g ? deadEndCount(g.maze) : 0,
      footprints: g?.footprintList().length ?? 0,
      // 刻意区分总数与已收集数：早先只暴露一个含糊的 stars 字段，
      // 验收脚本把它当成「剩余」来断言，导致明明吃到星星却判为失败。
      starsTotal: g?.totalStars ?? 0,
      starsCollected: g?.collected ?? 0,
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

  /**
   * 小球在解路径上已推进的「解路径步数」。
   *
   * 为什么需要它：每次开局都用随机种子生成迷宫，
   * 因此「小球走了几格」这种绝对数值跨次运行不可比
   * （两次跑的根本是不同迷宫，起终点距离不同）。
   * 用「解路径上的位置」这类相对量才能稳定衡量拖动是否跟手。
   */
  debugSolutionProgress(): { index: number; total: number } {
    const g = this.game;
    if (!g) return { index: 0, total: 0 };
    const cur = g.playerCell;
    let best = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < g.solution.length; i++) {
      const c = g.solution[i] as { x: number; y: number };
      const d = Math.abs(c.x - cur.x) + Math.abs(c.y - cur.y);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return { index: best, total: g.solution.length };
  }

  /**
   * 当前迷宫的墙体签名（自动化验收用）。
   *
   * 用于比较两次开局拿到的是不是同一张地图：
   * 换地图靠换种子，因此签名变化即证明地图确实换了；
   * 「再走一遍这张」要求签名完全一致。
   */
  debugWallSignature(): string {
    const g = this.game;
    if (!g) return '';
    let sum = 0;
    let hash = 0;
    for (let i = 0; i < g.maze.walls.length; i++) {
      const w = g.maze.walls[i] as number;
      sum += w;
      hash = (hash * 31 + w) >>> 0;
    }
    return `${g.maze.cols}x${g.maze.rows}:${sum}:${hash}`;
  }

  /** 提示箭头当前是否可见（自动化验收用）。 */
  debugHintVisible(): boolean {
    return this.game?.showHint ?? false;
  }

  /** 提示箭头指向的下一格（自动化验收用）。 */
  debugHintNext(): { x: number; y: number } | null {
    const next = this.game?.hintNextStep() ?? null;
    return next ? { x: next.x, y: next.y } : null;
  }

  /**
   * 当前构建的版本号（自动化验收用）。
   *
   * 在线验收靠它做「线上跑的就是这次发布的版本」的硬断言 ——
   * 只检查首页有没有徽标是不够的，旧的 Service Worker 缓存照样能渲染出徽标。
   */
  debugVersion(): string {
    return appVersion();
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
    solutionProgress: () => app.debugSolutionProgress(),
    wallSignature: () => app.debugWallSignature(),
    hintVisible: () => app.debugHintVisible(),
    hintNext: () => app.debugHintNext(),
    version: () => app.debugVersion(),
  };
} catch (error) {
  // 平板上没有控制台，把错误直接画到页面上，方便远程排查。
  // 这里也要带上版本号：报告「打不开」时，第一件要确认的就是装的是哪一版。
  const message = error instanceof Error ? error.message : String(error);
  document.body.innerHTML =
    `<div style="padding:24px;color:#e8eefc;font-family:system-ui;line-height:1.7">` +
    `<h2 style="color:#ffcf4d">启动失败</h2><p>${message}</p>` +
    `<p style="color:#9fb0d0;font-size:14px">${versionLabel()}　请刷新重试。</p></div>`;
}

export {};
