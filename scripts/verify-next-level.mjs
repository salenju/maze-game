/**
 * 验证结算页两个按钮的语义（用户澄清后）。
 *
 * 用户澄清：「下一关」不是升难度，而是在同一难度下重新生成一张地图。
 * 因此两个按钮必须明确区分：
 *   换个新迷宫   → 同一难度，新地图（墙布局变化，难度参数不变）
 *   再走一遍这张 → 同一难度，同一张地图（墙布局完全一致）
 *
 * 早前「下一关」被实现成升难度阶梯（7x7 → 10x10 → 14x14 → 18x18），
 * 这不是用户的预期，此脚本用于锁定正确行为。
 */

import { chromium, devices } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../dist', import.meta.url));
const PORT = 4211;
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
    await page.waitForTimeout(185);
  }
  const pe = await page.evaluate(
    (c) => window.__mazeDebug.cellToScreen(c.x, c.y), sol[sol.length - 1]);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: pe.x, y: pe.y, button: 'left',
    buttons: 0, clickCount: 1, pointerType: 'pen', force: 0,
  });
  await page.waitForTimeout(900);
}

const ctx = await browser.newContext({ ...devices['iPad Pro 11'], hasTouch: true });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);

// 用「中等」难度（14x14）测试：若发生升难度，尺寸会变成 18x18，一眼可辨
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.click('#btn-difficulty');
await page.waitForTimeout(400);
await page.locator('.diff-item').nth(2).click(); // 中等
await page.waitForTimeout(250);
await page.click('#btn-start');
await page.waitForTimeout(800);

const first = await page.evaluate(() => window.__mazeDebug.mazeInfo());
console.log(`  起始：${first.cols}x${first.rows}`);

// ---- 「换个新迷宫」：同难度 + 新地图 ----
await clearMaze(page, cdp);
check('通关后进入结算页', await page.isVisible('#screen-win'));
const nextLabel = (await page.locator('#btn-next').textContent())?.trim();
check('按钮文案为「换个新迷宫」', nextLabel === '换个新迷宫', `实际=「${nextLabel}」`);
await page.screenshot({ path: 'artifacts/win-buttons.png' });

await page.click('#btn-next');
await page.waitForTimeout(900);
const afterNext = await page.evaluate(() => window.__mazeDebug.mazeInfo());
check('「换个新迷宫」保持同一难度尺寸（不升难度）',
  afterNext.cols === first.cols && afterNext.rows === first.rows,
  `${afterNext.cols}x${afterNext.rows}（期望 ${first.cols}x${first.rows}）`);

// 地图内容必须变了：比较解路径长度或墙体布局
const walls1 = await page.evaluate(() => window.__mazeDebug.wallSignature());
await clearMaze(page, cdp);
await page.click('#btn-next');
await page.waitForTimeout(900);
const walls2 = await page.evaluate(() => window.__mazeDebug.wallSignature());
check('「换个新迷宫」确实换了新地图（墙体布局不同）', walls1 !== walls2,
  `签名 ${String(walls1).slice(0, 12)}… vs ${String(walls2).slice(0, 12)}…`);

// ---- 「再走一遍这张」：同难度 + 同一张地图 ----
await clearMaze(page, cdp);
check('再次通关后进入结算页', await page.isVisible('#screen-win'));
const retryLabel = (await page.locator('#btn-retry').textContent())?.trim();
check('按钮文案为「再走一遍这张」', retryLabel === '再走一遍这张', `实际=「${retryLabel}」`);

const beforeRetry = await page.evaluate(() => window.__mazeDebug.wallSignature());
await page.click('#btn-retry');
await page.waitForTimeout(900);
const afterRetry = await page.evaluate(() => window.__mazeDebug.wallSignature());
check('「再走一遍这张」地图完全一致（同一种子）', beforeRetry === afterRetry,
  beforeRetry === afterRetry ? '墙体布局一致' : '地图被换掉了 ← 不符合预期');

const retryInfo = await page.evaluate(() => window.__mazeDebug.mazeInfo());
check('「再走一遍这张」难度尺寸不变',
  retryInfo.cols === first.cols && retryInfo.rows === first.rows,
  `${retryInfo.cols}x${retryInfo.rows}`);

// ---- 高难度档也永远能换新地图（不存在「到顶」）----
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.click('#btn-difficulty');
await page.waitForTimeout(400);
await page.locator('.diff-item').nth(3).click(); // 挑战 18x18
await page.waitForTimeout(250);
await page.click('#btn-start');
await page.waitForTimeout(800);
await clearMaze(page, cdp);
const hardNextVisible = await page.locator('#btn-next').isVisible();
check('挑战档通关后按钮仍可用（不存在到顶）', hardNextVisible);
await page.click('#btn-next');
await page.waitForTimeout(900);
const hardInfo = await page.evaluate(() => window.__mazeDebug.mazeInfo());
check('挑战档换地图后仍是 18x18（不越界、不变档）',
  hardInfo.cols === 18 && hardInfo.rows === 18, `${hardInfo.cols}x${hardInfo.rows}`);

await ctx.close();
await browser.close();
server.close();

const f = results.filter((r) => !r.ok);
console.log(`\n按钮语义验证：${results.length} 项，异常 ${f.length} 项`);
for (const x of f) console.log(`  ✗ ${x.n}  ${x.d}`);
if (f.length) process.exitCode = 1;
