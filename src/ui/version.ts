/**
 * 版本号的唯一来源与展示格式。
 *
 * 为什么需要它：这个游戏是装在平板主屏幕上的 PWA，浏览器与服务端都会缓存旧版本。
 * 不看一眼版本号，无法判断平板上跑的到底是哪一版，
 * 于是「明明修好了却还是老样子」这类问题会反复发生。
 * 首页显示版本号后，一眼就能确认是不是最新版本。
 *
 * 版本号来自 package.json，由 Vite 在构建时注入（见 vite.config.ts 的 define），
 * 刻意不在源码里手写第二份 —— 两份版本号迟早会不一致，那样这个徽标就失去了意义。
 * 也刻意不掺入构建时间：构建机（CI）与家长所在时区不同，
 * 显示出来的时间反而会让人误判新旧。
 */

/** 构建时由 Vite 注入的 package.json 版本号。 */
declare const __APP_VERSION__: string | undefined;

/** define 未生效时的兜底值，保证单测或直接跑源码时也不会崩。 */
const FALLBACK_VERSION = '0.0.0-dev';

/**
 * 当前版本号（例如 `0.2.0`）。
 *
 * 用 typeof 判断而不是直接引用：在 vitest 等没有注入 define 的环境里，
 * 裸引用 `__APP_VERSION__` 会抛 ReferenceError。
 */
export function appVersion(): string {
  const injected = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '';
  const trimmed = injected.trim();
  return trimmed === '' ? FALLBACK_VERSION : trimmed;
}

/** 首页徽标文案，例如 `v0.2.0`。 */
export function versionLabel(): string {
  return `v${appVersion()}`;
}
