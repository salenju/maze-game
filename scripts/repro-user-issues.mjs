/**
 * 复现用户报告的两个问题。
 *
 * 问题 1：通关后没有「下一关」
 *   怀疑：handleWin 里 `nextBtn.hidden = difficulty.id === PRESETS 最后一档`，
 *   而最后一档是 'hard'（挑战）。因此在挑战难度通关后按钮被隐藏 ——
 *   这恰好是最需要「继续玩」的一档。
 *   另外自定义难度（custom）不是 PRESETS 成员，行为也需确认。
 *
 * 问题 2：点击五角星会自动走过去
 *   怀疑：dragTo 一旦换格就补满 MOVE_BURST_CELLS=5 格额度，
 *   所以单次轻点（pointerdown+up 在同一格或邻近格）会让小球自行走一段，
 *   孩子只是点了一下星星，小球却自己跑过去了 —— 违背「必须一直按住带路」的设计。
 */

import { chromium, devices } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../dist', import.meta.url));
const PORT = 4201;
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

/** 用笔沿解路径带路走完迷宫（必须持续移动，否则额度用尽会停）。 */
async function clearMaze(page, cdp) {
  const sol = await page.evaluate(() => window.__mazeDebug.solution());
  const p0 = await page.evaluate((c) => window.__mazeDebug.cellToScreen(c.x, c.y), sol[0]);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: p0.x, y: p0.y, button: 'left',
    buttons: 1, clickCount: 1, pointerType: 'pen', force: 0.6,
  });
  for (let i = 1; i < sol.length; i++) {
    if (await page.isVisible('#screen-win')) break;
    const p = await page.evaluate((c) => window.__mazeDebug.cellToScreen(c.x, c.y), sol[i]);
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: p.x, y: p.y, button: 'left',
      buttons: 1, pointerType: 'pen', force: 0.6,
    });
    await page.waitForTimeout(200);
  }
  const pe = await page.evaluate(
    (c) => window.__mazeDebug.cellToScreen(c.x, c.y), sol[sol.length - 1]);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: pe.x, y: pe.y, button: 'left',
    buttons: 0, clickCount: 1, pointerType: 'pen', force: 0,
  });
  await page.waitForTimeout(900);
}

// ---------- 问题 1：各难度通关后「下一关」是否可用 ----------
{
  console.log('\n【问题 1】各难度通关后「下一关」按钮状态');
  const ctx = await browser.newContext({ ...devices['iPad Pro 11'], hasTouch: true });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);

  // 入门（starter）
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.click('#btn-play'); await page.waitForTimeout(250);
  await page.click('#btn-howto-ok'); await page.waitForTimeout(700);
  await clearMaze(page, cdp);
  check('入门通关后进入结算页', await page.isVisible('#screen-win'));
  const starterNext = await page.locator('#btn-next').isVisible();
  check('入门通关后「下一关」可见', starterNext, starterNext ? '可见' : '被隐藏 ← 问题');
  await page.screenshot({ path: 'artifacts/repro-win-starter.png' });

  // 挑战（hard）—— 怀疑这里按钮被隐藏
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.click('#btn-difficulty'); await page.waitForTimeout(400);
  await page.locator('.diff-item').nth(3).click(); // 挑战
  await page.waitForTimeout(250);
  await page.click('#btn-start'); await page.waitForTimeout(700);
  await clearMaze(page, cdp);
  const won = await page.isVisible('#screen-win');
  check('挑战通关后进入结算页', won);
  const hardNext = await page.locator('#btn-next').isVisible();
  check('挑战通关后「下一关」可见（用户报告的问题点）', hardNext,
    hardNext ? '可见' : '被隐藏 ← 复现确认');
  await page.screenshot({ path: 'artifacts/repro-win-hard.png' });

  // 自定义（custom）
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.click('#btn-difficulty'); await page.waitForTimeout(400);
  await page.locator('[data-diff-id="custom"]').click();
  await page.waitForTimeout(250);
  await page.click('#btn-start'); await page.waitForTimeout(700);
  await clearMaze(page, cdp);
  const customNext = await page.locator('#btn-next').isVisible();
  check('自定义难度通关后「下一关」可见', customNext, customNext ? '可见' : '被隐藏');

  await ctx.close();
}

// ---------- 问题 2：轻点一下不应让小球自行走一段 ----------
{
  console.log('\n【问题 2】轻点（按下即抬起）是否会让小球自行移动');
  const ctx = await browser.newContext({ ...devices['iPad Pro 11'], hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.click('#btn-play'); await page.waitForTimeout(250);
  await page.click('#btn-howto-ok'); await page.waitForTimeout(700);

  const cdp = await ctx.newCDPSession(page);
  const before = await page.evaluate(() => window.__mazeDebug.playerCell());

  // 取一个离起点较远的格子（模拟孩子随手点一下远处）
  const sol = await page.evaluate(() => window.__mazeDebug.solution());
  const far = sol[Math.min(8, sol.length - 1)];
  const p = await page.evaluate((c) => window.__mazeDebug.cellToScreen(c.x, c.y), far);

  // 单次轻点：按下后立刻抬起（模拟点击，不是拖动）
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: p.x, y: p.y, button: 'left',
    buttons: 1, clickCount: 1, pointerType: 'pen', force: 0.6,
  });
  await page.waitForTimeout(30);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: p.x, y: p.y, button: 'left',
    buttons: 0, clickCount: 1, pointerType: 'pen', force: 0,
  });

  // 静置 3 秒，观察小球是否自行前进
  await page.waitForTimeout(3000);
  const after = await page.evaluate(() => window.__mazeDebug.playerCell());
  const moved = Math.abs(after.x - before.x) + Math.abs(after.y - before.y);

  check('轻点远处后小球不应自行走远（期望 ≤1 格）', moved <= 1,
    `移动了 ${moved} 格  (${before.x},${before.y}) → (${after.x},${after.y})`);
  await page.screenshot({ path: 'artifacts/repro-tap.png' });
  await ctx.close();
}

await browser.close();
server.close();

const f = results.filter((r) => !r.ok);
console.log(`\n复现结果：${results.length} 项，问题 ${f.length} 项`);
for (const x of f) console.log(`  ✗ ${x.n}  ${x.d}`);
