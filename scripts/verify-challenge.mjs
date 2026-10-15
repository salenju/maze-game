/**
 * 大师档四项新机制的真实浏览器验收（Chromium + 真实 pen 事件）。
 *
 * 为什么这四项必须上真浏览器：
 *   视野迷雾 —— 一半是渲染（遮罩有没有真的把像素画暗），单元测试看不到像素；
 *   假出口   —— 「走到跟前才识破」依赖真实的连续拖动；
 *   巡逻怪   —— 逐帧位移与碰撞判定只有跑主循环才成立；
 *   限时失败 —— 依赖 rAF 累加与页面流转，纯逻辑测试覆盖不到。
 *
 * 同时锁住反向约束：低龄三档与挑战档**不得**被新机制波及。
 */

import { chromium, devices } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../dist', import.meta.url));
const PORT = 4193;
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
const check = (n, ok, d = '') => {
  results.push({ n, ok, d });
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${d ? `  — ${d}` : ''}`);
};

/** 用笔沿给定格坐标序列持续拖动（必须持续移动，否则前进额度用尽会停）。 */
async function dragAlong(page, cdp, cells, holdMs = 180) {
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
  await page.waitForTimeout(250);
}

/**
 * 一笔一段地把笔尖带到目标格。
 *
 * 必须分段：目标可能隔着几十格，一口气按住划过去会撞上防作弊额度，
 * 中途还可能被巡逻怪送回起点 —— 每段之后重新取一次真实路线才是自洽的。
 * 返回是否真的到达。
 */
async function walkTo(page, cdp, target, maxSegments = 120, chunk = 6) {
  for (let i = 0; i < maxSegments; i++) {
    const route = await page.evaluate((t) => {
      const cur = window.__mazeDebug.playerCell();
      if (cur.x === t.x && cur.y === t.y) return null;
      return window.__mazeDebug.routeTo(t.x, t.y);
    }, target);
    if (route === null) return true;
    if (route.length < 2) return false;
    await dragAlong(page, cdp, route.slice(0, Math.min(chunk + 1, route.length)), 240);
  }
  return false;
}

/** 按 data-field 名设置滑块（触发的就是真实拖动会触发的那套事件）。 */
async function setRange(page, key, value) {
  await page.locator(`input[data-field="${key}"]`).evaluate((el, v) => {
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  await page.waitForTimeout(120);
}

/** 按标签文字切换一个开关。 */
async function setToggle(page, labelText, on) {
  await page.locator('.field').filter({ hasText: labelText })
    .locator('input[type="checkbox"]').first()
    .evaluate((el, v) => {
      el.checked = v;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, on);
  await page.waitForTimeout(120);
}

/** 打开难度页并选中指定档位（按 data-diff-id，不依赖列表位置）。 */
async function pickDifficulty(page, diffId) {
  await page.click('#btn-difficulty');
  await page.waitForTimeout(300);
  await page.locator(`.diff-item[data-diff-id="${diffId}"]`).click();
  await page.waitForTimeout(150);
  await page.click('#btn-start');
  await page.waitForTimeout(700);
}

/** 采样画布上某个 CSS 像素块的平均亮度（坐标相对画布左上角）。 */
async function blockLuma(page, cx, cy, size = 6) {
  return page.evaluate(({ cx, cy, size }) => {
    const cv = document.querySelector('#maze-canvas');
    const ctx = cv.getContext('2d');
    const r = cv.getBoundingClientRect();
    const dpr = cv.width / r.width;
    const sx = Math.max(0, Math.round((cx - size / 2) * dpr));
    const sy = Math.max(0, Math.round((cy - size / 2) * dpr));
    const w = Math.max(1, Math.min(Math.round(size * dpr), cv.width - sx));
    const h = Math.max(1, Math.min(Math.round(size * dpr), cv.height - sy));
    const d = ctx.getImageData(sx, sy, w, h).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
    return sum / (d.length / 4);
  }, { cx, cy, size });
}

/**
 * 一整格（含四边墙线）里最亮的那个像素。
 *
 * 为什么不能只采样格心：墙画在格子边界上，还带发光。
 * 只测格心的地板亮度，会漏掉「迷雾透光把整张墙结构显出来」这种缺陷 ——
 * 而这正是实测时真的出现过的问题（0.97 透明度下整张迷宫轮廓清晰可辨）。
 */
async function cellMaxLuma(page, x, y) {
  return page.evaluate(({ x, y }) => {
    const cv = document.querySelector('#maze-canvas');
    const ctx = cv.getContext('2d');
    const r = cv.getBoundingClientRect();
    const dpr = cv.width / r.width;
    const cell = window.__mazeDebug.mazeInfo().cell;
    const c = window.__mazeDebug.cellToScreen(x, y);
    // cellToScreen 给的是格心；往回退半格即左上角，再换算成画布坐标
    const left = c.x - r.left - cell / 2;
    const top = c.y - r.top - cell / 2;
    const sx = Math.max(0, Math.round(left * dpr));
    const sy = Math.max(0, Math.round(top * dpr));
    const w = Math.max(1, Math.min(Math.round(cell * dpr), cv.width - sx));
    const h = Math.max(1, Math.min(Math.round(cell * dpr), cv.height - sy));
    const d = ctx.getImageData(sx, sy, w, h).data;
    let max = 0;
    for (let i = 0; i < d.length; i += 4) {
      max = Math.max(max, (d[i] + d[i + 1] + d[i + 2]) / 3);
    }
    return max;
  }, { x, y });
}

/** 把格坐标换算成「相对画布左上角」的 CSS 坐标。 */
async function cellLuma(page, x, y) {
  const p = await page.evaluate(({ x, y }) => {
    const r = document.querySelector('#maze-canvas').getBoundingClientRect();
    const s = window.__mazeDebug.cellToScreen(x, y);
    return { x: s.x - r.left, y: s.y - r.top };
  }, { x, y });
  return blockLuma(page, p.x, p.y, 6);
}

/** 走到目标格的**相邻一格**就停下（用来在触发前观察它的样子）。 */
async function walkToAdjacent(page, cdp, target, maxSegments = 120, chunk = 6) {
  for (let i = 0; i < maxSegments; i++) {
    const route = await page.evaluate((t) => window.__mazeDebug.routeTo(t.x, t.y), target);
    if (route.length <= 2) return true;
    await dragAlong(page, cdp, route.slice(0, Math.min(chunk + 1, route.length - 1)), 240);
  }
  return false;
}

/** 一整格里最大的「绿色占优度」(g-r)，用来区分绿门与灰叉。 */
async function cellGreen(page, x, y) {
  return page.evaluate(({ x, y }) => {
    const cv = document.querySelector('#maze-canvas');
    const ctx = cv.getContext('2d');
    const r = cv.getBoundingClientRect();
    const dpr = cv.width / r.width;
    const cell = window.__mazeDebug.mazeInfo().cell;
    const c = window.__mazeDebug.cellToScreen(x, y);
    const sx = Math.max(0, Math.round((c.x - r.left - cell / 2) * dpr));
    const sy = Math.max(0, Math.round((c.y - r.top - cell / 2) * dpr));
    const w = Math.max(1, Math.min(Math.round(cell * dpr), cv.width - sx));
    const h = Math.max(1, Math.min(Math.round(cell * dpr), cv.height - sy));
    const d = ctx.getImageData(sx, sy, w, h).data;
    let max = -255;
    for (let i = 0; i < d.length; i += 4) max = Math.max(max, d[i + 1] - d[i]);
    return max;
  }, { x, y });
}

/** 找一格「既看不见、也从未走过」的格子 —— 迷雾最深处，用来当亮度下限。 */
async function darkestCell(page) {
  return page.evaluate(() => {
    const m = window.__mazeDebug.mazeInfo();
    for (let y = 0; y < m.rows; y++) {
      for (let x = 0; x < m.cols; x++) {
        if (!window.__mazeDebug.isVisible(x, y) && !window.__mazeDebug.isVisited(x, y)) {
          return { x, y };
        }
      }
    }
    return null;
  });
}

// ---------- 1. 大师档：四项机制全开 ----------
{
  console.log('\n【1】大师档：视野迷雾 / 假出口 / 巡逻怪 / 限时');
  const ctx = await browser.newContext({ ...devices['iPad Pro 11'], hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await pickDifficulty(page, 'master');

  const c0 = await page.evaluate(() => window.__mazeDebug.challenge());
  check('大师档视野半径为 4 格', c0.viewRadius === 4, `viewRadius=${c0.viewRadius}`);
  check('大师档放了 2 个假出口', c0.fakeExitCells.length === 2,
    `假门=${JSON.stringify(c0.fakeExitCells)}`);
  check('大师档有 2 只巡逻怪', c0.guards === 2, `怪=${c0.guards}`);
  check('大师档是限时的', c0.timeLeft !== null && c0.timeLeft > 0, `剩余=${c0.timeLeft}`);
  check('迷雾确实在遮：可见格远少于总格数',
    c0.visibleCells < c0.mazeCells * 0.35,
    `可见 ${c0.visibleCells} / ${c0.mazeCells} 格`);

  const hudTime = await page.textContent('#hud-time');
  check('HUD 显示的是倒计时（不是用时、也不是 --:--）',
    /^\d+:\d\d$/.test(hudTime.trim()), `#hud-time=${hudTime}`);

  // 像素证据：小球所在格必须明显亮于「从未去过的深处」。
  // 这里用 darkestCell 而不是随便挑一格 —— 它同时保证了「在形状内、且没走过」。
  const playerCell = await page.evaluate(() => window.__mazeDebug.playerCell());
  const seenLuma = await cellLuma(page, playerCell.x, playerCell.y);
  const dark = await darkestCell(page);
  let darkLuma = -1;
  if (dark) {
    darkLuma = await cellLuma(page, dark.x, dark.y);
    check('看不见且没走过的格子确实被画暗（迷雾真的生效）',
      darkLuma < seenLuma - 12,
      `小球处 ${seenLuma.toFixed(1)} vs 未探索处 ${darkLuma.toFixed(1)}`);
  } else {
    check('看不见且没走过的格子确实被画暗（迷雾真的生效）', false, '找不到未探索格');
  }

  // 出口一定在形状内、开局一定在 4 步视野之外 → 必须是全黑的
  const sol = await page.evaluate(() => window.__mazeDebug.solution());
  const exitCell = sol[sol.length - 1];
  const exitVisible = await page.evaluate(
    (c) => window.__mazeDebug.isVisible(c.x, c.y), exitCell);
  const exitLuma = await cellLuma(page, exitCell.x, exitCell.y);
  check('开局看不见出口（迷雾挡住远方）', exitVisible === false, `visible=${exitVisible}`);
  check('看不见的出口是全黑的', exitLuma < seenLuma - 12,
    `小球处 ${seenLuma.toFixed(1)} vs 出口处 ${exitLuma.toFixed(1)}`);

  // 巡逻怪会动
  const guardsA = await page.evaluate(() => window.__mazeDebug.challenge().guardCells);
  await page.waitForTimeout(1500);
  const guardsB = await page.evaluate(() => window.__mazeDebug.challenge().guardCells);
  const guardMoved = guardsA.some((a, i) => {
    const b = guardsB[i];
    return b && (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) > 0);
  });
  check('巡逻怪在移动', guardMoved, `${JSON.stringify(guardsA)} → ${JSON.stringify(guardsB)}`);

  // 假门一律不在解路径上
  const onRoute = new Set(sol.map((c) => `${c.x},${c.y}`));
  const fakeOnRoute = c0.fakeExitCells.filter((c) => onRoute.has(`${c.x},${c.y}`));
  check('假门都不在解路径上（正路上放假门等于游戏坏了）',
    fakeOnRoute.length === 0, `落在正路上的假门=${JSON.stringify(fakeOnRoute)}`);

  await page.screenshot({ path: 'artifacts/master-fog.png' });
  check('大师档无 JS 错误', errors.length === 0, errors.join(' | ').slice(0, 300));
  await ctx.close();
}

