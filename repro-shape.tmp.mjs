import { chromium, devices } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('./dist/', import.meta.url));
const PORT = 4321;
const BASE = `http://127.0.0.1:${PORT}/maze-game/`;
const MIME = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8','.webmanifest':'application/manifest+json','.png':'image/png','.svg':'image/svg+xml','.json':'application/json' };
const server = createServer(async (req,res)=>{ try { const u=new URL(req.url,'http://l'); let p=decodeURIComponent(u.pathname);
  if(p==='/maze-game'||p==='/maze-game/')p='/maze-game/index.html';
  const f=join(ROOT, normalize(p).replace(/^\/?maze-game\//,''));
  await stat(f); res.writeHead(200,{'Content-Type':MIME[extname(f)]??'application/octet-stream'}); res.end(await readFile(f));
} catch { res.writeHead(404).end('x'); }});
await new Promise(r=>server.listen(PORT,'127.0.0.1',r));

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPad Pro 11'], hasTouch: true });
const page = await ctx.newPage();
await page.addInitScript(() => { try { localStorage.clear(); } catch {} });
await page.goto(BASE, { waitUntil: 'networkidle' });

const pressed = () => page.$eval('.shape-btn[aria-pressed="true"]', e => e.dataset.shape);
const cardShape = (n) => page.$eval(`.diff-item:nth-child(${n}) h3`, e => e.textContent.trim());
const startAndRead = async () => {
  await page.click('#btn-start');
  await page.waitForTimeout(500);
  if (await page.isVisible('#screen-howto')) { await page.click('#btn-howto-ok'); await page.waitForTimeout(600); }
  const info = await page.evaluate(() => window.__mazeDebug.mazeInfo());
  const hud = (await page.textContent('#hud-diff'))?.trim();
  return { shape: info.shape, size: `${info.cols}x${info.rows}`, hud };
};

await page.click('#btn-difficulty');
await page.waitForTimeout(300);
console.log('0) 默认（跟随难度）：形状高亮 =', await pressed(), '｜入门卡片 =', await cardShape(1), '｜挑战卡片 =', await cardShape(4));

// 用户操作：先选形状（星形），再选难度（入门）
await page.click('.shape-btn[data-shape="star"]');
await page.waitForTimeout(250);
console.log('1) 点「星形」后：高亮 =', await pressed(), '｜入门卡片 =', await cardShape(1));

await page.click('.diff-item:nth-child(1)');
await page.waitForTimeout(250);
console.log('2) 再点「入门」：高亮 =', await pressed(), '｜入门卡片 =', await cardShape(1));
console.log('   开局 =', JSON.stringify(await startAndRead()));

const backToDifficulty = async () => {
  await page.click('#btn-pause');
  await page.waitForTimeout(250);
  await page.click('#btn-quit');
  await page.waitForTimeout(250);
  await page.click('#btn-difficulty');
  await page.waitForTimeout(300);
};

// 换到「挑战」：形状仍应是星形
await backToDifficulty();
await page.click('.diff-item:nth-child(4)');
await page.waitForTimeout(250);
console.log('3) 换「挑战」：高亮 =', await pressed(), '｜挑战卡片 =', await cardShape(4));
console.log('   开局 =', JSON.stringify(await startAndRead()));

// 恢复默认
await backToDifficulty();
await page.click('[data-role="shape-reset"]');
await page.waitForTimeout(250);
console.log('4) 点「恢复默认」：高亮 =', await pressed(), '｜挑战卡片 =', await cardShape(4));
console.log('   开局 =', JSON.stringify(await startAndRead()));
console.log('   prefs =', await page.evaluate(() => localStorage.getItem('maze.prefs.v1')));
await backToDifficulty();
await page.click('.diff-item:nth-child(1)');
await page.waitForTimeout(250);
console.log('5) 恢复默认后点「入门」：高亮 =', await pressed(), '｜入门卡片 =', await cardShape(1));
console.log('   开局 =', JSON.stringify(await startAndRead()));

await browser.close(); server.close();
