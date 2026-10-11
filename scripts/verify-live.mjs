/**
 * 对线上 GitHub Pages 做真机等价验收。
 *
 * 运行：node scripts/verify-live.mjs
 * 前置：线上已部署完成（推送到 main 后等 Actions 跑完）。
 *
 * 这是最终判据：本地构建通过不等于线上可用（子路径、MIME、SW 作用域都可能出问题）。
 */
import { chromium, webkit, devices } from 'playwright';

const URL_ = 'https://salenju.github.io/maze-game/';
const results = [];
const check = (n, ok, d='') => { results.push({n,ok,d}); console.log(`${ok?'  ✓':'  ✗'} ${n}${d?`  — ${d}`:''}`); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPad Pro 11'], hasTouch: true });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
page.on('console', m => { if (m.type()==='error') errs.push(m.text()); });
// 记录所有失败请求，能直接暴露子路径/资源 404
const failed = [];
page.on('response', r => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });

await page.goto(URL_, { waitUntil: 'networkidle' });
check('线上首页可打开', await page.isVisible('.title'));
check('无失败资源请求', failed.length === 0, failed.slice(0,3).join(' | '));

// 关键：样式与脚本必须真的加载成功（base 配错会白屏但有 200）
const styled = await page.evaluate(() => {
  const b = document.querySelector('#btn-play');
  const cs = b ? getComputedStyle(b) : null;
  return cs ? cs.minHeight : null;
});
check('CSS 已生效（按钮有样式）', styled === '64px', `min-height=${styled}`);

/*
 * 等待 SW 就绪，而不是固定 sleep。
 * 首次访问线上站点时 SW 要下载+安装+激活，固定等待会采到中间态并误报失败
 * （曾出现线上检查报 active=false、缓存仅 7 项的假告警）。
 */
await page.evaluate(async () => {
  await Promise.race([
    navigator.serviceWorker.ready,
    new Promise((_, reject) => setTimeout(() => reject(new Error('SW ready 超时')), 20000)),
  ]);
});
const sw = await page.evaluate(async () => {
  const r = await navigator.serviceWorker.getRegistration();
  return r ? (r.active ? 'active' : 'registered') : 'none';
});
check('线上 Service Worker 已激活', sw === 'active', sw);

const cachedLive = await page.evaluate(async () => {
  const names = await caches.keys();
  let n = 0;
  for (const name of names) {
    const c = await caches.open(name);
    n += (await c.keys()).length;
  }
  return n;
});
check('线上已预缓存 app shell（≥10 项）', cachedLive >= 10, `${cachedLive} 项`);

// 图标必须真的可加载：路径写错时 manifest 仍合法但装不上
const liveIcons = await page.evaluate(async () => {
  const m = await (await fetch('/maze-game/manifest.webmanifest')).json();
  const out = [];
  for (const i of m.icons) {
    const r = await fetch('/maze-game/' + i.src.replace(/^\//, ''));
    out.push(`${i.src}:${r.status}`);
  }
  return out;
});
check('线上所有图标可加载', liveIcons.every((x) => x.endsWith(':200')), liveIcons.join(' '));

const liveApple = await page.evaluate(async () => {
  const l = document.querySelector('link[rel="apple-touch-icon"]');
  if (!l) return null;
  const r = await fetch(l.getAttribute('href'));
  return r.status;
});
check('线上 apple-touch-icon 可加载', liveApple === 200, String(liveApple));

const mf = await page.evaluate(async () => (await fetch('/maze-game/manifest.webmanifest')).json());
check('线上 manifest 正确', mf.start_url === '/maze-game/' && mf.display === 'standalone');

// 用真实 pen 事件拖动
await page.click('#btn-play'); await page.waitForTimeout(250);
await page.click('#btn-howto-ok'); await page.waitForTimeout(700);
const cdp = await ctx.newCDPSession(page);
const pos = await page.evaluate(() => window.__mazeDebug.playerScreenPos());
const before = await page.evaluate(() => window.__mazeDebug.playerCell());
await cdp.send('Input.dispatchMouseEvent', { type:'mousePressed', x:pos.x, y:pos.y, button:'left', buttons:1, clickCount:1, pointerType:'pen', force:0.6 });
for (let i=1;i<=10;i++){
  await cdp.send('Input.dispatchMouseEvent', { type:'mouseMoved', x:pos.x+i*14, y:pos.y+i*14, button:'left', buttons:1, pointerType:'pen', force:0.6 });
  await page.waitForTimeout(20);
}
await page.waitForTimeout(900);
await cdp.send('Input.dispatchMouseEvent', { type:'mouseReleased', x:pos.x+150, y:pos.y+150, button:'left', buttons:0, clickCount:1, pointerType:'pen', force:0 });
await page.waitForTimeout(300);
const after = await page.evaluate(() => window.__mazeDebug.playerCell());
check('线上触控笔能驱动小人', before.x!==after.x || before.y!==after.y, `(${before.x},${before.y}) → (${after.x},${after.y})`);
check('线上页面未滚动', await page.evaluate(()=>window.scrollY===0));

// 离线
await ctx.setOffline(true);
await page.reload({ waitUntil:'domcontentloaded' });
await page.waitForTimeout(1500);
check('线上断网后仍可打开', await page.isVisible('.title'));
await ctx.setOffline(false);
await page.screenshot({ path: 'artifacts/live-offline.png' });

check('线上无 JS 错误', errs.length === 0, errs.join(' | ').slice(0,200));
await ctx.close(); await browser.close();

// WebKit 也过一遍
const wk = await webkit.launch();
const wctx = await wk.newContext({ viewport:{width:1194,height:834}, deviceScaleFactor:2, hasTouch:true });
const wp = await wctx.newPage();
const werrs = [];
wp.on('pageerror', e => werrs.push(String(e)));
await wp.goto(URL_, { waitUntil:'domcontentloaded' });
await wp.waitForTimeout(900);
check('线上 WebKit 可渲染', await wp.isVisible('.title'));
await wp.click('#btn-play'); await wp.waitForTimeout(250);
await wp.click('#btn-howto-ok'); await wp.waitForTimeout(700);
check('线上 WebKit 可进入游戏', await wp.isVisible('#screen-game'));
check('线上 WebKit 无 JS 错误', werrs.length===0, werrs.join(' | ').slice(0,200));
await wctx.close(); await wk.close();

const f = results.filter(r=>!r.ok);
console.log(`\n线上验收：合计 ${results.length} 项，通过 ${results.length-f.length}，失败 ${f.length}`);
if (f.length){ for(const x of f) console.log(`  ✗ ${x.n}  ${x.d}`); process.exitCode=1; }
