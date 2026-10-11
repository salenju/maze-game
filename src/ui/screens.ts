/**
 * UI 构建与屏幕管理。
 *
 * 刻意保持无框架：所有界面都是静态 HTML + 少量动态生成，
 * 这样打包产物只有几 KB，平板上首次打开几乎是瞬时的。
 */

import { clampCustom, LIMITS, PRESETS, type Difficulty, type FootprintMode } from '../core/difficulty';
import { type Prefs, type Progress } from '../game/storage';

export type ScreenName =
  | 'home'
  | 'difficulty'
  | 'game'
  | 'win'
  | 'pause'
  | 'howto'
  | 'settings'
  | 'install';

export class Screens {
  private current: ScreenName = 'home';
  private readonly elements = new Map<ScreenName, HTMLElement>();

  constructor(root: ParentNode = document) {
    const names: ScreenName[] = [
      'home',
      'difficulty',
      'game',
      'win',
      'pause',
      'howto',
      'settings',
      'install',
    ];
    for (const name of names) {
      const el = root.querySelector<HTMLElement>(`[data-screen="${name}"]`);
      if (!el) throw new Error(`缺少屏幕元素：${name}`);
      this.elements.set(name, el);
    }
  }

  show(name: ScreenName): void {
    for (const [key, el] of this.elements) {
      el.dataset['active'] = key === name ? 'true' : 'false';
    }
    this.current = name;
  }

  get active(): ScreenName {
    return this.current;
  }

  el(name: ScreenName): HTMLElement {
    const el = this.elements.get(name);
    if (!el) throw new Error(`未知屏幕：${name}`);
    return el;
  }

  /** 返回上一个「主界面」屏幕，用于返回按钮。 */
  back(): void {
    if (this.current === 'difficulty') this.show('home');
    else if (this.current === 'howto' || this.current === 'settings' || this.current === 'install') {
      this.show('home');
    }
  }
}

/** 需要 DOM 存在的辅助查询。 */
export function must<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`缺少元素：${selector}`);
  return el;
}

/** 生成难度选择列表。 */
export function renderDifficultyList(
  container: HTMLElement,
  selectedId: string,
  onSelect: (d: Difficulty) => void,
  custom: Difficulty,
): void {
  container.replaceChildren();

  const items: Difficulty[] = [...PRESETS, custom];

  for (const diff of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'diff-item';
    button.setAttribute('aria-pressed', diff.id === selectedId ? 'true' : 'false');

    const h3 = document.createElement('h3');
    h3.textContent =
      diff.id === 'custom' ? diff.name : `${diff.name}　${diff.cols}×${diff.rows}`;

    const p = document.createElement('p');
    p.textContent = diff.ageHint;

    const tags = document.createElement('div');
    tags.className = 'diff-tags';
    for (const label of describeDifficulty(diff)) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = label;
      tags.append(tag);
    }

    button.append(h3, p, tags);
    button.addEventListener('click', () => onSelect(diff));
    container.append(button);
  }
}

/**
 * 就地更新「自定义」列表项的摘要（标题尺寸 + 标签）。
 *
 * 刻意不重建整个列表：列表里 `replaceChildren()` 会连带重建自定义面板，
 * 而家长此刻通常正按着滑块。只改文字节点就能同时保证摘要准确与拖动不被打断。
 */
export function updateCustomSummary(container: HTMLElement, custom: Difficulty): void {
  const items = container.querySelectorAll<HTMLElement>('.diff-item');
  const item = items[items.length - 1];
  if (!item) return;

  const h3 = item.querySelector('h3');
  if (h3) h3.textContent = `${custom.name}　${custom.cols}×${custom.rows}`;

  const tags = item.querySelector('.diff-tags');
  if (!tags) return;
  tags.replaceChildren();
  for (const label of describeDifficulty(custom)) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = label;
    tags.append(tag);
  }
}

/** 把难度翻译成孩子/家长能一眼看懂的标签。 */
export function describeDifficulty(diff: Difficulty): string[] {
  const tags: string[] = [];
  tags.push(`迷宫 ${diff.cols}×${diff.rows}`);
  tags.push(diff.timed ? '有计时' : '不计时');

  const fp: Record<FootprintMode, string> = {
    always: '脚印常显',
    fade: `${diff.footprintFadeSec} 秒淡出`,
    none: '没有脚印',
  };
  tags.push(fp[diff.footprint]);

  if (diff.stars > 0) tags.push(`${diff.stars} 颗星星`);
  if (diff.hintDelayMs !== null) tags.push('卡住会提示');
  // braid 越大越简单，但不必向家长暴露这个术语，用日常语言描述
  if (diff.braid >= 0.5) tags.push('死路少');
  else if (diff.braid >= 0.2) tags.push('死路适中');
  else tags.push('死路多');
  return tags;
}

