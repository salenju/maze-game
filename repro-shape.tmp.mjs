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

await page.click('#btn-difficulty');
await page.waitForTimeout(300);

// 用户操作：先在「家长自定义」里选一个形状
const shapes = await page.$$eval('.shape-btn', els => els.map(e => e.dataset.shape));
console.log('可选形状:', shapes.join(', '));

await page.click('.shape-btn[data-shape="star"]');
await page.waitForTimeout(200);
const afterShape = await page.$eval('.shape-btn[aria-pressed="true"]', e => e.dataset.shape);
console.log('1) 点「星形」后，形状高亮 =', afterShape);

// 再选一个难度档位（入门）
await page.click('.diff-item:nth-child(1)');
await page.waitForTimeout(200);
const presetSelected = await page.$eval('.diff-item[aria-pressed="true"] h3', e => e.textContent);
const shapeAfterPreset = await page.$eval('.shape-btn[aria-pressed="true"]', e => e.dataset.shape);
console.log('2) 再点「入门」难度后：选中档位 =', presetSelected, '，形状面板高亮 =', shapeAfterPreset);

// 开始游戏，看实际生成的迷宫形状
await page.click('#btn-start');
await page.waitForTimeout(500);
if (await page.isVisible('#screen-howto')) { await page.click('#btn-howto-ok'); await page.waitForTimeout(600); }
const info = await page.evaluate(() => window.__mazeDebug.mazeInfo());
console.log('3) 实际开局迷宫 =', JSON.stringify({cols: info.cols, rows: info.rows}));
console.log('   HUD 显示 =', (await page.textContent('#hud-diff'))?.trim());
console.log('   localStorage 自定义 =', await page.evaluate(() => localStorage.getItem('maze.custom.v1')));
console.log('   实际用到的小人起始格 =', JSON.stringify(await page.evaluate(() => window.__mazeDebug.playerCell())));
await browser.close(); server.close();
