import { chromium, devices } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('./dist', import.meta.url));
const PORT = 4311;
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
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const slider = () => page.locator('#stars-panel input[data-field="stars"]');

async function openDifficulty({ reset = true } = {}) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (reset) await page.evaluate(() => localStorage.clear());
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.click('#btn-difficulty');
  await page.waitForTimeout(400);
}

// --- A：不改选中档位（默认「入门」），只拉星星滑块 ---
await openDifficulty();
check('星星滑块在难度列表之外的独立一行', await slider().isVisible());
await slider().fill('8');
await page.waitForTimeout(250);
await page.click('#btn-start');
await page.waitForTimeout(800);
let info = await page.evaluate(() => window.__mazeDebug.mazeInfo());
check('入门档下设置 8 颗星星真的开出 8 颗', info.starsTotal === 8, `starsTotal=${info.starsTotal}`);
check('HUD 显示 0/8', (await page.textContent('#hud-stars')).includes('0/8'));
await page.screenshot({ path: 'artifacts/tmp-stars-starter.png' });

// 持久化：重开后仍然是 8
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.click('#btn-play');
await page.waitForTimeout(250);
if (await page.isVisible('#screen-howto')) {
  await page.click('#btn-howto-ok');
  await page.waitForTimeout(700);
}
info = await page.evaluate(() => window.__mazeDebug.mazeInfo());
check('星星数量已持久化（重开后仍是 8）', info.starsTotal === 8, `starsTotal=${info.starsTotal}`);

// --- B：切换到「挑战」，星星覆盖仍然生效 ---
await openDifficulty({ reset: false });
await page.locator('.diff-item').nth(3).click();
await page.waitForTimeout(250);
check('卡片摘要跟着覆盖值变', (await page.locator('.diff-item').nth(0).textContent()).includes('8 颗星星'));
await page.click('#btn-start');
await page.waitForTimeout(900);
info = await page.evaluate(() => window.__mazeDebug.mazeInfo());
check('挑战档下 8 颗星星同样生效', info.starsTotal === 8, `starsTotal=${info.starsTotal}`);
check('挑战档已按成人难度配置',
  info.cols === 24 && info.rows === 24 && info.shape === 'star',
  `${info.shape} ${info.cols}x${info.rows}`);
check('挑战档岔路显著变多', info.junctions > 55 && info.deadEnds > 55,
  `岔路=${info.junctions} 死胡同=${info.deadEnds} 格子=${info.mazeCells}`);
await page.screenshot({ path: 'artifacts/tmp-stars-hard.png' });

// --- C：点「跟随各难度的默认数量」回到档位自带 ---
await openDifficulty();
await page.locator('.diff-item').nth(3).click();
await page.waitForTimeout(250);
check('未设置覆盖时「跟随默认」按钮隐藏', !(await page.locator('#stars-panel [data-role="stars-reset"]').isVisible()));
await slider().fill('8');
await page.waitForTimeout(250);
check('设置覆盖后「跟随默认」按钮出现', await page.locator('#stars-panel [data-role="stars-reset"]').isVisible());
await page.locator('#stars-panel [data-role="stars-reset"]').click();
await page.waitForTimeout(250);
check('复位后滑块显示档位默认值 5', (await slider().inputValue()) === '5');
await page.click('#btn-start');
await page.waitForTimeout(900);
info = await page.evaluate(() => window.__mazeDebug.mazeInfo());
check('复位后挑战档回到 5 颗', info.starsTotal === 5, `starsTotal=${info.starsTotal}`);

// --- D：拖动星星滑块必须能连续移动（不能被重绘打断） ---
await openDifficulty();
const box = await slider().boundingBox();
const before = Number(await slider().inputValue());
await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
await page.mouse.down();
for (let i = 1; i <= 12; i++) {
  await page.mouse.move(box.x + box.width * (0.2 + (0.6 * i) / 12), box.y + box.height / 2);
  await page.waitForTimeout(30);
}
await page.mouse.up();
await page.waitForTimeout(200);
const after = Number(await slider().inputValue());
check('星星滑块可连续拖动（不会被重绘打断）', after - before >= 3, `${before} → ${after}`);

// --- E：自定义档位仍然可用，且小迷宫不再按面积打折 ---
await openDifficulty();
await page.screenshot({ path: 'artifacts/tmp-diff-screen.png' });
await page.locator('.diff-item').nth(4).click();
await page.waitForTimeout(250);
const customField = (name) => page.locator(`#custom-panel input[data-field="${name}"]`);
await customField('cols').fill('6');
await page.waitForTimeout(200);
await customField('rows').fill('6');
await page.waitForTimeout(200);
await slider().fill('8');
await page.waitForTimeout(250);
await page.click('#btn-start');
await page.waitForTimeout(700);
info = await page.evaluate(() => window.__mazeDebug.mazeInfo());
check('6×6 小迷宫也照办 8 颗星星（只受路径长度约束）', info.starsTotal === 8, `starsTotal=${info.starsTotal}`);

check('全流程无 JS 报错', errors.length === 0, errors.slice(0, 2).join(' | ').slice(0, 200));
await page.screenshot({ path: 'artifacts/tmp-difficulty-panel.png' });

await browser.close();
server.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n合计 ${results.length} 项，失败 ${failed.length}`);
if (failed.length) process.exitCode = 1;
