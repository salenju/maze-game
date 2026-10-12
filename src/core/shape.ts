/**
 * 迷宫形状：把「哪些格子属于迷宫」抽象成一张 0/1 掩码。
 *
 * 为什么单独成模块：迷宫生成、渲染、指针取格、提示箭头全都只认这张掩码，
 * 于是「圆形 / 六边形 / 三角形 / 星形」对下游代码完全透明 ——
 * 生成算法不需要知道自己在画圆还是画星，只需要知道哪格能走。
 *
 * 形状用「极坐标半径函数」定义：
 *   把格子中心换算成以棋盘中心为原点的归一化坐标 (u,v) ∈ [-1,1]²，
 *   再把该点按形状的外接矩形放大回「外接圆半径 1」的坐标，
 *   于是只要比较 半径 与 r(θ) 就能判断内外。
 *
 * 空心（环形走廊）不用半径比例硬算，而是用「腐蚀」：
 *   把外轮廓反复向内收 k 圈，收掉的部分就是洞。
 *   这样做的好处是洞的厚度天然等于 k，环形走廊永远不会细到断成几截——
 *   而按半径比例去挖，小尺寸下必然产生只有一格宽的环，
 *   四连通会碎掉，「球走不过去」的 bug 就来了。
 */

export type ShapeId = 'square' | 'circle' | 'hexagon' | 'triangle' | 'star';

/** UI 里的排列顺序：把最像「迷宫」的方形放最后，新形状在前，引导家长去试。 */
export const SHAPE_IDS: readonly ShapeId[] = ['circle', 'hexagon', 'triangle', 'star', 'square'];

export const SHAPE_LABELS: Record<ShapeId, string> = {
  square: '方形',
  circle: '圆形',
  hexagon: '六边形',
  triangle: '三角形',
  star: '星形',
};

/** 给家长看的一句话说明。 */
export const SHAPE_HINTS: Record<ShapeId, string> = {
  circle: '圆圆的迷宫，走廊绕成一个圈，看起来最像真正的迷宫。',
  hexagon: '六边形迷宫，边和角更少，走起来方向感好一点。',
  triangle: '三角形迷宫，越往尖角越窄，适合已经玩熟的孩子。',
  star: '五角星迷宫，五个尖角都是长走廊，最容易迷路。',
  square: '经典方形迷宫，和以前一样。',
};

/** 哪些形状把中心挖空成环形走廊。星形不挖：它的尖角本身就是走廊，挖了就没形了。 */
const HOLLOW_SHAPES: Record<ShapeId, boolean> = {
  square: false,
  circle: true,
  hexagon: true,
  triangle: true,
  star: false,
};

const TAU = Math.PI * 2;
/** 采样角度数：只用于求形状的外接矩形，720 段已经细分到肉眼无差。 */
const SAMPLES = 720;

export function isShapeId(value: unknown): value is ShapeId {
  return typeof value === 'string' && (SHAPE_IDS as readonly string[]).includes(value);
}

/**
 * 正 n 边形（外接圆半径 1）在极角 theta 处的边界半径。
 *
 * 凸多边形是若干半平面的交：{p : p·n_j ≤ 内切半径}，n_j 是第 j 条边的外法线。
 * 于是射线上的边界点满足 r·max_j cos(θ-ψ_j) = 内切半径。
 */
function polygonRadius(theta: number, n: number, rotation: number): number {
  const apothem = Math.cos(Math.PI / n);
  let best = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    const psi = rotation + Math.PI / n + (TAU * i) / n;
    best = Math.max(best, Math.cos(theta - psi));
  }
  // 凸多边形必然包含原点，best 恒 ≥ cos(π/n) > 0，这里只是防御除零
  return best > 1e-9 ? apothem / best : 0;
}

/**
 * 五角星在极角 theta 处的边界半径。
 * 10 个顶点（外/内交替）之间按极角线性插值：不是严格的直线边，
 * 但在格子分辨率下看不出差别，而且保证形状对原点星形（射线只交一次）。
 */
