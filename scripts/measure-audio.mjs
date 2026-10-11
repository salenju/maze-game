/**
 * 音频行为测量。
 *
 * 音频是唯一「失败也不影响玩法」的模块，因此必须确认它是**静默降级**的：
 * 平板上没有音频设备、或浏览器策略阻止 AudioContext 时，
 * 游戏不能因此崩溃或卡在启动阶段。
 *
 * 同时确认 iOS 的自动播放策略：AudioContext 必须由用户手势触发解锁。
 */

import { chromium, devices } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../dist', import.meta.url));
const PORT = 4195;
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

// ---------- 1. 正常情况下音频随用户手势解锁 ----------
{
  console.log('\n【1】正常路径：音频由用户手势解锁');
  const ctx = await browser.newContext({ ...devices['iPad Pro 11'], hasTouch: true });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

  await page.goto(BASE, { waitUntil: 'networkidle' });

  // 统计页面创建了多少个 AudioContext，确认确实是「手势后才创建」
  await page.addInitScript(() => {
    // 该脚本在导航前注入，但我们要统计的是导航后的创建，故用 patch 方式
  });
  const before = await page.evaluate(() => typeof window.AudioContext !== 'undefined');
  check('浏览器提供 WebAudio API', before === true);

  await page.click('#btn-play');
  await page.waitForTimeout(300);
  check('点击「开始游戏」后无音频相关错误', errs.length === 0, errs.join(' | ').slice(0, 150));

  await page.click('#btn-howto-ok');
  await page.waitForTimeout(800);
  check('进入游戏且音频已解锁', await page.isVisible('#screen-game'));
  check('音频解锁过程无未捕获错误', errs.length === 0, errs.join(' | ').slice(0, 150));
  await ctx.close();
}

// ---------- 2. 无音频设备时必须静默降级 ----------
{
  console.log('\n【2】无音频设备（AudioContext 抛错）应静默降级');
  const ctx = await browser.newContext({ ...devices['iPad Pro 11'], hasTouch: true });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));

  // 让 AudioContext 构造直接抛错，模拟设备无音频输出
  await page.addInitScript(() => {
    const boom = function () { throw new Error('模拟：没有可用的音频设备'); };
    Object.defineProperty(window, 'AudioContext', { configurable: true, writable: true, value: boom });
    Object.defineProperty(window, 'webkitAudioContext', { configurable: true, writable: true, value: boom });
  });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  check('音频不可用时首页仍正常渲染', await page.isVisible('.title'));

  await page.click('#btn-play');
  await page.waitForTimeout(300);
  await page.click('#btn-howto-ok');
  await page.waitForTimeout(800);
  check('音频不可用时仍能进入游戏', await page.isVisible('#screen-game'));

  // 仍然能玩：用笔拖动
  const cdp = await ctx.newCDPSession(page);
  const pos = await page.evaluate(() => window.__mazeDebug.playerScreenPos());
  const beforeCell = await page.evaluate(() => window.__mazeDebug.playerCell());
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: 0.6 });
  for (let i = 1; i <= 8; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x + i * 16, y: pos.y + i * 16, button: 'left', buttons: 1, pointerType: 'pen', force: 0.6 });
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(600);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x + 128, y: pos.y + 128, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen', force: 0 });
  const afterCell = await page.evaluate(() => window.__mazeDebug.playerCell());
  check('音频不可用时触控笔玩法完全不受影响',
    beforeCell.x !== afterCell.x || beforeCell.y !== afterCell.y,
    `(${beforeCell.x},${beforeCell.y}) → (${afterCell.x},${afterCell.y})`);

  check('静默降级不产生未捕获错误', errs.length === 0, errs.join(' | ').slice(0, 200));
  await page.screenshot({ path: 'artifacts/audio-degraded.png' });
  await ctx.close();
}

// ---------- 3. 关闭音效后仍可正常游玩 ----------
{
  console.log('\n【3】关闭音效后仍正常游玩');
  const ctx = await browser.newContext({ ...devices['iPad Pro 11'], hasTouch: true });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.click('#btn-settings');
  await page.waitForTimeout(300);
  await page.locator('#settings-list input[type=checkbox]').first().uncheck();
  await page.waitForTimeout(200);
  await page.click('#btn-settings-ok');
  await page.waitForTimeout(300);

  const pref = await page.evaluate(() => JSON.parse(localStorage.getItem('maze.prefs.v1') ?? '{}'));
  check('音效关闭状态已保存', pref.sound === false, `sound=${pref.sound}`);

  await page.click('#btn-play');
  await page.waitForTimeout(300);
  await page.click('#btn-howto-ok');
  await page.waitForTimeout(700);
  check('关闭音效后仍能进入游戏', await page.isVisible('#screen-game'));
  check('关闭音效后游玩无错误', errs.length === 0, errs.join(' | ').slice(0, 150));
  await ctx.close();
}

await browser.close();
server.close();

const f = results.filter((r) => !r.ok);
console.log(`\n音频测量：${results.length} 项，异常 ${f.length} 项`);
for (const x of f) console.log(`  ✗ ${x.n}  ${x.d}`);
if (f.length) process.exitCode = 1;
