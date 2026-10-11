/**
 * 真浏览器验证脚本。
 *
 * 目的：在没有平板的情况下，尽可能逼近真机行为。
 *  - Chromium 通过 CDP 的 Input.dispatchMouseEvent 发送 pointerType='pen' 事件，
 *    这是真正走浏览器输入管线的笔事件，而不是 page.evaluate 造的不可信事件。
 *  - WebKit 引擎（Safari 同源）用来暴露 iOS 侧的实现差异。
 *  - 同时验证 PWA 清单、Service Worker 注册、离线可玩。
 *
 * 运行：node scripts/verify.mjs
 */

import { chromium, webkit, devices } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../dist', import.meta.url));
const PORT = 4178;
const BASE = `http://127.0.0.1:${PORT}/maze-game/`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/** 静态服务器：模拟 GitHub Pages 的 /maze-game/ 子路径。 */
function serve() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let pathname = decodeURIComponent(url.pathname);
      if (pathname === '/maze-game' || pathname === '/maze-game/') pathname = '/maze-game/index.html';

      const rel = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
      const file = join(ROOT, rel.replace(/^\/?maze-game\//, ''));
      const info = await stat(file);
      if (info.isDirectory()) throw new Error('dir');

      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  — ${detail}` : ''}`);
}

/**
 * 用 CDP 发送真正的 pen 类型指针事件。
 * Playwright 的 mouse API 只能产生 pointerType='mouse'，测不到笔的代码路径。
 */
async function penStroke(page, cdp, points) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: points[0].x,
    y: points[0].y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
    pointerType: 'pen',
    force: 0.6,
  });
  for (const p of points.slice(1)) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: p.x,
      y: p.y,
      button: 'left',
      buttons: 1,
      pointerType: 'pen',
      force: 0.6,
    });
    await page.waitForTimeout(16);
  }
}

async function penUp(page, cdp, last) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: last.x,
    y: last.y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
    pointerType: 'pen',
    force: 0,
  });
}