// ---------- 2. 假出口 + 视野记忆（自定义档，隔离变量：方迷宫、无怪） ----------
{
  console.log('\n【2】假出口与视野记忆（自定义档：12×12 方迷宫、无怪）');
  const ctx = await browser.newContext({ ...devices['iPad Pro 11'], hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.click('#btn-difficulty');
  await page.waitForTimeout(300);
  await page.locator('.diff-item[data-diff-id="custom"]').click();
  await page.waitForTimeout(200);
  await setRange(page, 'cols', 12);
  await setRange(page, 'rows', 12);
  await setRange(page, 'fakeExits', 2);
  await setRange(page, 'guards', 0);
  await setToggle(page, '视野迷雾', true);
  await setRange(page, 'viewRadius', 4);
  await page.click('#btn-start');
  await page.waitForTimeout(700);

  const c0 = await page.evaluate(() => window.__mazeDebug.challenge());
  check('自定义档按设置放出 2 个假门', c0.fakeExitCells.length === 2,
    `假门=${JSON.stringify(c0.fakeExitCells)}`);
  check('自定义档没有巡逻怪（隔离变量）', c0.guards === 0, `guards=${c0.guards}`);
  check('自定义档按设置开了视野迷雾', c0.viewRadius === 4, `viewRadius=${c0.viewRadius}`);
  check('开局时没有任何假门被识破', c0.fakeExitsFound === 0, `found=${c0.fakeExitsFound}`);

  const startCell = await page.evaluate(() => window.__mazeDebug.playerCell());
  const cdp = await ctx.newCDPSession(page);

  // 先在**触发之前**站到假门旁边，看看它长什么样：必须是完整的一扇绿门
  const fake = c0.fakeExitCells[0];
  const approached = await walkToAdjacent(page, cdp, fake);
  const greenBefore = await cellGreen(page, fake.x, fake.y);
  await page.screenshot({ path: 'artifacts/master-fake-door.png' });
  check('触发前的假门与真门一样是绿色（能被一眼认出就不叫假门了）',
    greenBefore > 50, `绿色占优度=${greenBefore.toFixed(1)}`);

  // 最后一步踩上去
  const reached = await walkTo(page, cdp, fake);
  await page.waitForTimeout(300);

  const c1 = await page.evaluate(() => window.__mazeDebug.challenge());
  const at = await page.evaluate(() => window.__mazeDebug.playerCell());
  const greenAfter = await cellGreen(page, fake.x, fake.y);
  check('能真的走到假门口（假门不是不可达的摆设）', approached && reached, `到达=${reached}`);
  check('走到假门会被记成「已识破」', c1.fakeExitsFound >= 1,
    `已识破 ${c1.fakeExitsFound}/${c1.fakeExitCells.length}`);
  check('撞假门不会通关', c1.phase === 'playing', `phase=${c1.phase}`);
  check('撞假门不会被送回起点（只是「此路不通」）',
    !(at.x === startCell.x && at.y === startCell.y),
    `当前位置 (${at.x},${at.y})，起点 (${startCell.x},${startCell.y})`);
  check('识破之后假门变成灰叉（孩子不用反复试同一个坑）',
    greenAfter < 35, `绿色占优度 ${greenBefore.toFixed(1)} → ${greenAfter.toFixed(1)}`);

  // 起点已经走远、离开视野，但必须比「从未去过的地方」亮
  const startVisible = await page.evaluate(
    (c) => window.__mazeDebug.isVisible(c.x, c.y), startCell);
  const startVisited = await page.evaluate(
    (c) => window.__mazeDebug.isVisited(c.x, c.y), startCell);
  const startLuma = await cellLuma(page, startCell.x, startCell.y);
  const dark = await darkestCell(page);
  const darkLuma = dark ? await cellLuma(page, dark.x, dark.y) : -1;
  check('起点已经离开视野但仍是「去过」的（记忆生效）',
    startVisible === false && startVisited === true && startLuma > darkLuma + 6,
    `起点可见=${startVisible} 去过=${startVisited} 亮度 ${startLuma.toFixed(1)} vs 未探索 ${darkLuma.toFixed(1)}`);

  // ── 迷雾绝不透光 ──
  // 这是实测踩过的坑：墙带发光，迷雾若留 3% 透光，整张迷宫的墙结构会隐约浮现，
  // 孩子能直接描出没去过的地方。要求「既看不见又没走过」的整格（含墙线）
  // 连最亮的像素也不能超过一个很低的阈值。
  const deepCells = await page.evaluate(() => {
    const m = window.__mazeDebug.mazeInfo();
    const out = [];
    for (let y = 0; y < m.rows && out.length < 12; y++) {
      for (let x = 0; x < m.cols && out.length < 12; x++) {
        if (!window.__mazeDebug.isVisible(x, y) && !window.__mazeDebug.isVisited(x, y)) {
          out.push({ x, y });
        }
      }
    }
    return out;
  });
  let worst = 0;
  let worstAt = '';
  for (const c of deepCells) {
    const m = await cellMaxLuma(page, c.x, c.y);
    if (m > worst) {
      worst = m;
      worstAt = `(${c.x},${c.y})`;
    }
  }
  check('未探索区域的整格（含墙线）都是全黑的，墙结构不会透出来',
    deepCells.length > 0 && worst < 30,
    `${deepCells.length} 格中最高亮度 ${worst.toFixed(1)} @${worstAt}`);

  await page.screenshot({ path: 'artifacts/master-fake-exit.png' });
  check('假门与迷雾场景无 JS 错误', errors.length === 0, errors.join(' | ').slice(0, 200));
  await ctx.close();
}

// ---------- 3. 挑战档：只加限时，不加任何新机制 ----------
{
  console.log('\n【3】挑战档：只加限时，不加迷雾/假门/怪');
  const ctx = await browser.newContext({ ...devices['iPad Pro 11'], hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await pickDifficulty(page, 'hard');

  const c = await page.evaluate(() => window.__mazeDebug.challenge());
  check('挑战档不限视野（全图可见）', c.viewRadius === null, `viewRadius=${c.viewRadius}`);
  check('挑战档没有假门', c.fakeExitCells.length === 0, `假门=${c.fakeExitCells.length}`);
  check('挑战档没有巡逻怪', c.guards === 0, `怪=${c.guards}`);
  check('挑战档是限时的', c.timeLeft !== null && c.timeLeft > 60, `剩余=${c.timeLeft}`);

  const hud = await page.textContent('#hud-time');
  check('挑战档 HUD 显示倒计时', /^\d+:\d\d$/.test(hud.trim()), `#hud-time=${hud}`);
  await ctx.close();
}

// ---------- 4. 低龄档完全不受影响 ----------
{
  console.log('\n【4】入门档：新机制一律不生效（对 6 岁零影响）');
  const ctx = await browser.newContext({ ...devices['iPad Pro 11'], hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await pickDifficulty(page, 'starter');

  const c = await page.evaluate(() => window.__mazeDebug.challenge());
  check('入门档全图可见', c.viewRadius === null, `viewRadius=${c.viewRadius}`);
  check('入门档可见格 = 全部迷宫格', c.visibleCells === c.mazeCells,
    `${c.visibleCells}/${c.mazeCells}`);
  check('入门档没有假门与怪',
    c.fakeExitCells.length === 0 && c.guards === 0,
    `假门=${c.fakeExitCells.length} 怪=${c.guards}`);
  check('入门档没有倒计时', c.timeLeft === null, `timeLeft=${c.timeLeft}`);

  const hud = await page.textContent('#hud-time');
  check('入门档 HUD 显示 --:--', hud.trim() === '--:--', `#hud-time=${hud}`);
  await ctx.close();
}

// ---------- 5. 限时耗尽 → 失败页（自定义档压到最短 60 秒） ----------
{
  console.log('\n【5】限时耗尽 → 失败页（自定义档，限时压到最短 60 秒）');
  const ctx = await browser.newContext({ ...devices['iPad Pro 11'], hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });

  await page.click('#btn-difficulty');
  await page.waitForTimeout(300);
  await page.locator('.diff-item[data-diff-id="custom"]').click(); // 先选中自定义，改动才落到本局
  await page.waitForTimeout(200);
  await setToggle(page, '限时通关', true);
  await setRange(page, 'timeLimitSec', 60);
  await page.click('#btn-start');
  await page.waitForTimeout(700);

  const before = await page.evaluate(() => window.__mazeDebug.challenge());
  check('自定义档按设置开启了限时',
    before.timeLeft !== null && before.timeLeft <= 60, `剩余=${before.timeLeft}`);

  // 什么都不做，等倒计时归零（留 6 秒容差）
  await page.waitForTimeout(66_000);

  const after = await page.evaluate(() => window.__mazeDebug.challenge());
  check('倒计时归零后进入失败状态', after.phase === 'lost', `phase=${after.phase}`);

  const loseVisible = await page.locator('#screen-lose').getAttribute('data-active');
  check('失败页被显示出来', loseVisible === 'true', `data-active=${loseVisible}`);

  const stats = (await page.textContent('#lose-stats')) ?? '';
  check('失败页列出了本局数据', stats.includes('探索'), stats.replace(/\s+/g, ' ').slice(0, 90));
  const lead = (await page.textContent('#lose-lead')) ?? '';
  check('失败页说明「再试一次还是同一张地图」',
    lead.includes('同一张地图'), lead.slice(0, 60));

  await page.screenshot({ path: 'artifacts/master-lose.png' });

  await page.click('#btn-lose-retry');
  await page.waitForTimeout(800);
  const retry = await page.evaluate(() => window.__mazeDebug.challenge());
  const gameVisible = await page.locator('#screen-game').getAttribute('data-active');
  check('「再试一次」能重新开局', retry.phase === 'playing' && gameVisible === 'true',
    `phase=${retry.phase} screen=${gameVisible}`);
  await ctx.close();
}

await browser.close();
server.close();

const f = results.filter((r) => !r.ok);
console.log(`\n大师档机制验收：${results.length} 项，异常 ${f.length} 项`);
for (const x of f) console.log(`  ✗ ${x.n}  ${x.d}`);
if (f.length) process.exitCode = 1;
