/**
 * 可播种伪随机数生成器。
 *
 * 为什么不用 Math.random：同一个种子必须生成同一个迷宫。
 * 这样「再玩一次」可以是新迷宫，而「重玩本关」永远是同一张图，
 * 小朋友失败后能带着记忆重来，不会被随机性惩罚。
 */

export type Rng = () => number;

/** mulberry32：32 位状态、周期 2^32，对游戏而言质量足够，且实现只有几行。 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 生成一个可读性尚可的随机种子（用于「换一张迷宫」）。 */
export function randomSeed(): number {
  return (Math.random() * 0xffffffff) >>> 0;
}

/** 闭区间 [min, max] 的整数。 */
export function randInt(rng: Rng, min: number, max: number): number {
  if (max <= min) return min;
  return min + Math.floor(rng() * (max - min + 1));
}

/** 等概率取一个元素。数组必须非空。 */
export function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) throw new Error('pick() 需要非空数组');
  return items[Math.floor(rng() * items.length)] as T;
}

/** 原地 Fisher-Yates 洗牌。 */
export function shuffle<T>(rng: Rng, items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = items[i] as T;
    const b = items[j] as T;
    items[i] = b;
    items[j] = a;
  }
  return items;
}