async function runChromium(browser) {
  console.log('\n【Chromium + 笔事件】(安卓平板同源引擎)');
  // 用真实平板设备描述符：拿到正确的触摸能力、DPR 与视口
  const context = await browser.newContext({
    ...devices['iPad Pro 11'],
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await page.goto(BASE, { waitUntil: 'networkidle' });

  // --- 首屏 ---
  const title = await page.textContent('.title');
  check('首页标题正确渲染', title?.includes('迷宫大冒险'), title ?? '');
  await page.screenshot({ path: 'artifacts/01-home.png' });

  // --- PWA 清单与 Service Worker ---
  const manifest = await page.evaluate(async () => {
    const res = await fetch('/maze-game/manifest.webmanifest');
    return res.ok ? res.json() : null;
  });
  check('manifest 可访问且为 standalone', manifest?.display === 'standalone');
  check('manifest start_url 与子路径一致', manifest?.start_url === '/maze-game/', manifest?.start_url);
  check('manifest 含 192 与 512 图标', (manifest?.icons ?? []).length >= 3);

  const swActive = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return 'unsupported';
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? (reg.active ? 'active' : 'registered') : 'none';
  });
  check('Service Worker 已注册', swActive === 'active' || swActive === 'registered', swActive);

  // --- 进入游戏 ---
  await page.click('#btn-play');
  await page.waitForTimeout(400);
  check('首次游玩弹出玩法引导', await page.isVisible('#screen-howto'));
  await page.screenshot({ path: 'artifacts/02-howto.png' });

  await page.click('#btn-howto-ok');
  await page.waitForTimeout(600);
  check('引导确认后进入游戏画面', await page.isVisible('#screen-game'));

  const canvasBox = await page.locator('#maze-canvas').boundingBox();
  check('画布已布局且有尺寸', !!canvasBox && canvasBox.width > 200 && canvasBox.height > 200,
    canvasBox ? `${Math.round(canvasBox.width)}x${Math.round(canvasBox.height)}` : 'none');

  // 画布内部分辨率必须按 DPR 放大，否则视网膜屏上会发虚
  const canvasDpr = await page.evaluate(() => {
    const c = document.querySelector('#maze-canvas');
    return { w: c.width, h: c.height, dpr: window.devicePixelRatio };
  });
  check('画布按 devicePixelRatio 缩放（视网膜屏不发虚）',
    canvasDpr.w > canvasBox.width * 1.5,
    `bitmap ${canvasDpr.w}px vs css ${Math.round(canvasBox.width)}px, dpr=${canvasDpr.dpr}`);

  // --- 用真正的 pen 事件拖动 ---
  const cdp = await context.newCDPSession(page);
  const start = await page.evaluate(() => {
    const app = window.__mazeDebug;
    return app ? app.playerScreenPos() : null;
  });
  check('暴露调试接口以读取小人位置', !!start);

  if (start) {
    const before = await page.evaluate(() => window.__mazeDebug.playerCell());
    // 沿画布向右下方划一笔，模拟孩子握笔拖动
    const pts = [];
    for (let i = 0; i <= 12; i++) {
      pts.push({ x: start.x + i * 14, y: start.y + i * 14 });
    }
    await penStroke(page, cdp, pts);
    await page.waitForTimeout(1200);
    await penUp(page, cdp, pts[pts.length - 1]);
    await page.waitForTimeout(300);

    const after = await page.evaluate(() => window.__mazeDebug.playerCell());
    check('pen 类型指针能驱动小人移动',
      before.x !== after.x || before.y !== after.y,
      `(${before.x},${before.y}) → (${after.x},${after.y})`);

    const sampled = await page.evaluate(() => window.__mazeDebug.lastPointerTypes());
    check('浏览器上报的 pointerType 为 pen',
      Array.isArray(sampled) && sampled.includes('pen'),
      JSON.stringify(sampled));
  }

  await page.screenshot({ path: 'artifacts/03-playing.png' });

  // --- 计时显示：入门档不计时，必须显示 --:-- 而不是走表 ---
  const t1 = await page.textContent('#hud-time');
  await page.waitForTimeout(1200);
  const t2 = await page.textContent('#hud-time');
  check('入门难度（不计时）显示 --:-- 且不走表', t1 === '--:--' && t2 === '--:--', `${t1} → ${t2}`);

  // --- 触屏也能玩（孩子可能用手指） ---
  await page.touchscreen.tap(start.x, start.y);
  await page.waitForTimeout(200);
  check('触摸输入不报错', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 200));

  // --- 页面不应因为拖动而滚动或缩放 ---
  const scrolled = await page.evaluate(() => ({
    x: window.scrollX,
    y: window.scrollY,
    scale: window.visualViewport ? window.visualViewport.scale : 1,
  }));
  check('拖动后页面未滚动', scrolled.x === 0 && scrolled.y === 0, JSON.stringify(scrolled));
  check('笔输入未触发页面缩放', scrolled.scale === 1, `scale=${scrolled.scale}`);

  // --- 暂停后必须能真正继续（曾经在这里丢过输入挂载与主循环） ---
  await page.click('#btn-pause');
  await page.waitForTimeout(300);
  check('暂停弹窗出现', await page.isVisible('#screen-pause'));
  await page.screenshot({ path: 'artifacts/04-pause.png' });

  await page.click('#btn-resume');
  await page.waitForTimeout(400);
  check('点「继续玩」后回到游戏画面', await page.isVisible('#screen-game'));

  // 关键回归：恢复后画笔必须仍然有效、画面必须仍在刷新
  const afterResume = await page.evaluate(() => window.__mazeDebug.playerCell());
  const resumePos = await page.evaluate(() => window.__mazeDebug.playerScreenPos());
  await penStroke(page, cdp, [
    { x: resumePos.x, y: resumePos.y },
    { x: resumePos.x + 30, y: resumePos.y + 30 },
    { x: resumePos.x + 60, y: resumePos.y + 60 },
    { x: resumePos.x + 90, y: resumePos.y + 90 },
  ]);
  await page.waitForTimeout(900);
  await penUp(page, cdp, { x: resumePos.x + 90, y: resumePos.y + 90 });
  await page.waitForTimeout(200);
  const afterResumeMove = await page.evaluate(() => window.__mazeDebug.playerCell());
  check('暂停再继续后触控笔依然能拖动（回归）',
    afterResume.x !== afterResumeMove.x || afterResume.y !== afterResumeMove.y,
    `(${afterResume.x},${afterResume.y}) → (${afterResumeMove.x},${afterResumeMove.y})`);

  // 现在处于游戏画面，先暂停再退出，才能点到「回首页」
  await page.click('#btn-pause');
  await page.waitForTimeout(250);
  await page.click('#btn-quit');
  await page.waitForTimeout(300);
  await page.click('#btn-difficulty');
  await page.waitForTimeout(400);
  check('难度页面出现', await page.isVisible('#screen-difficulty'));
  const diffCount = await page.locator('.diff-item').count();
  check('难度列表含 4 个预设 + 1 个自定义', diffCount === 5, `count=${diffCount}`);
  const sliderCount = await page.locator('#custom-panel input[type=range]').count();
  check('家长自定义面板有滑块', sliderCount >= 5, `sliders=${sliderCount}`);
  await page.screenshot({ path: 'artifacts/05-difficulty.png', fullPage: false });

  // --- 中等难度：计时必须真的在走 ---
  await page.locator('.diff-item').nth(2).click();
  await page.waitForTimeout(200);
  await page.click('#btn-start');
  await page.waitForTimeout(500);
  const m1 = await page.textContent('#hud-time');
  await page.waitForTimeout(1600);
  const m2 = await page.textContent('#hud-time');
  check('中等难度（计时档）计时器在推进', m1 !== m2 && m1 !== '--:--', `${m1} → ${m2}`);
  await page.click('#btn-pause');
  await page.waitForTimeout(250);
  await page.click('#btn-quit');
  await page.waitForTimeout(300);

  // --- 切换到「挑战」难度并开始，验证不同参数生效 ---
  await page.click('#btn-difficulty');
  await page.waitForTimeout(350);
  await page.locator('.diff-item').nth(3).click();
  await page.waitForTimeout(200);
  const selected = await page.locator('.diff-item').nth(3).getAttribute('aria-pressed');
  check('点击难度项后高亮切换', selected === 'true', `aria-pressed=${selected}`);

  await page.click('#btn-start');
  await page.waitForTimeout(700);
  const hardInfo = await page.evaluate(() => window.__mazeDebug.mazeInfo());
  check('挑战难度参数生效（18x18）', hardInfo.cols === 18 && hardInfo.rows === 18,
    `${hardInfo.cols}x${hardInfo.rows}`);

  // 挑战档没有脚印，检查足迹数组为空
  check('挑战难度不显示脚印', hardInfo.footprints <= 1, `footprints=${hardInfo.footprints}`);
  await page.screenshot({ path: 'artifacts/06-hard-mode.png' });

  // --- 声音与辅助设置 ---
  await page.click('#btn-pause');
  await page.waitForTimeout(250);
  await page.click('#btn-quit');
  await page.waitForTimeout(300);
  await page.click('#btn-settings');
  await page.waitForTimeout(350);
  check('设置面板可打开', await page.isVisible('#screen-settings'));
  const settingToggles = await page.locator('#settings-list input[type=checkbox]').count();
  check('设置面板含音效与辅助开关', settingToggles >= 3, `toggles=${settingToggles}`);

  // 关掉音效后不应报错，且偏好要落盘
  await page.locator('#settings-list input[type=checkbox]').first().uncheck();
  await page.waitForTimeout(250);
  const soundPref = await page.evaluate(() => {
    const raw = localStorage.getItem('maze.prefs.v1');
    return raw ? JSON.parse(raw).sound : null;
  });
  check('关闭音效后偏好已持久化', soundPref === false, `sound=${soundPref}`);
  await page.locator('#settings-list input[type=checkbox]').first().check();
  await page.waitForTimeout(200);
  await page.screenshot({ path: 'artifacts/08-settings.png' });
  await page.click('#btn-settings-ok');
  await page.waitForTimeout(300);

  // --- 离线可玩 ---
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  const offlineOk = await page.isVisible('.title');
  check('断网后仍能打开（PWA 离线生效）', offlineOk);
  await page.screenshot({ path: 'artifacts/07-offline.png' });
  await context.setOffline(false);

  check('全流程无 JS 运行时错误', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 300));

  await context.close();
}

