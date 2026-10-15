/**
 * UI 构建与屏幕管理。
 *
 * 刻意保持无框架：所有界面都是静态 HTML + 少量动态生成，
 * 这样打包产物只有几 KB，平板上首次打开几乎是瞬时的。
 */

import {
  clampCustom,
  LIMITS,
  PRESETS,
  withShape,
  withStars,
  type Difficulty,
  type FootprintMode,
} from '../core/difficulty';
import { SHAPE_HINTS, SHAPE_IDS, SHAPE_LABELS, type ShapeId } from '../core/shape';
import { type Prefs, type Progress } from '../game/storage';

export type ScreenName =
  | 'home'
  | 'difficulty'
  | 'game'
  | 'win'
  | 'lose'
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
      'lose',
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
  /** 家长选的形状覆盖：卡片上显示的形状必须和真开出来的局一致 */
  shapeOverride: ShapeId | null = null,
  /** 家长选的星星数量覆盖：卡片上的「N 颗星星」也必须和真开出来的局一致 */
  starsOverride: number | null = null,
): void {
  container.replaceChildren();

  const items: Difficulty[] = [...PRESETS, custom].map((d) =>
    withStars(withShape(d, shapeOverride), starsOverride),
  );

  for (const diff of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'diff-item';
    // 稳定的档位 id，供自动化脚本按名字选中。
    // 以前脚本用 `.diff-item` 的**位置**选（nth(4) = 自定义），
    // 本次在「挑战」之后插入「大师」档，位置全部后移，会静默地改错档位 ——
    // 与当初给滑块加 data-field 是同一个理由。
    button.dataset['diffId'] = diff.id;
    button.setAttribute('aria-pressed', diff.id === selectedId ? 'true' : 'false');

    const h3 = document.createElement('h3');
    h3.textContent = diff.id === 'custom' ? diff.name : `${diff.name}　${describeSize(diff)}`;

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
export function updateCustomSummary(
  container: HTMLElement,
  custom: Difficulty,
  shapeOverride: ShapeId | null = null,
  starsOverride: number | null = null,
): void {
  const items = container.querySelectorAll<HTMLElement>('.diff-item');
  const item = items[items.length - 1];
  if (!item) return;

  const shown = withStars(withShape(custom, shapeOverride), starsOverride);

  const h3 = item.querySelector('h3');
  if (h3) h3.textContent = `${shown.name}　${describeSize(shown)}`;

  const tags = item.querySelector('.diff-tags');
  if (!tags) return;
  tags.replaceChildren();
  for (const label of describeDifficulty(shown)) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = label;
    tags.append(tag);
  }
}

/** 列表标题里的尺寸摘要，形状也一并显示，家长一眼能看出这张图长什么样。 */
export function describeSize(diff: Difficulty): string {
  const shape = SHAPE_LABELS[diff.shape] ?? SHAPE_LABELS.square;
  return `${shape} ${diff.cols}×${diff.rows}`;
}

/** 把难度翻译成孩子/家长能一眼看懂的标签。 */
export function describeDifficulty(diff: Difficulty): string[] {
  const tags: string[] = [];
  tags.push(`${SHAPE_LABELS[diff.shape] ?? SHAPE_LABELS.square}迷宫`);
  tags.push(`${diff.cols}×${diff.rows}`);
  if (diff.timeLimitSec !== null) tags.push(`限时 ${formatTime(diff.timeLimitSec)}`);
  else tags.push(diff.timed ? '有计时' : '不计时');

  const fp: Record<FootprintMode, string> = {
    always: '脚印常显',
    fade: `${diff.footprintFadeSec} 秒淡出`,
    none: '没有脚印',
  };
  tags.push(fp[diff.footprint]);

  if (diff.stars > 0) tags.push(`${diff.stars} 颗星星`);
  if (diff.hintDelayMs !== null) tags.push('卡住会提示');

  // 「附加机制」单独列出。它们是加难度的新维度，与下面的岔路/环路无关，
  // 混在一起家长会以为调岔路就能得到（或关掉）迷雾。
  if (diff.viewRadius !== null) tags.push(`只看清 ${diff.viewRadius} 格`);
  if (diff.fakeExits > 0) tags.push(`${diff.fakeExits} 个假出口`);
  if (diff.guards > 0) tags.push(`${diff.guards} 只巡逻怪`);

  // 两个参数方向相反，标签分开描述，绝不合成一个「难度」，
  // 否则家长根本分不清该调哪个。
  // 岔路：越大越难（决策点多）
  if (diff.branchiness >= 0.7) tags.push('岔路很多');
  else if (diff.branchiness >= 0.4) tags.push('岔路较多');
  else tags.push('岔路较少');
  // 环路：越大越简单（死路少），不必向家长暴露术语，用日常语言描述
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
 *
 * 这里只保留「会改变迷宫结构与手感」的参数。星星数量刻意不在此列：
 * 它对所有难度档位生效，单独放在上方的 renderStarsField 里。
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
      key: 'cols',
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
      key: 'rows',
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
      key: 'branchiness',
      label: '岔路数量',
      min: 0,
      max: 100,
      step: 5,
      value: Math.round(snapshot.branchiness * 100),
      display: (v) => (v <= 0 ? '0（一条路走到底）' : v >= 85 ? `${v}（到处是岔路）` : `${v}`),
      // 与下面「环路数量」方向完全相反，必须分别写清楚，否则家长一定调反
      hint: '数值越大越难：岔路多、要做的选择多。想让孩子轻松点就往左调。',
      onInput: (v) => emit({ branchiness: v / 100 }),
    }),
    sliderField({
      key: 'braid',
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
      key: 'footprintFadeSec',
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
    toggleField({
      label: '卡住时给提示箭头',
      checked: snapshot.hintDelayMs !== null,
      hint: '开启后，长时间没有进展会显示指路箭头，避免孩子卡住失去兴趣。',
      onInput: (v) => emit({ hintDelayMs: v ? 20_000 : null }),
    }),
    // ── 附加机制 ──
    // 上面这些参数（尺寸/岔路/环路）在「挑战」档已经全部顶到上限，
    // 再想加难度只能靠下面这四项。它们各自独立，可以只开一项。
    toggleField({
      label: '只看清附近几格（视野迷雾）',
      checked: snapshot.viewRadius !== null,
      hint: '开启后只看得见小球附近沿走廊能走到的地方，没去过的区域是黑的。这是提升难度最有效的一项。',
      onInput: (v) => emit({ viewRadius: v ? 4 : null }),
    }),
    sliderField({
      key: 'viewRadius',
      label: '能看清的格数',
      min: LIMITS.minViewRadius,
      max: LIMITS.maxViewRadius,
      step: 1,
      value: snapshot.viewRadius ?? 4,
      display: (v) => `${v} 格`,
      hint: '数值越小越难，走岔路与拐角都看不见。只有开启「视野迷雾」时有效。',
      onInput: (v) => emit({ viewRadius: v }),
    }),
    sliderField({
      key: 'fakeExits',
      label: '假出口数量',
      min: 0,
      max: LIMITS.maxFakeExits,
      step: 1,
      value: snapshot.fakeExits,
      display: (v) => (v === 0 ? '没有假出口' : `${v} 个`),
      hint: '多放几个长得一模一样的假门，走到跟前才发现过不去。误判要花掉时间，但不会受罚。',
      onInput: (v) => emit({ fakeExits: v }),
    }),
    sliderField({
      key: 'guards',
      label: '巡逻怪数量',
      min: 0,
      max: LIMITS.maxGuards,
      step: 1,
      value: snapshot.guards,
      display: (v) => (v === 0 ? '没有巡逻怪' : `${v} 只`),
      hint: '怪会沿固定路线来回走，碰到就被送回起点（星星不会丢）。路线是固定的，看两次就能算准时机。',
      onInput: (v) => emit({ guards: v }),
    }),
    toggleField({
      label: '限时通关（超时就要重来）',
      checked: snapshot.timeLimitSec !== null,
      hint: '开启后倒计时归零即失败。这是唯一会「输」的机制，让走错路真正有代价，建议只在挑战/大师难度下使用。',
      // 打开限时时顺带把「计时」也打开，否则 HUD 会显示「--:--」而下面却在倒计时
      onInput: (v) => emit(v ? { timeLimitSec: 300, timed: true } : { timeLimitSec: null }),
    }),
    sliderField({
      key: 'timeLimitSec',
      label: '限时时长',
      min: LIMITS.minTimeLimitSec,
      max: LIMITS.maxTimeLimitSec,
      step: 30,
      value: snapshot.timeLimitSec ?? 300,
      display: (v) => formatTime(v),
      hint: '只有开启「限时通关」时有效。24×24 大迷宫沿正路走完约 2 分钟，留 4-5 分钟比较合适。',
      onInput: (v) => emit({ timeLimitSec: v }),
    }),
  );
}

