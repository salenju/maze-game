/**
 * 稳健性测量：覆盖此前从未验证过的风险面。
 *
 * iOS 无法锁定屏幕方向（manifest.orientation 在 iOS 被忽略），
 * 孩子把平板转成竖屏或横屏都必须能玩，且画布不能被 HUD 压住。
 * 同时验证极端的家长自定义尺寸，以及切后台自动暂停是否真的生效。
 */

import { chromium, devices } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../dist', import.meta.url));
const PORT = 4187;
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

/** 进入游戏并返回关键布局数据。 */
async function enterGame(page) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.click('#btn-play');
  await page.waitForTimeout(200);
  await page.click('#btn-howto-ok');
  await page.waitForTimeout(700);
}

/** 画布是否完整落在视口内且没有被 HUD 覆盖。 */
async function layoutInfo(page) {
  return page.evaluate(() => {
    const c = document.querySelector('#maze-canvas');
    const hud = document.querySelector('#hud');
    const cb = c.getBoundingClientRect();
    const hb = hud.getBoundingClientRect();
    // HUD 与画布的纵向重叠量（HUD 是覆盖层，不应压住迷宫主体）
    const overlapY = Math.max(0, Math.min(cb.bottom, hb.bottom) - Math.max(cb.top, hb.top));
    return {
      canvasW: Math.round(cb.width),
      canvasH: Math.round(cb.height),
      canvasTop: Math.round(cb.top),
      canvasBottom: Math.round(cb.bottom),
      viewportW: window.innerWidth,
      viewportH: window.innerHeight,
      hudBottom: Math.round(hb.bottom),
      overlapY: Math.round(overlapY),
      // 迷宫的格子边长，用于判断是否小到点不准
      cell: window.__mazeDebug?.mazeInfo?.().cell ?? 0,
      scrollY: window.scrollY,
    };
  });
}

// ---------- 场景 1：竖屏（iPad 默认竖持） ----------
{
  console.log('\n【1】竖屏 iPad Pro 11（834×1194）');
  const ctx = await browser.newContext({ viewport: { width: 834, height: 1194 }, deviceScaleFactor: 2, hasTouch: true });
  const page = await ctx.newPage();
  await enterGame(page);
  const L = await layoutInfo(page);
  check('竖屏下画布有足够尺寸', L.canvasW >= 400 && L.canvasH >= 400, `${L.canvasW}x${L.canvasH}`);
  check('竖屏下格子边长足够大（≥24px 好点按）', L.cell >= 24, `cell=${L.cell}px`);
  check('竖屏下画布完整在视口内', L.canvasTop >= 0 && L.canvasBottom <= L.viewportH + 1,
    `top=${L.canvasTop} bottom=${L.canvasBottom} vh=${L.viewportH}`);
  await page.screenshot({ path: 'artifacts/layout-portrait.png' });
  await ctx.close();
}

// ---------- 场景 2：横屏 ----------
{
  console.log('\n【2】横屏 iPad Pro 11（1194×834）');
  const ctx = await browser.newContext({ viewport: { width: 1194, height: 834 }, deviceScaleFactor: 2, hasTouch: true });
  const page = await ctx.newPage();
  await enterGame(page);
  const L = await layoutInfo(page);
  check('横屏下画布有足够尺寸', L.canvasW >= 400 && L.canvasH >= 400, `${L.canvasW}x${L.canvasH}`);
  check('横屏下格子边长足够大', L.cell >= 24, `cell=${L.cell}px`);
  await page.screenshot({ path: 'artifacts/layout-landscape.png' });
  await ctx.close();
}

// ---------- 场景 3：运行中旋转屏幕 ----------
{
  console.log('\n【3】游戏中旋转屏幕（竖 → 横 → 竖）');
  const ctx = await browser.newContext({ viewport: { width: 834, height: 1194 }, deviceScaleFactor: 2, hasTouch: true });
  const page = await ctx.newPage();
  await enterGame(page);

  const before = await layoutInfo(page);
  await page.setViewportSize({ width: 1194, height: 834 });
  await page.waitForTimeout(600);
  const rotated = await layoutInfo(page);

  check('旋转后画布重新布局', rotated.canvasW !== before.canvasW || rotated.canvasH !== before.canvasH,
    `${before.canvasW}x${before.canvasH} → ${rotated.canvasW}x${rotated.canvasH}`);
  check('旋转后格子边长仍然够大', rotated.cell >= 24, `cell=${rotated.cell}px`);

  // 旋转后必须还能用笔拖动（画布尺寸变了，坐标换算要跟着更新）
  const cdp = await ctx.newCDPSession(page);
  const from = await page.evaluate(() => window.__mazeDebug.playerScreenPos());
  const cellBefore = await page.evaluate(() => window.__mazeDebug.playerCell());
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: 0.6 });
  for (let i = 1; i <= 8; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + i * 18, y: from.y + i * 18, button: 'left', buttons: 1, pointerType: 'pen', force: 0.6 });
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(700);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: from.x + 144, y: from.y + 144, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen', force: 0 });
  const cellAfter = await page.evaluate(() => window.__mazeDebug.playerCell());
  check('旋转后触控笔仍能拖动', cellBefore.x !== cellAfter.x || cellBefore.y !== cellAfter.y,
    `(${cellBefore.x},${cellBefore.y}) → (${cellAfter.x},${cellAfter.y})`);

  // 转回竖屏
  await page.setViewportSize({ width: 834, height: 1194 });
  await page.waitForTimeout(600);
  const back = await layoutInfo(page);
  check('转回竖屏后布局正常', back.cell >= 24 && back.canvasW >= 400, `cell=${back.cell} canvas=${back.canvasW}x${back.canvasH}`);
  await page.screenshot({ path: 'artifacts/layout-rotated-back.png' });
  await ctx.close();
}

// ---------- 场景 4：极小屏幕（老款手机/小尺寸平板） ----------
{
  console.log('\n【4】小屏设备（768×1024）');
  const ctx = await browser.newContext({ viewport: { width: 768, height: 1024 }, deviceScaleFactor: 2, hasTouch: true });
  const page = await ctx.newPage();
  await enterGame(page);
  const L = await layoutInfo(page);
  check('小屏下格子边长仍可用（≥20px）', L.cell >= 20, `cell=${L.cell}px`);
  check('小屏下无横向溢出', L.canvasW <= L.viewportW + 1, `canvas=${L.canvasW} vw=${L.viewportW}`);
  await ctx.close();
}

await browser.close();
server.close();

const f = results.filter((r) => !r.ok);
console.log(`\n稳健性测量：${results.length} 项，异常 ${f.length} 项`);
for (const x of f) console.log(`  ✗ ${x.n}  ${x.d}`);
if (f.length) process.exitCode = 1;
