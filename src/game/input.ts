/**
 * 指针输入层：统一处理触控笔、手指、鼠标。
 *
 * 设计要点（每一条都对应一个真实会踩的坑）：
 *
 * 1. 只监听 Pointer Events。Apple Pencil 与 S Pen 在浏览器里就是 pointerType==='pen'，
 *    不需要任何特殊 API、权限或原生插件。
 * 2. 掌拒：一旦笔处于按下状态，忽略所有 touch 事件。孩子写字时手掌必然压屏，
 *    不处理就会出现「笔和手掌抢控制权」的抖动。
 * 3. setPointerCapture：笔尖滑出画布再滑回来时，事件不会丢，
 *    否则拖动到屏幕边缘就会「断线」。
 * 4. getCoalescedEvents 只在 Chromium 系可用，Safari 不支持。
 *    存在则取回被合并的高频采样点，让轨迹更贴手；不存在就退化为单点，功能不受影响。
 * 5. 所有事件 preventDefault，配合 CSS 的 touch-action:none，
 *    消除长按选中、双击缩放、拖动橡皮筋回弹 —— 这是「拖动没反应」的头号真凶。
 */

export interface PointerSample {
  /** 画布内 CSS 像素坐标 */
  x: number;
  y: number;
  /** 0..1，手指/鼠标恒为 0.5 或 0 */
  pressure: number;
  pointerType: 'pen' | 'touch' | 'mouse';
  /** 是否来自合并事件，用于调试高采样率是否生效 */
  coalesced: boolean;
}

export interface InputHandlers {
  onStart(sample: PointerSample): void;
  onMove(samples: PointerSample[]): void;
  onEnd(): void;
}

export class PointerInput {
  private readonly canvas: HTMLCanvasElement;
  private readonly handlers: InputHandlers;
  private activeId: number | null = null;
  private penActive = false;
  private detached = false;

  constructor(canvas: HTMLCanvasElement, handlers: InputHandlers) {
    this.canvas = canvas;
    this.handlers = handlers;

    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    canvas.addEventListener('lostpointercapture', this.onUp);

    // iOS Safari 的双指缩放手势不走 Pointer Events，必须单独拦
    canvas.addEventListener('gesturestart', prevent);
    canvas.addEventListener('gesturechange', prevent);
    canvas.addEventListener('gestureend', prevent);
    // 兜底：阻止长按弹出「拷贝/查询」菜单
    canvas.addEventListener('contextmenu', prevent);
  }

  get isPenDown(): boolean {
    return this.penActive;
  }

  destroy(): void {
    if (this.detached) return;
    this.detached = true;
    const c = this.canvas;
    c.removeEventListener('pointerdown', this.onDown);
    c.removeEventListener('pointermove', this.onMove);
    c.removeEventListener('pointerup', this.onUp);
    c.removeEventListener('pointercancel', this.onUp);
    c.removeEventListener('lostpointercapture', this.onUp);
    c.removeEventListener('gesturestart', prevent);
    c.removeEventListener('gesturechange', prevent);
    c.removeEventListener('gestureend', prevent);
    c.removeEventListener('contextmenu', prevent);
  }

  private toSample(e: PointerEvent, coalesced = false): PointerSample {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      // 手指与鼠标的 pressure 在按下时为 0.5，未按下为 0；统一到 0..1 区间
      pressure: e.pressure > 0 ? e.pressure : 0.5,
      pointerType: (e.pointerType as PointerSample['pointerType']) ?? 'touch',
      coalesced,
    };
  }

  private onDown = (e: PointerEvent): void => {
    e.preventDefault();

    // 笔优先：笔按下后，touch 一律视为掌拒
    if (e.pointerType === 'pen') {
      this.penActive = true;
    } else if (e.pointerType === 'touch' && this.penActive) {
      return;
    }

    // 已有活动指针时不抢夺（例如两根手指同时落下，只认第一根）
    if (this.activeId !== null) return;

    this.activeId = e.pointerId;
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // 某些旧内核不支持捕获；丢失捕获只影响边缘拖拽，不影响主流程
    }
    this.handlers.onStart(this.toSample(e));
  };

  private onMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.activeId) return;
    e.preventDefault();

    // 合并事件可拿到被浏览器压缩掉的高频采样点（仅 Chromium 系）。
    // 对迷宫玩法而言，即使拿不到也不影响判定，只会让轨迹略显折线。
    const samples: PointerSample[] = [];
    const withCoalesced = e as PointerEvent & {
      getCoalescedEvents?: () => PointerEvent[];
    };
    if (typeof withCoalesced.getCoalescedEvents === 'function') {
      try {
        for (const ce of withCoalesced.getCoalescedEvents()) {
          samples.push(this.toSample(ce, true));
        }
      } catch {
        // Safari 曾有实现缺陷会抛错，忽略并退回单点
      }
    }
    // 无论是否有合并事件，当前事件本身都必须处理
    samples.push(this.toSample(e));

    this.handlers.onMove(samples);
  };

  private onUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.activeId) return;
    if (e.pointerType === 'pen') this.penActive = false;
    this.activeId = null;
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      // 忽略：未持有捕获时释放会抛错，无实际影响
    }
    this.handlers.onEnd();
  };
}

function prevent(e: Event): void {
  e.preventDefault();
}

/**
 * 全局禁用手势缩放与滚动回弹。
 * 必须在 body/html 上做，只在 canvas 上做无法阻止整页缩放。
 */
export function lockViewport(): void {
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, prevent, { passive: false });
  }
  // 双指/多指触摸缩放（iOS 与部分安卓内核）
  document.addEventListener(
    'touchmove',
    (e: TouchEvent) => {
      if (e.touches.length > 1) e.preventDefault();
    },
    { passive: false },
  );
  // 双击缩放
  let lastTouch = 0;
  document.addEventListener(
    'touchend',
    (e: TouchEvent) => {
      const now = Date.now();
      if (now - lastTouch <= 300) e.preventDefault();
      lastTouch = now;
    },
    { passive: false },
  );
}
