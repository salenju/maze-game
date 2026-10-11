/**
 * 深入复现：难度阶梯与轻点行为。
 *
 * 1. 完整走一遍难度阶梯 starter→easy→medium→hard，看每一步「下一关」是否可用、
 *    走到最后一档后会发生什么（这是用户「没有下一关」的最可能场景）。
 * 2. 轻点问题：测不同按压时长。真机上的「点击」有 100-300ms 接触时间，
 *    而 30ms 的合成熟点击太短，测不出真实手感。
 */

import { chromium, devices } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../dist', import.meta.url));
const PORT = 4203;
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
    await page.waitForTimeout(190);
  }
  const pe = await page.evaluate(
    (c) => window.__mazeDebug.cellToScreen(c.x, c.y), sol[sol.length - 1]);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: pe.x, y: pe.y, button: 'left',
    buttons: 0, clickCount: 1, pointerType: 'pen', force: 0,
  });
  await page.waitForTimeout(900);
}

// ---------- 1. 完整难度阶梯 ----------
{
  console.log('\n【1】难度阶梯：连续点「下一关」直到走不动');
  const ctx = await browser.newContext({ ...devices['iPad Pro 11'], hasTouch: true });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.click('#btn-play'); await page.waitForTimeout(250);
  await page.click('#btn-howto-ok'); await page.waitForTimeout(700);

  const ladder = [];
  for (let step = 0; step < 6; step++) {
    await clearMaze(page, cdp);
    if (!(await page.isVisible('#screen-win'))) {
      ladder.push({ step, won: false });
      check(`第 ${step + 1} 关通关`, false, '未能通关');
      break;
    }
    const info = await page.evaluate(() => window.__mazeDebug.mazeInfo());
    const nextVisible = await page.locator('#btn-next').isVisible();
    const nextDisabled = nextVisible ? await page.locator('#btn-next').isDisabled() : true;
    ladder.push({ step, size: `${info.cols}x${info.rows}`, nextVisible, nextDisabled });
    console.log(`    第 ${step + 1} 关：迷宫 ${info.cols}x${info.rows}，下一关按钮=${nextVisible ? '可见' : '隐藏'}`);

    if (!nextVisible) {
      check(`第 ${step + 1} 关（最后一档）仍应有「下一关」`, false,
        '按钮被隐藏，孩子无法继续玩 ← 复现问题 1');
      break;
    }
    if (step < 5) {
      await page.click('#btn-next');
      await page.waitForTimeout(800);
    }
  }
  console.log('    阶梯记录：', JSON.stringify(ladder));
  await ctx.close();
}

// ---------- 2. 轻点：不同按压时长 ----------
{
  console.log('\n【2】轻点远处：按压时长对小球自行移动的影响');
  for (const holdMs of [60, 150, 300, 600]) {
    const ctx = await browser.newContext({ ...devices['iPad Pro 11'], hasTouch: true });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.click('#btn-play'); await page.waitForTimeout(250);
    await page.click('#btn-howto-ok'); await page.waitForTimeout(700);

    const cdp = await ctx.newCDPSession(page);
    const before = await page.evaluate(() => window.__mazeDebug.playerCell());
    const sol = await page.evaluate(() => window.__mazeDebug.solution());
    const far = sol[Math.min(6, sol.length - 1)];
    const p = await page.evaluate((c) => window.__mazeDebug.cellToScreen(c.x, c.y), far);

    // 模拟真实点击：按下 → 保持 holdMs → 抬起。全程笔尖不动。
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: p.x, y: p.y, button: 'left',
      buttons: 1, clickCount: 1, pointerType: 'pen', force: 0.6,
    });
    await page.waitForTimeout(holdMs);
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: p.x, y: p.y, button: 'left',
      buttons: 0, clickCount: 1, pointerType: 'pen', force: 0,
    });
    await page.waitForTimeout(1500);
    const after = await page.evaluate(() => window.__mazeDebug.playerCell());
    const moved = Math.abs(after.x - before.x) + Math.abs(after.y - before.y);
    console.log(`    按住 ${holdMs}ms 不动 → 小球移动 ${moved} 格`);
    check(`轻点（按住 ${holdMs}ms 不动）小球不应移动`, moved === 0,
      moved === 0 ? '未移动' : `移动了 ${moved} 格 ← 问题 2`);
    await ctx.close();
  }
}

await browser.close();
server.close();

const f = results.filter((r) => !r.ok);
console.log(`\n深入复现：${results.length} 项，问题 ${f.length} 项`);
for (const x of f) console.log(`  ✗ ${x.n}  ${x.d}`);
