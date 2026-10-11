/**
 * 移动手感测量：确认防作弊闸门没有把正常拖动做坏。
 *
 * 需要覆盖三种真实笔势：
 *   A. 慢速连续拖动（小朋友常见的谨慎划笔）
 *   B. 快速划笔（几下就从一端划到另一端）
 *   C. 一笔到底的连续长划
 *
 * 判据：小球在这些笔势下都应有明显推进，不能出现「画了半天球不动」。
 * 同时确认：笔尖停住不动时小球必然停下（防盗闸门仍生效）。
 */

import { chromium, devices } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../dist', import.meta.url));
const PORT = 4185;
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

/** 每个场景都用全新页面，避免相互干扰。返回 {travelled, stalled}。 */
async function gesture(name, steps, delayMs, holdMs) {
  const ctx = await browser.newContext({ ...devices['iPad Pro 11'], hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.click('#btn-play'); await page.waitForTimeout(200);
  await page.click('#btn-howto-ok'); await page.waitForTimeout(600);

  const cdp = await ctx.newCDPSession(page);
  const sol = await page.evaluate(() => window.__mazeDebug.solution());
  const start = await page.evaluate((c) => window.__mazeDebug.cellToScreen(c.x, c.y), sol[0]);
  const before = await page.evaluate(() => window.__mazeDebug.playerCell());

  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: start.x, y: start.y, button: 'left',
    buttons: 1, clickCount: 1, pointerType: 'pen', force: 0.6,
  });

  // 沿解路径前进 steps 个格子，模拟真实笔势
  const n = Math.min(steps, sol.length - 1);
  for (let i = 1; i <= n; i++) {
    const p = await page.evaluate((c) => window.__mazeDebug.cellToScreen(c.x, c.y), sol[i]);
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: p.x, y: p.y, button: 'left',
      buttons: 1, pointerType: 'pen', force: 0.6,
    });
    await page.waitForTimeout(delayMs);
  }

  // 笔尖保持最后位置不动
  if (holdMs > 0) await page.waitForTimeout(holdMs);

  const after = await page.evaluate(() => window.__mazeDebug.playerCell());
  const travelled = Math.abs(after.x - before.x) + Math.abs(after.y - before.y);

  // 相对进度：每次开局的迷宫都是随机的，
  // 绝对格数跨次运行不可比（不同迷宫的起终点距离不同），
  // 因此用「在解路径上推进了多少步」来衡量拖动是否跟手。
  const prog = await page.evaluate(() => window.__mazeDebug.solutionProgress());

  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: start.x, y: start.y, button: 'left',
    buttons: 0, clickCount: 1, pointerType: 'pen', force: 0,
  });
  await ctx.close();
  return { travelled, before, after, name, prog };
}

console.log('\n【A】慢速划笔：每格停顿 260ms，共 6 格');
const a = await gesture('slow', 6, 260, 300);
// 笔尖走了 6 步，小球理应跟上绝大部分（留 1 步余量给滑行时间）
check('慢速划笔小球能跟上', a.prog.index >= 5,
  `解路径推进 ${a.prog.index}/${a.prog.total} 步（笔尖走了 6 步）`);

console.log('\n【B】快速划笔：每格仅 25ms，共 8 格');
const b = await gesture('fast', 8, 25, 900);
// 快速划笔时笔尖推进得比小球快，小球靠额度追赶，应推进可观距离
check('快速划笔小球能跟上', b.prog.index >= 3,
  `解路径推进 ${b.prog.index}/${b.prog.total} 步（笔尖快速走了 8 步）`);

console.log('\n【C】一笔到底：每格 60ms，走到解路径尽头');
const c = await gesture('long', 40, 60, 1500);
// 一笔到底：小球应沿解路径推进相当比例，而不是走走停停
check('长距离连续划笔小球持续推进', c.prog.index >= 6,
  `解路径推进 ${c.prog.index}/${c.prog.total} 步（笔尖连续走了 40 步）`);

console.log('\n【D】防盗闸门：只按一下、笔尖完全不动');
const d = await gesture('hold', 0, 0, 6000);
check('笔尖不动时小球不会自行走远', d.travelled === 0,
  `推进 ${d.travelled} 格 (${d.before.x},${d.before.y}) → (${d.after.x},${d.after.y})`);

await browser.close();
server.close();

const f = results.filter((r) => !r.ok);
console.log(`\n手感测量：${results.length} 项，异常 ${f.length} 项`);
for (const x of f) console.log(`  ✗ ${x.n}  ${x.d}`);
if (f.length) process.exitCode = 1;