/**
 * 生成家长自定义面板。
 *
 * 注意第二个参数是 getter 而不是 Difficulty 值，这一点很关键：
 * 面板在拖动过程中刻意不重建（重建会打断 range 的拖动），
 * 若闭包捕获的是一份固定快照，那么「先调宽度、再调高度」时，
 * 调高度会基于旧快照写回，把刚设好的宽度又覆盖回去 ——
 * 家长看到的现象是「拖了不生效」。用 getter 每次读取最新值即可根治。
 */
export function renderCustomPanel(
  container: HTMLElement,
  getCustom: () => Difficulty,
  onChange: (updated: Difficulty) => void,
): void {
  container.replaceChildren();

  const heading = document.createElement('h3');
  heading.textContent = '家长自定义';
  container.append(heading);

  // 初始渲染用一份一致快照：此时面板刚建立，各控件显示同一个配置版本
  const snapshot = getCustom();

  const emit = (patch: Partial<Difficulty>) => {
    // 每次都基于「当前最新」的配置合并，而不是面板渲染时的旧快照
    const next = clampCustom({ ...getCustom(), ...patch });
    onChange(next);
  };

  container.append(
    sliderField({
      label: '迷宫宽度',
      min: LIMITS.minCols,
      max: LIMITS.maxCols,
      step: 1,
      value: snapshot.cols,
      display: (v) => `${v} 格`,
      hint: '格子越多，迷宫越大。6 岁建议 7-10 格，10 岁可以到 18 格以上。',
      onInput: (v) => emit({ cols: v }),
    }),
    sliderField({
      label: '迷宫高度',
      min: LIMITS.minRows,
      max: LIMITS.maxRows,
      step: 1,
      value: snapshot.rows,
      display: (v) => `${v} 格`,
      hint: '高度和宽度不必相同，长方形迷宫也很适合平板。',
      onInput: (v) => emit({ rows: v }),
    }),
    sliderField({
      label: '环路数量',
      min: 0,
      max: 100,
      step: 5,
      value: Math.round(snapshot.braid * 100),
      display: (v) => (v === 0 ? '0（死路最多）' : v >= 80 ? `${v}（几乎都是环路）` : `${v}`),
      // 这里必须解释清楚，否则家长容易把两个方向搞反
      hint: '数值越大越简单：环路多、死路少，走错了容易绕回来。想加难度就往左调。',
      onInput: (v) => emit({ braid: v / 100 }),
    }),
    selectField({
      label: '走过的路',
      value: snapshot.footprint,
      options: [
        { value: 'always', label: '一直显示脚印（最简单）' },
        { value: 'fade', label: '脚印慢慢消失' },
        { value: 'none', label: '不留脚印（最难）' },
      ],
      onInput: (v) => emit({ footprint: v as FootprintMode }),
    }),
    sliderField({
      label: '脚印消失时间',
      min: 2,
      max: 20,
      step: 1,
      value: snapshot.footprintFadeSec,
      display: (v) => `${v} 秒`,
      hint: '只有选「脚印慢慢消失」时有效。时间越长越简单。',
      onInput: (v) => emit({ footprintFadeSec: v }),
    }),
    toggleField({
      label: '计时',
      checked: snapshot.timed,
      hint: '开启后会记录用时；低龄段建议关掉，避免造成压力。',
      onInput: (v) => emit({ timed: v }),
    }),
    sliderField({
      label: '星星数量',
      min: LIMITS.minStars,
      max: LIMITS.maxStars,
      step: 1,
      value: snapshot.stars,
      display: (v) => (v === 0 ? '不要星星' : `${v} 颗`),
      hint: '星星放在必经之路上，纯属奖励，不收集也能通关。',
      onInput: (v) => emit({ stars: v }),
    }),
    toggleField({
      label: '卡住时给提示箭头',
      checked: snapshot.hintDelayMs !== null,
      hint: '开启后，长时间没有进展会显示指路箭头，避免孩子卡住失去兴趣。',
      onInput: (v) => emit({ hintDelayMs: v ? 20_000 : null }),
    }),
  );
}

interface SliderFieldOptions {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  display: (v: number) => string;
  hint: string;
  onInput: (v: number) => void;
}