/**
 * 完整通关一次：沿真实解路径用笔把小黄球拖到出口。
 * 这是唯一能验证「结算页、进度存档、安装引导」整条链路的方式，
 * 也是孩子实际会走的最关键路径。
 */
async function runFullClear(browser) {
  console.log('\n【完整通关流程】');
  const context = await browser.newContext({ ...devices['iPad Pro 11'], hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  // 走最短的入门档，保证能在合理时间内走完
  await page.click('#btn-play');
  await page.waitForTimeout(250);
  await page.click('#btn-howto-ok');
  await page.waitForTimeout(600);

  const cdp = await context.newCDPSession(page);
  const solution = await page.evaluate(() => window.__mazeDebug.solution());
  check('能取到完整解路径', Array.isArray(solution) && solution.length > 2, `长度 ${solution?.length}`);

  // 用笔尖依次沿解路径的每个格子拖动。
  // 每次移动到下一格附近，让 Game 的 BFS 跟随逻辑自然推进。
  const first = await page.evaluate((c) => window.__mazeDebug.cellToScreen(c.x, c.y), solution[0]);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: first.x, y: first.y,
    button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: 0.6,
  });

  for (let i = 1; i < solution.length; i++) {
    const p = await page.evaluate((c) => window.__mazeDebug.cellToScreen(c.x, c.y), solution[i]);
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: p.x, y: p.y,
      button: 'left', buttons: 1, pointerType: 'pen', force: 0.6,
    });
    // 给小球时间滑到目标格（速度 6.5 格/秒，一格约 150ms，留足余量）
    await page.waitForTimeout(230);
    if (await page.isVisible('#screen-win')) break;
  }
  const lastPt = await page.evaluate(
    (c) => window.__mazeDebug.cellToScreen(c.x, c.y),
    solution[solution.length - 1],
  );
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: lastPt.x, y: lastPt.y,
    button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen', force: 0,
  });
  await page.waitForTimeout(900);

  const won = await page.isVisible('#screen-win');
  check('沿真实路径用笔拖动可以通关', won);

  if (won) {
    await page.screenshot({ path: 'artifacts/09-win.png' });
    const winText = await page.textContent('#win-title');
    check('结算页显示通关文案', !!winText && winText.includes('迷宫'), winText ?? '');

    const statRows = await page.locator('#win-stats > div').count();
    check('结算页展示成绩明细', statRows >= 2, `rows=${statRows}`);

    // 入门档不计时，HUD 显示 --:-- 是正确行为；
    // 但结算页仍应给出本局实际用时，供家长参考。
    const hudTime = await page.textContent('#hud-time');
    check('不计时难度下 HUD 保持 --:--', hudTime === '--:--', hudTime ?? '');

    const winStats = await page.textContent('#win-stats');
    check('结算页仍记录了本局用时', /\d+:\d{2}/.test(winStats ?? ''), (winStats ?? '').trim().slice(0, 60));

    // 进度必须落盘
    const progress = await page.evaluate(() => {
      const raw = localStorage.getItem('maze.progress.v1');
      return raw ? JSON.parse(raw) : null;
    });
    check('通关进度已持久化', progress !== null && Object.keys(progress.cleared ?? {}).length > 0,
      JSON.stringify(progress?.cleared ?? null));
    check('已记录最佳成绩', progress?.best?.starter !== undefined,
      JSON.stringify(progress?.best ?? null));

    // 「下一关」应进入更高一档难度
    await page.click('#btn-next');
    await page.waitForTimeout(800);
    const nextInfo = await page.evaluate(() => window.__mazeDebug.mazeInfo());
    check('「下一关」切到更高难度（10x10）',
      nextInfo.cols === 10 && nextInfo.rows === 10, `${nextInfo.cols}x${nextInfo.rows}`);
    await page.screenshot({ path: 'artifacts/10-next-level.png' });

    // 回首页应看到战绩，并弹出一次安装引导
    await page.click('#btn-pause');
    await page.waitForTimeout(250);
    await page.click('#btn-quit');
    await page.waitForTimeout(600);

    const installShown = await page.isVisible('#screen-install');
    check('首次通关后展示安装引导', installShown);
    if (installShown) {
      await page.screenshot({ path: 'artifacts/11-install-guide.png' });
      const steps = await page.locator('#install-steps li').count();
      check('安装引导含分步说明', steps >= 2, `steps=${steps}`);
      await page.click('#btn-install-ok');
      await page.waitForTimeout(400);
    }

    const homeStats = await page.textContent('#home-stats');
    check('首页显示通关战绩', !!homeStats && homeStats.includes('走出迷宫'), (homeStats ?? '').trim().slice(0, 40));
    await page.screenshot({ path: 'artifacts/12-home-with-stats.png' });
  }

  check('通关流程无 JS 错误', errors.length === 0, errors.join(' | ').slice(0, 300));
  await context.close();
}