interface SliderFieldOptions {
  label: string;
  /**
   * 稳定的字段名，渲染成 data-field。
   *
   * 自动化验收脚本以前用 `input[type=range]` 的**位置**来取滑块
   * （nth(0)=宽度、nth(1)=高度…）。本次新增「岔路数量」滑块后位置全部后移，
   * 脚本会静默地改错控件。用名字定位后，以后再加滑块也不会误伤。
   */
  key: string;
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
  field.dataset['field'] = opts.key;

  const id = `f-${Math.random().toString(36).slice(2, 9)}`;
  const label = document.createElement('label');
  label.htmlFor = id;
  label.textContent = opts.label;

  const output = document.createElement('output');
  output.textContent = opts.display(opts.value);

  const input = document.createElement('input');
  input.type = 'range';
  input.id = id;
  input.dataset['field'] = opts.key;
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

export interface ShapeFieldOptions {
  /** 家长指定的形状；null = 跟随难度档位自带的形状 */
  value: ShapeId | null;
  /** value 为 null 时实际生效的形状（当前选中档位自带的） */
  fallback: ShapeId;
  onInput: (v: ShapeId | null) => void;
}

/**
 * 形状选择器：单独一行，位于难度列表之上。
 *
 * 刻意不放在「家长自定义」面板里 —— 那里会让人以为形状只影响自定义档位，
 * 而实际上它与难度正交：选定后所有档位都用这个形状。
 *
 * 用一排可点的按钮而不是 <select>：形状是「看得见」的东西，
 * 平板上点一下就能立刻在下面的难度卡片上看到文字变化，
 * 比下拉菜单直观得多；而且 5 个按钮一排刚好放得下。
 */
export function renderShapeField(container: HTMLElement, opts: ShapeFieldOptions): void {
  container.replaceChildren();

  const field = document.createElement('div');
  field.className = 'field field-wide';
  field.dataset['field'] = 'shape';

  const label = document.createElement('span');
  label.className = 'field-label';
  label.textContent = '迷宫形状';

  const group = document.createElement('div');
  group.className = 'shape-group';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', '迷宫形状');

  const hint = document.createElement('p');
  hint.className = 'field-hint';

  /** 「跟随难度」时也能一键回到各档位自己的默认形状。 */
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'link-btn';
  reset.dataset['role'] = 'shape-reset';
  reset.textContent = '恢复各难度的默认形状';

  const sync = (current: ShapeId | null) => {
    const shown = current ?? opts.fallback;
    for (const btn of group.querySelectorAll<HTMLElement>('.shape-btn')) {
      btn.setAttribute('aria-pressed', btn.dataset['shape'] === shown ? 'true' : 'false');
    }
    const scope =
      current === null
        ? `现在跟随难度档位（当前档位是${SHAPE_LABELS[opts.fallback]}）；点任意一个形状，之后所有难度都用它。`
        : `所有难度都用它，不再跟随档位。`;
    hint.textContent = `${SHAPE_HINTS[shown]}${scope}`;
    reset.hidden = current === null;
  };

  for (const id of SHAPE_IDS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'shape-btn';
    button.dataset['shape'] = id;
    button.textContent = SHAPE_LABELS[id];
    button.addEventListener('click', () => {
      // 只切高亮、只改说明文字，不重建整行：重建会丢掉滚动位置，也会打断后续操作
      sync(id);
      opts.onInput(id);
    });
    group.append(button);
  }

  reset.addEventListener('click', () => {
    sync(null);
    opts.onInput(null);
  });

  sync(opts.value);

  field.append(label, group, hint, reset);
  container.append(field);
}

export interface StarsFieldOptions {
  /** 家长指定的星星数量；null = 跟随难度档位自带的 */
  value: number | null;
  /** value 为 null 时实际生效的数量（当前选中档位自带的） */
  fallback: number;
  onInput: (v: number | null) => void;
}

/** 星星数量的显示文案，滑块与「跟随难度」复位两处共用。 */
function starsDisplay(v: number): string {
  return v === 0 ? '不要星星' : `${v} 颗`;
}

/**
 * 星星数量选择器：与形状一样单独一行、位于难度列表之上。
 *
 * 为什么不能塞进「家长自定义」面板：那里每一项都只属于「自定义」档位，
 * 而星星数量与难度正交 —— 它只是奖励，不参与迷宫结构，家长调一次就该
 * 对每一档都生效。早前把它放在自定义面板里，家长在「入门」（默认选中）下
 * 把星星拉到 6 颗再开局，开局依然是 0 颗 —— 这正是「设置后没有生效」的根因。
 */
export function renderStarsField(container: HTMLElement, opts: StarsFieldOptions): void {
  container.replaceChildren();

  /** 「跟随档位」时也能一键回到各档位自带的星星数量。 */
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'link-btn';
  reset.dataset['role'] = 'stars-reset';
  reset.textContent = '跟随各难度的默认数量';

  // 「跟随档位」与「家长定死」两种状态必须说清楚，否则家长看到滑块停在
  // 某个数字上，无法判断那是自己设的还是跟着档位来的。
  const rule = '约三分之一的星星藏在死路尽头当诱饵（专门引人走错路），其余摆在必经之路上。星星只是奖励，不收集也能通关。';
  const hintFor = (value: number | null) =>
    value === null
      ? `${rule}现在跟随难度档位（当前档位是${starsDisplay(opts.fallback)}）；拖动滑块后，所有难度都用这个数量。`
      : `${rule}所有难度都用这个数量，不再跟随档位。`;

  const sync = (value: number | null) => {
    reset.hidden = value === null;
    if (hint) hint.textContent = hintFor(value);
  };

  const field = sliderField({
    key: 'stars',
    label: '星星数量',
    min: LIMITS.minStars,
    max: LIMITS.maxStars,
    step: 1,
    value: opts.value ?? opts.fallback,
    display: starsDisplay,
    hint: hintFor(opts.value),
    onInput: (v) => {
      // 拖动即视为「不再跟随档位」，复位按钮与说明文字随之切换
      sync(v);
      opts.onInput(v);
    },
  });

  const hint = field.querySelector<HTMLElement>('.field-hint');
  const range = field.querySelector<HTMLInputElement>('input[type="range"]');
  const output = field.querySelector<HTMLOutputElement>('output');

  reset.addEventListener('click', () => {
    sync(null);
    if (range) range.value = String(opts.fallback);
    if (output) output.textContent = starsDisplay(opts.fallback);
    opts.onInput(null);
  });

  sync(opts.value);
  field.append(reset);
  container.append(field);
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
 * 失败页（限时耗尽）。
 *
 * 与结算页刻意分开而不是复用：一页上同时写「走出迷宫啦」和「时间到」必然是
 * 自相矛盾的。这里的三件事必须说清 —— 为什么输、收获还是你的、下一步做什么。
 */
export interface LosePanelData {
  timeLimit: number;
  stars: number;
  totalStars: number;
  foundFakeExits: number;
  explored: number;
  mazeCells: number;
}

export function renderLosePanel(
  titleEl: HTMLElement,
  leadEl: HTMLElement,
  statsEl: HTMLElement,
  data: LosePanelData,
): void {
  titleEl.textContent = '时间到啦';
  leadEl.textContent =
    `这一局限时 ${formatTime(data.timeLimit)}。` +
    '「再试一次」还是同一张地图，刚才记住的路和怪的走法都还算数。';

  const rows: [string, string][] = [['已经探索', `${data.explored} / ${data.mazeCells} 格`]];
  // 没吃到星星就别写「已保留 0 颗」——一行没有信息量的文案只会让人以为出了 bug
  if (data.stars > 0) rows.push(['星星', `${data.stars} / ${data.totalStars}（已保留）`]);
  if (data.foundFakeExits > 0) rows.push(['识破假门', `${data.foundFakeExits} 个`]);
  rows.push(['小提示', '先在起点附近记熟几条岔路，比一路猛冲快得多']);

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