function starRadius(theta: number, points: number, innerRatio: number, rotation: number): number {
  const step = Math.PI / points; // 顶点与内顶点交替，共 2*points 段
  const a = (((theta - rotation) % TAU) + TAU) % TAU;
  const seg = Math.floor(a / step);
  const t = a / step - seg;
  const outFirst = seg % 2 === 0;
  const r0 = outFirst ? 1 : innerRatio;
  const r1 = outFirst ? innerRatio : 1;
  return r0 + (r1 - r0) * t;
}

/** 单位圆内的边界半径函数（外接半径 1）。 */
function radiusFunction(shape: ShapeId): (theta: number) => number {
  switch (shape) {
    case 'circle':
      return () => 1;
    case 'hexagon':
      // rotation = π/2：让一个顶点朝正上方（尖顶六边形），比平顶更耐看
      return (t) => polygonRadius(t, 6, Math.PI / 2);
    case 'triangle':
      // rotation = -π/2：顶点朝上，底边在下，重心与视觉重心一致
      return (t) => polygonRadius(t, 3, -Math.PI / 2);
    case 'star':
      // 内半径 0.42 是五角星的标准美学比例附近，再小尖角会缩成刺
      return (t) => starRadius(t, 5, 0.42, -Math.PI / 2);
    case 'square':
      // 旋转 45° 的正方形：顶点落在棋盘四角，正好铺满整张网格
      return (t) => polygonRadius(t, 4, Math.PI / 4);
  }
}

interface Bounds {
  cx: number;
  cy: number;
  hx: number;
  hy: number;
}

const boundsCache = new Map<ShapeId, Bounds>();

/**
 * 形状在外接圆坐标系下的包围盒。
 *
 * 用它把形状「拉伸到正好铺满网格」：如果只按外接圆归一化，
 * 顶点朝上的三角形只会占 3/4 的高度，星形也只占 90%，四周留下大片死区，
 * 看起来就像「画歪了」。按包围盒归一化才能让每个形状都吃到整张网格。
 */
function bounds(shape: ShapeId): Bounds {
  const cached = boundsCache.get(shape);
  if (cached) return cached;

  const f = radiusFunction(shape);
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < SAMPLES; i++) {
    const theta = (TAU * i) / SAMPLES;
    const r = f(theta);
    const px = Math.cos(theta) * r;
    const py = Math.sin(theta) * r;
    minX = Math.min(minX, px);
    maxX = Math.max(maxX, px);
    minY = Math.min(minY, py);
    maxY = Math.max(maxY, py);
  }
  const hx = (maxX - minX) / 2;
  const hy = (maxY - minY) / 2;
  const result: Bounds = {
    cx: (maxX + minX) / 2,
    cy: (maxY + minY) / 2,
    hx: hx > 1e-9 ? hx : 1,
    hy: hy > 1e-9 ? hy : 1,
  };
  boundsCache.set(shape, result);
  return result;
}

/**
 * 归一化坐标 (u,v) ∈ [-1,1]² 是否落在形状内。
 * u、v 由格子中心相对棋盘中心换算而来。
 */
export function containsPoint(shape: ShapeId, u: number, v: number): boolean {
  const b = bounds(shape);
  // 把点映射回外接圆坐标系：形状被拉伸到铺满网格，判据要反向还原
  const su = b.cx + u * b.hx;
  const sv = b.cy + v * b.hy;
  const r = Math.hypot(su, sv);
  if (r < 1e-9) return true; // 棋盘正中永远是内点
  return r <= radiusFunction(shape)(Math.atan2(sv, su)) + 1e-9;
}

/** 该格中心是否在形状内（整数格坐标）。 */
export function shapeContainsCell(shape: ShapeId, cols: number, rows: number, x: number, y: number): boolean {
  const u = (x + 0.5 - cols / 2) / (cols / 2);
  const v = (y + 0.5 - rows / 2) / (rows / 2);
  return containsPoint(shape, u, v);
}

function emptyMask(cols: number, rows: number): Uint8Array {
  return new Uint8Array(cols * rows);
}

/** 形状的外轮廓掩码（不含挖空）。 */
export function buildOuterMask(shape: ShapeId, cols: number, rows: number): Uint8Array {
  const mask = emptyMask(cols, rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (shapeContainsCell(shape, cols, rows, x, y)) mask[y * cols + x] = 1;
    }
  }
  return mask;
}

export function countCells(mask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] === 1) n++;
  return n;
}

