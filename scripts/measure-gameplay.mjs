/**
 * 玩法质量测量：验证两个怀疑中的缺陷。
 *
 * 怀疑 1（自动通关）：Game.dragTo 在目标格不变时会提前 return，
 *   所以「把笔尖按在出口上不动」会一次性算出到出口的完整路径并走完 ——
 *   等于孩子点一下出口就自动赢了迷宫，玩法失去意义。
 *
 * 怀疑 2（引导页副作用）：从首页点「怎么玩」看完说明后点「我知道啦」，
 *   会被直接丢进一局游戏（该按钮无条件 startGame），
 *   而且会把 tutorialSeen 置为 true，导致孩子真正第一次玩时反而没有引导。
 */

import { chromium, devices } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../dist', import.meta.url));
const PORT = 4183;
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

// ---------- 测量 1：按住出口不动，是否会自动通关 ----------
{
  console.log('\n【测量 1】把笔尖按在出口上不动');
  const ctx = await browser.newContext({ ...devices['iPad Pro 11'], hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.click('#btn-play'); await page.waitForTimeout(250);
  await page.click('#btn-howto-ok'); await page.waitForTimeout(600);

  const cdp = await ctx.newCDPSession(page);
  const info = await page.evaluate(() => window.__mazeDebug.solution());
  const exitCell = info[info.length - 1];
  const p = await page.evaluate((c) => window.__mazeDebug.cellToScreen(c.x, c.y), exitCell);

  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1,
    clickCount: 1, pointerType: 'pen', force: 0.6,
  });
  // 笔尖完全不动，只等待
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(500);
    if (await page.isVisible('#screen-win')) break;
  }
  const won = await page.isVisible('#screen-win');
  check('按住出口不动不会自动通关（期望不通过）', !won, won ? '自动走完了整张迷宫' : '未自动通关');
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0,
    clickCount: 1, pointerType: 'pen', force: 0,
  });
  await ctx.close();
}

// ---------- 测量 2：首页「怎么玩」看完后会怎样 ----------
{
  console.log('\n【测量 2】首页点「怎么玩」→「我知道啦」');
  const ctx = await browser.newContext({ ...devices['iPad Pro 11'], hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.click('#btn-howto'); await page.waitForTimeout(300);
  check('「怎么玩」能打开说明页', await page.isVisible('#screen-howto'));
  await page.click('#btn-howto-ok'); await page.waitForTimeout(600);

  const inGame = await page.isVisible('#screen-game');
  check('看完说明后回到首页、不会直接开局（期望不通过）', !inGame,
    inGame ? '被直接丢进一局游戏' : '已回到首页');

  const prefs = await page.evaluate(() => {
    const raw = localStorage.getItem('maze.prefs.v1');
    return raw ? JSON.parse(raw) : null;
  });
  check('只是查阅说明不会消耗首次引导（期望不通过）', prefs?.tutorialSeen !== true,
    `tutorialSeen=${prefs?.tutorialSeen}`);
  await ctx.close();
}

await browser.close();
server.close();

const f = results.filter((r) => !r.ok);
console.log(`\n测量完成：${results.length} 项，异常 ${f.length} 项`);
for (const x of f) console.log(`  ✗ ${x.n}  ${x.d}`);
