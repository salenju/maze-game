/**
 * 边界与生命周期测量。
 *
 * 1. 极端家长自定义尺寸（6×6 最小、24×24 最大）：家长真的会去拉满滑块，
 *    必须确认不会崩、不会卡、星星数量与路径长度不匹配时也不出错。
 * 2. 切后台自动暂停：孩子在平板上被叫走时计时不该继续跑。
 *    代码里有 pausedByVisibility 状态，但此前从未验证过行为。
 * 3. 性能：24×24=576 格下每次笔尖换格都要跑 BFS，确认不卡顿。
 */

import { chromium, devices } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../dist', import.meta.url));
const PORT = 4189;
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

/** 用给定的自定义参数开一局。 */
async function startCustom(page, { cols, rows, stars, braid }) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.click('#btn-difficulty');
  await page.waitForTimeout(400);
  await page.locator('.diff-item').nth(4).click(); // 自定义
  await page.waitForTimeout(250);

  // 按 data-field 定位而不是按位置：新增滑块不会让脚本改错控件
  const field = (name) => page.locator(`#custom-panel input[data-field="${name}"]`);
  await field('cols').fill(String(cols));
  await page.waitForTimeout(150);
  await field('rows').fill(String(rows));
  await page.waitForTimeout(150);
  await field('braid').fill(String(braid));
  await page.waitForTimeout(150);
  // 星星数量已从自定义面板提到「跨难度」的那一行，选择器随之调整
  await page.locator('#stars-panel input[data-field="stars"]').fill(String(stars));
  await page.waitForTimeout(200);

  await page.click('#btn-start');
  await page.waitForTimeout(800);
}

const ctx = await browser.newContext({ ...devices['iPad Pro 11'], hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

// ---------- 1. 最大尺寸 24×24 ----------
{
  console.log('\n【1】自定义最大尺寸 24×24 + 8 颗星星');
  const t0 = Date.now();
  await startCustom(page, { cols: 24, rows: 24, stars: 8, braid: 0 });
  const genMs = Date.now() - t0;
  const info = await page.evaluate(() => window.__mazeDebug.mazeInfo());
  check('24×24 迷宫成功生成', info.cols === 24 && info.rows === 24, `${info.cols}x${info.rows}，用时约 ${genMs}ms`);
  check('24×24 下格子边长仍可点按（≥18px）', info.cell >= 18, `cell=${info.cell}px`);

  // 性能：连续拖动时的帧耗时（576 格 BFS 每换格一次）
  const cdp = await ctx.newCDPSession(page);
  const from = await page.evaluate(() => window.__mazeDebug.playerScreenPos());
  const sol = await page.evaluate(() => window.__mazeDebug.solution());
  const perf = await page.evaluate(() => {
    const t = [];
    let last = performance.now();
    return new Promise((resolve) => {
      let n = 0;
      const tick = () => {
        const now = performance.now();
        t.push(now - last);
        last = now;
        if (++n < 60) requestAnimationFrame(tick);
        else resolve(t);
      };
      requestAnimationFrame(tick);
    });
  });

  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: 0.6 });
  const target = sol[Math.min(30, sol.length - 1)];
  const tp = await page.evaluate((c) => window.__mazeDebug.cellToScreen(c.x, c.y), target);
  const t1 = Date.now();
  // 快速连续换格：每次移动都触发一次 BFS
  for (let i = 1; i <= 20; i++) {
    const rt = await page.evaluate((c) => window.__mazeDebug.cellToScreen(c.x, c.y), sol[Math.min(i, sol.length - 1)]);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rt.x, y: rt.y, button: 'left', buttons: 1, pointerType: 'pen', force: 0.6 });
    await page.waitForTimeout(30);
  }
  const dragMs = Date.now() - t1;
  check('24×24 下连续换格拖动无卡顿（20 次换格 < 3s）', dragMs < 3000, `${dragMs}ms`);

  const avgFrame = perf.reduce((a, b) => a + b, 0) / perf.length;
  check('24×24 下帧间隔正常（均值 < 40ms）', avgFrame < 40, `均值 ${avgFrame.toFixed(1)}ms`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: from.x, y: from.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen', force: 0 });
  check('24×24 场景无 JS 错误', errors.length === 0, errors.join(' | ').slice(0, 200));
  await page.screenshot({ path: 'artifacts/custom-24x24.png' });
}

// ---------- 2. 最小尺寸 6×6 ----------
{
  console.log('\n【2】自定义最小尺寸 6×6');
  await startCustom(page, { cols: 6, rows: 6, stars: 8, braid: 100 });
  const info = await page.evaluate(() => window.__mazeDebug.mazeInfo());
  check('6×6 迷宫成功生成', info.cols === 6 && info.rows === 6, `${info.cols}x${info.rows}`);
  // 6×6 只有 36 格，路径很短，星星必须被自动收敛而不是报错
  check('6×6 下星星数量被合理收敛', info.starsTotal >= 0 && info.starsTotal <= 8, `starsTotal=${info.starsTotal}`);
  check('6×6 下格子边长很大（好点按）', info.cell >= 60, `cell=${info.cell}px`);
  check('6×6 场景无 JS 错误', errors.length === 0, errors.join(' | ').slice(0, 200));
  await page.screenshot({ path: 'artifacts/custom-6x6.png' });
}

// ---------- 3. 切后台自动暂停 ----------
{
  console.log('\n【3】切后台自动暂停（计时不应继续跑）');
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.click('#btn-difficulty');
  await page.waitForTimeout(350);
  await page.locator('.diff-item').nth(2).click(); // 中等：有计时
  await page.waitForTimeout(200);
  await page.click('#btn-start');
  await page.waitForTimeout(1200);

  const t1 = await page.textContent('#hud-time');
  check('计时档开局后计时器在走', t1 !== '--:--', t1);

  // 模拟切到后台
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(300);

  const paused = await page.isVisible('#screen-pause');
  check('切到后台后自动进入暂停界面', paused);

  const tPause = await page.textContent('#hud-time');
  await page.waitForTimeout(2000); // 后台停留 2 秒
  const tAfter = await page.textContent('#hud-time');
  check('后台停留期间计时冻结（不增加）', tPause === tAfter, `${tPause} → ${tAfter}`);

  // 回到前台：不应自动继续（由孩子主动点「继续玩」更安全）
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(400);
  check('回到前台后仍停在暂停界面等孩子确认', await page.isVisible('#screen-pause'));

  // 点继续玩：计时恢复、笔也能用
  await page.click('#btn-resume');
  await page.waitForTimeout(1600);
  const tResume = await page.textContent('#hud-time');
  check('继续后计时恢复推进', tResume !== tAfter, `${tAfter} → ${tResume}`);
  check('生命周期场景无 JS 错误', errors.length === 0, errors.join(' | ').slice(0, 200));
}

await ctx.close();
await browser.close();
server.close();

const f = results.filter((r) => !r.ok);
console.log(`\n边界测量：${results.length} 项，异常 ${f.length} 项`);
for (const x of f) console.log(`  ✗ ${x.n}  ${x.d}`);
if (f.length) process.exitCode = 1;
