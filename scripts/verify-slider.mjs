/**
 * 针对「家长自定义滑块」的专项验证。
 *
 * 怀疑的缺陷：滑块每次 input 都会触发 renderCustomPanel()，
 * 而它内部调用 container.replaceChildren() 把整个面板（含正在拖动的滑块）删掉重建。
 * 如果这个怀疑成立，家长拖动滑块时只能挪动一格就断掉，
 * 自定义难度基本不可用 —— 这是必须在交付前查清的问题。
 */

import { chromium, devices } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../dist', import.meta.url));
const PORT = 4179;
const BASE = `http://127.0.0.1:${PORT}/maze-game/`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

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
  return new Promise((r) => server.listen(PORT, '127.0.0.1', () => r(server)));
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  — ${detail}` : ''}`);
}

const server = await serve();
const browser = await chromium.launch();
const context = await browser.newContext({ ...devices['iPad Pro 11'], hasTouch: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.click('#btn-difficulty');
await page.waitForTimeout(500);

// 先选中「自定义」，让滑块的改动真正生效
await page.locator('[data-diff-id="custom"]').click();
await page.waitForTimeout(300);

// 按 data-field 定位：以前用 first()/nth() 依赖滑块顺序，
// 新增「岔路数量」后顺序变了，位置定位会静默地改错控件。
const widths = () => page.locator('#custom-panel input[data-field="cols"]');
const slider = widths();
const box = await slider.boundingBox();
check('找到宽度滑块', !!box, box ? `${Math.round(box.width)}x${Math.round(box.height)}` : 'none');

const before = await slider.inputValue();

// 模拟家长用笔/手指按住滑块往右持续拖动。
// 关键：中途跨越多帧移动，而不是一次性 set，才能暴露「拖动被打断」的问题。
await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2);
await page.mouse.down();
const steps = 12;
for (let i = 1; i <= steps; i++) {
  await page.mouse.move(
    box.x + box.width * (0.3 + (0.5 * i) / steps),
    box.y + box.height / 2,
  );
  await page.waitForTimeout(30);
}
await page.mouse.up();
await page.waitForTimeout(300);

const after = await widths().inputValue();
const delta = Number(after) - Number(before);
check(
  '拖动滑块能连续改变数值（不会被重建打断）',
  delta >= 3,
  `宽度 ${before} → ${after}（变化 ${delta}，需 ≥3 才算连续可拖）`,
);

// 滑块必须仍然是同一个「活着」的元素，并且还能继续操作
const stillWorks = await widths().isVisible();
check('拖动后滑块仍可交互', stillWorks);

// 用键盘再验证一次：能连续响应说明元素没有被反复替换掉焦点
const afterDrag = await widths().inputValue();
await widths().focus();
for (let i = 0; i < 3; i++) {
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(60);
}
const afterKeys = await widths().inputValue();
check(
  '滑块能用方向键连续调整',
  Number(afterKeys) > Number(afterDrag),
  `${afterDrag} → ${afterKeys}`,
);

// 自定义值必须落盘
const stored = await page.evaluate(() => {
  const raw = localStorage.getItem('maze.custom.v1');
  return raw ? JSON.parse(raw) : null;
});
check('自定义难度已持久化到 localStorage', stored !== null && stored.cols === Number(afterKeys),
  JSON.stringify(stored));

// 用自定义难度开局，确认参数真的被采用
await page.click('#btn-start');
await page.waitForTimeout(700);
const info = await page.evaluate(() => window.__mazeDebug.mazeInfo());
check('用自定义难度开局时参数生效', info.cols === Number(afterKeys),
  `迷宫 ${info.cols}x${info.rows}，期望 cols=${afterKeys}`);

check('滑块交互无 JS 报错', errors.length === 0, errors.join(' | ').slice(0, 200));

// --- 关键回归：连续调整多个滑块时，先改的值不能被后改的覆盖 ---
// 每个滑块的 onChange 都闭包捕获了一份 custom 快照；若实现不当，
// 调整高度会把宽度回退成旧值，家长会看到「拖了没保存」。
await page.click('#btn-settings-ok').catch(() => {});
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.click('#btn-difficulty');
await page.waitForTimeout(450);
await page.locator('[data-diff-id="custom"]').click();
await page.waitForTimeout(300);

const field = (name) => page.locator(`#custom-panel input[data-field="${name}"]`);
await field('cols').fill('20');
await page.waitForTimeout(220);
await field('rows').fill('22');
await page.waitForTimeout(220);
await field('braid').fill('70');
await page.waitForTimeout(220);

const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('maze.custom.v1')));
check(
  '连续调整多个滑块时前面的值不会被回退',
  persisted.cols === 20 && persisted.rows === 22,
  `cols=${persisted.cols}（期望 20） rows=${persisted.rows}（期望 22） braid=${persisted.braid}`,
);
check('环路滑块改动也已保存', Math.abs(persisted.braid - 0.7) < 0.001, `braid=${persisted.braid}`);

// 界面上的滑块位置也要与持久化值一致，否则家长看到的是错的值
const uiCols = await field('cols').inputValue();
check('界面滑块位置与已保存值一致', Number(uiCols) === persisted.cols,
  `界面 cols=${uiCols}，存储 cols=${persisted.cols}`);

await context.close();
await browser.close();
server.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
if (failed.length) {
  for (const f of failed) console.log(`  ✗ ${f.name}  ${f.detail}`);
  process.exitCode = 1;
}