function sliderField(opts: SliderFieldOptions): HTMLElement {
  const field = document.createElement('div');
  field.className = 'field';

  const id = `f-${Math.random().toString(36).slice(2, 9)}`;
  const label = document.createElement('label');
  label.htmlFor = id;
  label.textContent = opts.label;

  const output = document.createElement('output');
  output.textContent = opts.display(opts.value);

  const input = document.createElement('input');
  input.type = 'range';
  input.id = id;
  input.min = String(opts.min);
  input.max = String(opts.max);
  input.step = String(opts.step);
  input.value = String(opts.value);
  // 拖动中实时更新显示，但只在 change 时写回存储，避免频繁落盘
  input.addEventListener('input', () => {
    const v = Number(input.value);
    output.textContent = opts.display(v);
    opts.onInput(v);
  });

  const hint = document.createElement('p');
  hint.className = 'field-hint';
  hint.textContent = opts.hint;

  field.append(label, output, input, hint);
  return field;
}

interface SelectFieldOptions {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onInput: (v: string) => void;
}

function selectField(opts: SelectFieldOptions): HTMLElement {
  const field = document.createElement('div');
  field.className = 'field';

  const id = `f-${Math.random().toString(36).slice(2, 9)}`;
  const label = document.createElement('label');
  label.htmlFor = id;
  label.textContent = opts.label;

  const select = document.createElement('select');
  select.id = id;
  select.style.cssText =
    'grid-column:1/-1;min-height:52px;border-radius:12px;background:#16233d;color:#e8eefc;border:2px solid rgba(255,255,255,0.14);font-size:16px;padding:0 12px;font-family:inherit;';
  for (const o of opts.options) {
    const option = document.createElement('option');
    option.value = o.value;
    option.textContent = o.label;
    select.append(option);
  }
  select.value = opts.value;
  select.addEventListener('change', () => opts.onInput(select.value));

  field.append(label, document.createElement('span'), select);
  return field;
}

interface ToggleFieldOptions {
  label: string;
  checked: boolean;
  hint: string;
  onInput: (v: boolean) => void;
}

function toggleField(opts: ToggleFieldOptions): HTMLElement {
  const field = document.createElement('div');
  field.className = 'field';

  const wrap = document.createElement('div');
  wrap.className = 'switch';

  const id = `f-${Math.random().toString(36).slice(2, 9)}`;
  const label = document.createElement('label');
  label.htmlFor = id;
  label.textContent = opts.label;

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.id = id;
  input.checked = opts.checked;
  input.addEventListener('change', () => opts.onInput(input.checked));

  wrap.append(label, input);

  const hint = document.createElement('p');
  hint.className = 'field-hint';
  hint.textContent = opts.hint;

  field.append(wrap, hint);
  return field;
}

/** 游戏内的声音与辅助设置面板。 */
export function renderSettingsPanel(
  container: HTMLElement,
  prefs: Prefs,
  onChange: (updated: Prefs) => void,
): void {
  container.replaceChildren();
  container.append(
    toggleField({
      label: '游戏音效',
      checked: prefs.sound,
      hint: '撞墙、吃到星星、走出迷宫时会有提示音。在教室等安静场合可以关掉。',
      onInput: (v) => onChange({ ...prefs, sound: v }),
    }),
    toggleField({
      label: '高亮走廊',
      checked: prefs.highlightCorridors,
      hint: '把可以走的路先淡淡显示出来，对第一次玩迷宫的小朋友更友好。熟悉之后可以关掉增加挑战。',
      onInput: (v) => onChange({ ...prefs, highlightCorridors: v }),
    }),
    toggleField({
      label: '每次打开都看玩法说明',
      checked: !prefs.tutorialSeen,
      hint: '开启后，每次点「开始游戏」都会先显示一遍操作说明。',
      onInput: (v) => onChange({ ...prefs, tutorialSeen: !v }),
    }),
  );
}

/** 首页统计信息。 */
export function renderHomeStats(container: HTMLElement, progress: Progress): void {
  const clearedTotal = Object.values(progress.cleared).reduce((a, b) => a + b, 0);
  if (clearedTotal === 0) {
    container.replaceChildren();
    const p = document.createElement('p');
    p.textContent = '还没有通关记录，选个难度试试吧';
    container.append(p);
    return;
  }

  const lines: string[] = [`已经走出迷宫 <b>${clearedTotal}</b> 次`];
  if (progress.totalStars > 0) lines.push(`一共收集了 <b>${progress.totalStars}</b> 颗星星`);

  for (const preset of PRESETS) {
    const best = progress.best[preset.id];
    if (!best) continue;
    lines.push(
      `${preset.name}最好成绩 <b>${formatTime(best.seconds)}</b>` +
        (best.stars > 0 ? `（${best.stars} 颗星）` : ''),
    );
  }

  container.innerHTML = lines.map((l) => `<p>${l}</p>`).join('');
}

