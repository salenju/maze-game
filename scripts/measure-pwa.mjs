/**
 * PWA 安装条件测量。
 *
 * 仅「manifest 能返回 200」不足以证明可安装。
 * 浏览器对安装有一组硬性门槛，任一条不满足就不会出现安装入口：
 *   - manifest 含 name / short_name / start_url / display:standalone
 *   - 至少一个 192px 与一个 512px 图标，且图标必须真的能加载
 *   - 已注册 Service Worker 且处于 active 状态
 *   - 页面通过 HTTPS 提供（本地等价于 localhost）
 * 这些条件在平板上出问题时极难排查，因此在此逐条断言。
 */

import { chromium, devices } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../dist', import.meta.url));
const PORT = 4197;
const BASE = `http://127.0.0.1:${PORT}/maze-game/`;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml',
};
const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://l');
    let p = decodeURIComponent(u.pathname);
    if (p === '/maze-game' || p === '/maze-game/') p = '/maze-game/index.html';
    const f = join(ROOT, normalize(p).replace(/^\/?maze-game\//, ''));
    await stat(f);
    const b = await readFile(f);
    res.writeHead(200, { 'Content-Type': MIME[extname(f)] ?? 'application/octet-stream' });
    res.end(b);
  } catch { res.writeHead(404).end('x'); }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch();
const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`${ok ? '  ✓' : '  ✗'} ${n}${d ? `  — ${d}` : ''}`); };

const ctx = await browser.newContext({ ...devices['iPad Pro 11'], hasTouch: true });
const page = await ctx.newPage();
await page.goto(BASE, { waitUntil: 'networkidle' });

/*
 * 关键：不要用固定 sleep 等 Service Worker。
 * 首次访问时 SW 需要下载+安装+激活，耗时不确定；
 * 固定等待会随机地采到「还没激活」的中间态，把正常实现误判为缺陷
 * （这个误判真实发生过：线上检查曾报 active=false、缓存只有 7 项）。
 * 正确做法是 await navigator.serviceWorker.ready，并轮询缓存直到装满。
 */
await page.evaluate(async () => {
  await Promise.race([
    navigator.serviceWorker.ready,
    new Promise((_, reject) => setTimeout(() => reject(new Error('SW ready 超时')), 20000)),
  ]);
});
await page.waitForFunction(async () => {
  const names = await caches.keys();
  let n = 0;
  for (const name of names) {
    const c = await caches.open(name);
    n += (await c.keys()).length;
  }
  return n >= 10;
}, null, { timeout: 20000 });

const mf = await page.evaluate(async () => (await fetch('/maze-game/manifest.webmanifest')).json());

// --- manifest 必需字段 ---
check('manifest 含 name', typeof mf.name === 'string' && mf.name.length > 0, mf.name);
check('manifest 含 short_name', typeof mf.short_name === 'string' && mf.short_name.length > 0, mf.short_name);
check('display 为 standalone', mf.display === 'standalone', mf.display);
check('start_url 指向子路径', mf.start_url === '/maze-game/', mf.start_url);
check('scope 与子路径一致', mf.scope === '/maze-game/', mf.scope);
check('含 theme_color', typeof mf.theme_color === 'string', mf.theme_color);

// --- 图标尺寸齐全 ---
const sizes = (mf.icons ?? []).map((i) => i.sizes);
check('含 192x192 图标', sizes.includes('192x192'), sizes.join(','));
check('含 512x512 图标', sizes.includes('512x512'));
check('含 maskable 图标（安卓裁切用）',
  (mf.icons ?? []).some((i) => (i.purpose ?? '').includes('maskable')));

// --- 图标必须真的能加载（路径写错时 manifest 仍合法但装不上） ---
const iconOk = await page.evaluate(async () => {
  const m = await (await fetch('/maze-game/manifest.webmanifest')).json();
  const out = [];
  for (const i of m.icons) {
    const r = await fetch('/maze-game/' + i.src.replace(/^\//, ''));
    out.push({ src: i.src, ok: r.ok, status: r.status, type: r.headers.get('content-type') });
  }
  return out;
});
check('所有图标均可实际加载', iconOk.every((i) => i.ok),
  iconOk.map((i) => `${i.src}:${i.status}`).join(' '));

// --- apple-touch-icon（iOS 必需，且必须是 180x180） ---
const appleIcon = await page.evaluate(async () => {
  const link = document.querySelector('link[rel="apple-touch-icon"]');
  if (!link) return null;
  const r = await fetch(link.getAttribute('href'));
  return { href: link.getAttribute('href'), ok: r.ok, status: r.status };
});
check('iOS apple-touch-icon 存在且可加载', appleIcon?.ok === true, JSON.stringify(appleIcon));

// --- iOS 专属 meta ---
const iosMeta = await page.evaluate(() => ({
  capable: document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.content ?? null,
  status: document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.content ?? null,
  title: document.querySelector('meta[name="apple-mobile-web-app-title"]')?.content ?? null,
}));
check('apple-mobile-web-app-capable = yes', iosMeta.capable === 'yes', String(iosMeta.capable));
check('设置了 iOS 状态栏样式', iosMeta.status === 'black-translucent', String(iosMeta.status));
check('设置了 iOS 主屏名称', !!iosMeta.title, String(iosMeta.title));

// --- Service Worker 必须 active（否则不满足可安装条件） ---
const swState = await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? { active: !!reg.active, scope: reg.scope, state: reg.active?.state ?? null } : null;
});
check('Service Worker 已注册且 scope 正确',
  swState?.active === true && swState.scope.includes('/maze-game/'),
  JSON.stringify(swState));

// --- 预缓存内容完整（离线可玩的前提） ---
const cacheNames = await page.evaluate(() => caches.keys());
check('已创建缓存', cacheNames.length > 0, cacheNames.join(','));
const cachedCount = await page.evaluate(async () => {
  const names = await caches.keys();
  let n = 0;
  for (const name of names) {
    const c = await caches.open(name);
    n += (await c.keys()).length;
  }
  return n;
});
check('预缓存了完整的 app shell（≥10 项）', cachedCount >= 10, `${cachedCount} 项`);

await ctx.close();
await browser.close();
server.close();

const f = results.filter((r) => !r.ok);
console.log(`\nPWA 安装条件：${results.length} 项，异常 ${f.length} 项`);
for (const x of f) console.log(`  ✗ ${x.n}  ${x.d}`);
if (f.length) process.exitCode = 1;