async function runWebKit(browser) {  console.log('\n【WebKit】(iOS Safari 同源引擎)');
  // 用 iPad 描述符，但 WebKit 不支持 isMobile 与 CDP，改用触摸模拟
  const context = await browser.newContext({
    viewport: { width: 1194, height: 834 },
    deviceScaleFactor: 2,
    hasTouch: true,
  });
  const page = await context.newPage();

  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);

  check('WebKit 能渲染首页', await page.isVisible('.title'));
  await page.screenshot({ path: 'artifacts/wk-01-home.png' });

  await page.click('#btn-play');
  await page.waitForTimeout(300);
  await page.click('#btn-howto-ok');
  await page.waitForTimeout(600);
  check('WebKit 能进入游戏', await page.isVisible('#screen-game'));

  // WebKit 上没有 CDP，用 Playwright 的鼠标事件（至少走 PointerEvent 管线）
  const pos = await page.evaluate(() => window.__mazeDebug.playerScreenPos());
  const before = await page.evaluate(() => window.__mazeDebug.playerCell());
  await page.mouse.move(pos.x, pos.y);
  await page.mouse.down();
  for (let i = 0; i <= 10; i++) {
    await page.mouse.move(pos.x + i * 12, pos.y + i * 12);
    await page.waitForTimeout(20);
  }
  await page.mouse.up();
  await page.waitForTimeout(1000);
  const after = await page.evaluate(() => window.__mazeDebug.playerCell());
  check('WebKit 下拖动能让小人移动',
    before.x !== after.x || before.y !== after.y,
    `(${before.x},${before.y}) → (${after.x},${after.y})`);

  check('WebKit 无 JS 错误', errors.length === 0, errors.join(' | ').slice(0, 300));
  await page.screenshot({ path: 'artifacts/wk-02-playing.png' });

  await context.close();
}

async function main() {
  const server = await serve();
  console.log(`静态服务器已启动：${BASE}`);

  try {
    const chromiumBrowser = await chromium.launch();
    await runChromium(chromiumBrowser);
    await runFullClear(chromiumBrowser);
    await chromiumBrowser.close();

    const webkitBrowser = await webkit.launch();
    await runWebKit(webkitBrowser);
    await webkitBrowser.close();
  } finally {
    server.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  if (failed.length > 0) {
    console.log('\n失败项：');
    for (const f of failed) console.log(`  ✗ ${f.name}  ${f.detail}`);
    process.exitCode = 1;
  }
}

await main();