export function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** 结算页内容。 */
export interface WinPanelData {
  seconds: number;
  stars: number;
  totalStars: number;
  usedHint: boolean;
  isBest: boolean;
  explored: number;
  mazeCells: number;
}

export function renderWinPanel(
  titleEl: HTMLElement,
  starsEl: HTMLElement,
  statsEl: HTMLElement,
  data: WinPanelData,
): void {
  const hints: string[] = [];
  if (data.usedHint) hints.push('用过提示箭头');

  titleEl.textContent = data.stars > 0 && data.stars === data.totalStars ? '全部星星都拿到啦！' : '走出迷宫啦！';

  // 用实心/空心星星直观展示收集情况，比数字更容易被孩子理解
  if (data.totalStars > 0) {
    starsEl.textContent =
      '★'.repeat(data.stars) + '☆'.repeat(Math.max(0, data.totalStars - data.stars));
  } else {
    starsEl.textContent = '';
  }

  const rows: [string, string][] = [
    ['用时', formatTime(data.seconds)],
    ['探索了', `${data.explored} / ${data.mazeCells} 格`],
  ];
  if (data.totalStars > 0) rows.push(['星星', `${data.stars} / ${data.totalStars}`]);
  if (data.isBest) rows.push(['新纪录', '这是目前最快的成绩']);
  if (hints.length > 0) rows.push(['小提示', hints.join('、')]);

  statsEl.replaceChildren();
  for (const [k, v] of rows) {
    const div = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    div.append(dt, dd);
    statsEl.append(div);
  }
}

/**
 * 「添加到主屏幕」引导。
 *
 * iOS 完全不支持 beforeinstallprompt，无法用程序触发安装，
 * 因此只能给出手把手的图示化步骤。这不是偷懒，是平台限制下唯一可行的做法。
 */
export function renderInstallGuide(
  leadEl: HTMLElement,
  stepsEl: HTMLElement,
  kind: 'ios-safari' | 'ios-other' | 'android' | 'desktop',
): void {
  stepsEl.replaceChildren();

  const config: Record<typeof kind, { lead: string; steps: string[] }> = {
    'ios-safari': {
      lead: '用 iPad 玩可以装成 App，图标会出现在主屏幕上，没网也能玩。',
      steps: [
        '点屏幕底部中间的「分享」按钮（方框里一个向上的箭头）',
        '在弹出菜单里往下滑，找到「添加到主屏幕」',
        '点右上角「添加」，主屏幕上就会出现迷宫图标',
      ],
    },
    'ios-other': {
      lead: 'iOS 上只有 Safari 能把网页装到主屏幕，请改用 Safari 打开这个网址。',
      steps: [
        '复制当前网址',
        '打开 Safari，把网址粘贴进去',
        '点「分享」→「添加到主屏幕」',
      ],
    },
    android: {
      lead: '可以装成 App，图标会出现在应用列表里，没网也能玩。',
      steps: [
        '点右上角的「⋮」菜单',
        '选择「安装应用」或「添加到主屏幕」',
        '确认后就能像普通 App 一样打开',
      ],
    },
    desktop: {
      lead: '当前是电脑浏览器。要用平板玩，请直接在平板上打开这个网址。',
      steps: ['把网址发到平板上', '用平板浏览器打开即可开始玩'],
    },
  };

  const cfg = config[kind];
  leadEl.textContent = cfg.lead;
  for (const step of cfg.steps) {
    const li = document.createElement('li');
    const num = document.createElement('span');
    num.className = 'howto-num';
    num.textContent = '·';
    li.append(num, document.createTextNode(step));
    stepsEl.append(li);
  }
}

/** 运行环境判断，用于挑选合适的安装引导。 */
export function detectPlatform(): 'ios-safari' | 'ios-other' | 'android' | 'desktop' {
  const ua = globalThis.navigator?.userAgent ?? '';
  const isIOS =
    /iPad|iPhone|iPod/.test(ua) ||
    // iPadOS 13+ 的 Safari 伪装成 macOS，靠触摸点数区分
    (/Macintosh/.test(ua) && (globalThis.navigator?.maxTouchPoints ?? 0) > 1);

  if (isIOS) {
    const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
    return isSafari ? 'ios-safari' : 'ios-other';
  }
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
}

/** 是否已经处于「已安装」的独立窗口模式。 */
export function isStandalone(): boolean {
  const nav = globalThis.navigator as (Navigator & { standalone?: boolean }) | undefined;
  if (nav?.standalone === true) return true;
  return globalThis.matchMedia?.('(display-mode: standalone)').matches === true;
}

export function applyPrefsToUI(prefs: Prefs): void {
  // 目前只有音效需要在启动时同步到音频层，由 main.ts 处理
  void prefs;
}
