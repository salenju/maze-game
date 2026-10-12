import { chromium, devices } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('./dist', import.meta.url));
const PORT = 4313;
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
const cdp = await ctx.newCDPSession(page);
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

async function dragAlong(cells, holdMs = 140) {
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
  await page.waitForTimeout(500);
}

async function openDifficulty() {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.clear());
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.click('#btn-difficulty');
  await page.waitForTimeout(400);
}

// --- A：中等档（自带 3 颗）→ 1 颗在死路，沿正路只吃到 2 颗 ---
await openDifficulty();
await page.locator('.diff-item').nth(2).click();
await page.waitForTimeout(200);
await page.click('#btn-start');
await page.waitForTimeout(700);
let info = await page.evaluate(() => window.__mazeDebug.mazeInfo());
check('中等档 3 颗星星', info.starsTotal === 3, `starsTotal=${info.starsTotal}`);
await page.locator('#canvas-wrap').screenshot({ path: 'artifacts/tmp-decoys-medium.png' });
await dragAlong(await page.evaluate(() => window.__mazeDebug.solution()));
info = await page.evaluate(() => window.__mazeDebug.mazeInfo());
check('沿正路走完只吃到 2 颗（第 3 颗是死路诱饵）',
  info.starsCollected === 2 && info.starsTotal === 3,
  `collected=${info.starsCollected}/${info.starsTotal}`);

// --- B：挑战档 8 颗 → 3 颗诱饵，沿正路只吃到 5 颗 ---
await openDifficulty();
await page.locator('#stars-panel input[data-field="stars"]').fill('8');
await page.waitForTimeout(200);
await page.locator('.diff-item').nth(3).click();
await page.waitForTimeout(200);
await page.click('#btn-start');
await page.waitForTimeout(800);
info = await page.evaluate(() => window.__mazeDebug.mazeInfo());
check('挑战档 8 颗星星', info.starsTotal === 8, `starsTotal=${info.starsTotal}`);
await page.locator('#canvas-wrap').screenshot({ path: 'artifacts/tmp-decoys-hard.png' });
await dragAlong(await page.evaluate(() => window.__mazeDebug.solution()));
info = await page.evaluate(() => window.__mazeDebug.mazeInfo());
check('沿正路走完只吃到 5 颗（其余 3 颗藏在死路）',
  info.starsCollected === 5 && info.starsTotal === 8,
  `collected=${info.starsCollected}/${info.starsTotal}`);

// --- C：0 颗星仍然没有星星 ---
await openDifficulty();
await page.locator('#stars-panel input[data-field="stars"]').fill('0');
await page.waitForTimeout(200);
await page.locator('.diff-item').nth(3).click();
await page.waitForTimeout(200);
await page.click('#btn-start');
await page.waitForTimeout(700);
info = await page.evaluate(() => window.__mazeDebug.mazeInfo());
check('把星星设为 0 颗时不放任何星星（含诱饵）', info.starsTotal === 0, `starsTotal=${info.starsTotal}`);

check('全流程无 JS 报错', errors.length === 0, errors.slice(0, 2).join(' | '));
await browser.close();
server.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n合计 ${results.length} 项，失败 ${failed.length}`);
if (failed.length) process.exitCode = 1;
