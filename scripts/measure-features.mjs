/**
 * 玩法要素测量：星星收集与提示箭头。
 *
 * 这两项此前只做过单元测试，从未在真实浏览器里端到端验证过。
 * 尤其要确认「星星必须能真的被吃到」——若收集判定有偏差，
 * 孩子会看到星星明明碰到了却不消失，这是最典型的挫败来源。
 */

import { chromium, devices } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../dist', import.meta.url));
const PORT = 4191;
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

/** 用笔沿给定格坐标序列持续拖动（必须持续移动，否则额度用尽会停）。 */
async function dragAlong(page, cdp, cells, holdMs = 220) {
  if (cells.length === 0) return;
  const p0 = await page.evaluate((c) => window.__mazeDebug.cellToScreen(c.x, c.y), cells[0]);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: p0.x, y: p0.y, button: 'left',
    buttons: 1, clickCount: 1, pointerType: 'pen', force: 0.6,
  });
  for (let i = 1; i < cells.length; i++) {
    const p = await page.evaluate((c) => window.__mazeDebug.cellToScreen(c.x, c.y), cells[i]);
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: p.x, y: p.y, button: 'left',
      buttons: 1, pointerType: 'pen', force: 0.6,
    });
    await page.waitForTimeout(holdMs);
  }
  const last = cells[cells.length - 1];
  const pe = await page.evaluate((c) => window.__mazeDebug.cellToScreen(c.x, c.y), last);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: pe.x, y: pe.y, button: 'left',
    buttons: 0, clickCount: 1, pointerType: 'pen', force: 0,
  });
  await page.waitForTimeout(400);
}

// ---------- 1. 星星收集 ----------
{
  console.log('\n【1】星星收集（中等难度，3 颗星）');
  const ctx = await browser.newContext({ ...devices['iPad Pro 11'], hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.click('#btn-difficulty');
  await page.waitForTimeout(350);
  await page.locator('.diff-item').nth(2).click(); // 中等：3 颗星
  await page.waitForTimeout(200);
  await page.click('#btn-start');
  await page.waitForTimeout(800);

  const info = await page.evaluate(() => window.__mazeDebug.mazeInfo());
  check('中等难度确实生成了星星', info.starsTotal === 3, `starsTotal=${info.starsTotal}`);

  const hudBefore = await page.textContent('#hud-stars');
  check('HUD 显示星星进度 0/3', hudBefore.includes('0/3'), hudBefore);

  // 星星摆在解路径上，沿解路径走就应吃到
  const sol = await page.evaluate(() => window.__mazeDebug.solution());
  const cdp = await ctx.newCDPSession(page);
  await dragAlong(page, cdp, sol, 200);
  await page.waitForTimeout(600);

  const collected = await page.evaluate(() => window.__mazeDebug.mazeInfo());
  // 断言已收集数上升（而不是去猜剩余数）
  check('沿解路径行走能吃到星星（不应出现碰到却不消失）',
    collected.starsCollected >= 1,
    `已收集 ${collected.starsCollected}/${collected.starsTotal} 颗`);

  const hudAfter = await page.textContent('#hud-stars');
  check('HUD 星星进度随之更新', hudAfter !== hudBefore, `${hudBefore} → ${hudAfter}`);
  check('星星场景无 JS 错误', errors.length === 0, errors.join(' | ').slice(0, 200));
  await page.screenshot({ path: 'artifacts/stars-collected.png' });
  await ctx.close();
}

// ---------- 2. 提示箭头 ----------
{
  console.log('\n【2】提示箭头（入门档 10 秒无进展后出现）');
  const ctx = await browser.newContext({ ...devices['iPad Pro 11'], hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.click('#btn-play');
  await page.waitForTimeout(200);
  await page.click('#btn-howto-ok');
  await page.waitForTimeout(600);

  const hinted0 = await page.evaluate(() => window.__mazeDebug.hintVisible());
  check('开局时不显示提示', hinted0 === false, `showHint=${hinted0}`);

  // 入门档 hintDelayMs = 10 秒，什么都不做地等待
  await page.waitForTimeout(11500);
  const hinted1 = await page.evaluate(() => window.__mazeDebug.hintVisible());
  check('10 秒无进展后自动显示提示箭头', hinted1 === true, `showHint=${hinted1}`);

  // 提示必须指向相邻且可走的一格（否则孩子照着走会撞墙）
  const next = await page.evaluate(() => window.__mazeDebug.hintNext());
  check('提示指向一个有效的下一格', next !== null, JSON.stringify(next));
  if (next) {
    const cur = await page.evaluate(() => window.__mazeDebug.playerCell());
    const dist = Math.abs(next.x - cur.x) + Math.abs(next.y - cur.y);
    check('提示的下一格与当前位置相邻', dist === 1,
      `位置(${cur.x},${cur.y}) 提示(${next.x},${next.y}) 距离=${dist}`);
  }
  await page.screenshot({ path: 'artifacts/hint-arrow.png' });
  await ctx.close();
}

// ---------- 3. 挑战档不应出现提示 ----------
{
  console.log('\n【3】挑战档不提供提示（hintDelayMs = null）');
  const ctx = await browser.newContext({ ...devices['iPad Pro 11'], hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.click('#btn-difficulty');
  await page.waitForTimeout(350);
  await page.locator('.diff-item').nth(3).click(); // 挑战
  await page.waitForTimeout(200);
  await page.click('#btn-start');
  await page.waitForTimeout(700);
  await page.waitForTimeout(11500);
  const hinted = await page.evaluate(() => window.__mazeDebug.hintVisible());
  check('挑战档等待 11 秒也不显示提示', hinted === false, `showHint=${hinted}`);
  await ctx.close();
}

await browser.close();
server.close();

const f = results.filter((r) => !r.ok);
console.log(`\n玩法要素测量：${results.length} 项，异常 ${f.length} 项`);
for (const x of f) console.log(`  ✗ ${x.n}  ${x.d}`);
if (f.length) process.exitCode = 1;