/** 四连通洪泛，返回从 seed 出发能到达的格子（seed 不在掩码内则返回空）。 */
function flood(mask: Uint8Array, cols: number, rows: number, seed: number): Uint8Array {
  const out = emptyMask(cols, rows);
  if (mask[seed] !== 1) return out;
  const stack = [seed];
  out[seed] = 1;
  while (stack.length > 0) {
    const cur = stack.pop() as number;
    const cx = cur % cols;
    const cy = (cur - cx) / cols;
    for (const [dx, dy] of ORTHO) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const ni = ny * cols + nx;
      if (mask[ni] !== 1 || out[ni] === 1) continue;
      out[ni] = 1;
      stack.push(ni);
    }
  }
  return out;
}

const ORTHO: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/**
 * 只保留最大的一块四连通区域。
 *
 * 为什么必须有这一步：形状是按解析式裁的，极端比例（比如 6×24 的星形）
 * 可能切出孤立的碎块。碎块在大图上毫无意义，还会让「所有格子连通」的
 * 不变式被打破；直接丢掉是最稳的做法。
 */
export function largestComponent(mask: Uint8Array, cols: number, rows: number): Uint8Array {
  const seen = emptyMask(cols, rows);
  let best = emptyMask(cols, rows);
  let bestSize = 0;

  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== 1 || seen[i] === 1) continue;
    const comp = flood(mask, cols, rows, i);
    let size = 0;
    for (let j = 0; j < comp.length; j++) {
      if (comp[j] === 1) {
        seen[j] = 1;
        size++;
      }
    }
    if (size > bestSize) {
      bestSize = size;
      best = comp;
    }
  }
  return best;
}

/** 四连通区域块数。形状自检用：环形走廊必须正好是一块。 */
export function componentCount(mask: Uint8Array, cols: number, rows: number): number {
  const seen = emptyMask(cols, rows);
  let count = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== 1 || seen[i] === 1) continue;
    count++;
    const comp = flood(mask, cols, rows, i);
    for (let j = 0; j < comp.length; j++) if (comp[j] === 1) seen[j] = 1;
  }
  return count;
}

/** 腐蚀一圈：去掉所有「四邻中有一个不在掩码内」的格子。 */
function erodeOnce(mask: Uint8Array, cols: number, rows: number): Uint8Array {
  const out = emptyMask(cols, rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (mask[y * cols + x] !== 1) continue;
      let solid = true;
      for (const [dx, dy] of ORTHO) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows || mask[ny * cols + nx] !== 1) {
          solid = false;
          break;
        }
      }
      if (solid) out[y * cols + x] = 1;
    }
  }
  return out;
}

/** 腐蚀 times 圈。 */
export function erode(mask: Uint8Array, cols: number, rows: number, times: number): Uint8Array {
  let cur = mask;
  for (let i = 0; i < times; i++) {
    const next = erodeOnce(cur, cols, rows);
    if (countCells(next) === 0) return next;
    cur = next;
  }
  return cur;
}

/** mask 去掉 hole。 */
function subtract(mask: Uint8Array, hole: Uint8Array): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] === 1 && hole[i] !== 1 ? 1 : 0;
  return out;
}

/** 环形走廊的最小厚度（格）。低于 2 格时四连通会碎，故有下限。 */
function ringThickness(cols: number, rows: number): number {
  return Math.min(cols, rows) >= 12 ? 3 : 2;
}

/**
 * 最终掩码：形状外轮廓，必要时挖空中心形成环形走廊。
 *
 * 安全降级（宁可不好看也不能让球走不通）：
 *   - 腐蚀后没有洞（格子太小）→ 保留实心
 *   - 挖空后环形裂成多块 → 保留实心
 *   - 环形格子太少 → 保留实心
 */
export function buildMask(shape: ShapeId, cols: number, rows: number): Uint8Array {
  const outer = largestComponent(buildOuterMask(shape, cols, rows), cols, rows);
  if (!HOLLOW_SHAPES[shape]) return outer;

  const hole = erode(outer, cols, rows, ringThickness(cols, rows));
  if (countCells(hole) === 0) return outer;

  const ring = subtract(outer, hole);
  if (componentCount(ring, cols, rows) !== 1) return outer;
  if (countCells(ring) < 12) return outer;
  return ring;
}
