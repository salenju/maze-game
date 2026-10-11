# 迷宫大冒险（Maze Game）

为 **6-10 岁小朋友**设计的触控笔迷宫游戏。在安卓 / iOS 平板上通过浏览器打开，可安装成 PWA，**支持离线游玩**。

线上地址：**https://salenju.github.io/maze-game/**

---

## 给孩子怎么玩

1. 用笔尖（或手指）**按住小黄球**。
2. 把笔尖移到想去的方向，小黄球会**顺着走廊滑过去**。
3. 球只会走路、**不会穿墙**，所以慢一点也没关系。
4. 走到右下角的绿色小门就算走出迷宫。

> 出于安全考虑，小黄球不会「点一下远处就自动走过去」——必须一直按住并带着它走。
> 这样孩子始终在操作，迷宫不会被变成自动寻路。

## 难度设计

难度由 5 个相互独立的维度组成，覆盖整个 6-10 岁跨度：

| 档位 | 建议年龄 | 迷宫 | 环路 | 脚印 | 计时 | 星星 |
|---|---|---|---|---|---|---|
| 入门 | 5-6 岁 | 7×7 | 多（0.6） | 一直显示 | 无 | 无 |
| 简单 | 6-7 岁 | 10×10 | 较多（0.45） | 一直显示 | 无 | 无 |
| 中等 | 8-9 岁 | 14×14 | 适中（0.25） | 6 秒淡出 | 有 | 3 颗 |
| 挑战 | 9-10 岁 | 18×18 | 少（0.08） | 无 | 有 | 5 颗 |
| 自定义 | 家长 | 6-24 格 | 可调 | 三选一 | 可开关 | 0-8 颗 |

**关于「环路」这个参数，请注意方向**：环路越多 → 死胡同越少 → 走错了更容易绕回来 → **迷宫越简单**。
所以它和尺寸的方向是相反的。代码里 `braid` 值的语义也是「越大越简单」，并有专门的测试锁住这个方向性，防止以后被改反。

星星**不是通关条件**，只是奖励。走到出口就算赢——否则孩子会在出口前被莫名拦住，那是最典型的挫败点。

## 家长设置

- **难度设置** → 家长自定义：迷宫宽高、环路数量、脚印模式、计时开关、星星数量、是否给提示箭头。
- **声音与辅助**：音效开关、高亮走廊（把可走的路淡淡显示出来，适合第一次玩迷宫的孩子）。

所有进度只存在本机 `localStorage`，**没有账号、没有任何网络上传**。

---

## 技术方案

| 项目 | 选择 | 原因 |
|---|---|---|
| 构建 | Vite 8 + TypeScript 7（strict） | 产物小、冷启动快 |
| 渲染 | Canvas 2D | 20×20 网格全量重绘开销可忽略，且支持 `devicePixelRatio` |
| UI | 原生 DOM，无框架 | 打包 JS 仅约 13 KB（gzip），离线缓存极小 |
| 生成算法 | 递归回溯 + 编织（braid） | 走廊蜿蜒，比 Prim/Kruskal 更适合儿童 |
| 寻路 | BFS | 用于移动路径与提示箭头 |
| 音效 | WebAudio 实时合成 | 零音频文件，不占缓存 |
| PWA | vite-plugin-pwa（Workbox） | 预缓存 app shell，`autoUpdate` 自动更新 |
| 部署 | GitHub Actions → Pages | 构建产物不进版本库 |

### 触控笔是怎么支持的

Apple Pencil 和 S Pen 在浏览器里就是标准 **Pointer Events**（`pointerType === 'pen'`），
不需要任何特殊 API、权限或原生插件。关键在于把干扰项全部排除：

- `touch-action: none` + `overscroll-behavior: none`：**这是「笔拖动没反应」的头号原因**——
  不设置的话浏览器会把笔画当成滚动或缩放，游戏根本收不到事件。
- `setPointerCapture`：笔尖滑出画布再滑回来不会断线。
- **掌拒**：检测到笔按下后，忽略所有 `touch` 指针。孩子写字时手掌必然压屏，不处理会抖动抢控制权。
- `getCoalescedEvents()`：Chromium 上取回被浏览器合并掉的高频采样点，轨迹更贴手。
  **Safari 不支持此 API**，代码有降级分支，功能不受影响。
- 禁用双击缩放与长按选中菜单。

### 移动模型：为什么不直接用像素碰撞

不做像素级碰撞，而是「指针位置 → 目标格 → BFS 求路径 → 沿路径匀速滑行」：

- 结构上**不可能穿墙**（路径只在走廊上走），不需要调碰撞盒参数；
- 不会抖动或卡在墙角（格子图是离散的，没有胶着状态）；
- 指针落在墙上时小球会**沿走廊绕过去**，而不是卡死或抖动。

代价是球不会完全贴住笔尖，而是沿合法路径追赶——这正是「被墙约束」的手感来源。

---

## 本地开发

```bash
npm install
npm run dev:host     # 真机在同一局域网内访问电脑 IP，用真笔实测
npm run build        # 类型检查 + 构建
npm run preview      # 预览构建产物
npm test             # 43 项单元测试
npm run typecheck
```

### 验证脚本

```bash
node scripts/generate_icons.py   # 重新生成 PWA 图标（需 Pillow）
node scripts/verify.mjs          # 真浏览器验收：笔事件 / PWA / 离线 / 双引擎
node scripts/verify-slider.mjs   # 家长自定义滑块专项验证
```

`verify.mjs` 覆盖 35 项检查，包括：

- 通过 CDP 发送**真正的 `pointerType: 'pen'` 事件**（Playwright 的 mouse API 只能产生鼠标事件，测不到笔的代码路径）；
- 用 **WebKit 引擎**（Safari 同源）验证 iOS 侧行为；
- 画布按 `devicePixelRatio` 缩放、拖动后页面不滚动不缩放；
- Service Worker 注册、断网后仍可打开；
- 暂停/继续后**画笔仍然有效**（曾出现过此处丢输入挂载的严重缺陷）。

### 部署

推送到 `main` 即自动构建发布。**首次需要在仓库网页上做一次设置**：

> `Settings` → `Pages` → `Build and deployment` → `Source` 选择 **GitHub Actions**

---

## 已知平台限制（不是缺陷，是 iOS 的限制）

| 限制 | 影响 | 应对 |
|---|---|---|
| iOS 不读 manifest 的 `orientation` | **无法锁定横屏** | 布局做了横竖屏双向适配 |
| iOS 没有安装提示 API | 只能手动「分享 → 添加到主屏幕」 | 首次通关后给出图示化步骤引导 |
| Safari 不支持 `getCoalescedEvents()` | 笔迹采样密度略低 | 已降级，对迷宫判定无影响 |
| iOS Safari 不支持元素级全屏 | 用 standalone 模式代替 | 添加到主屏幕后即为全屏 |
| 无 `Vibration API`（iOS） | 撞墙无震动 | 改用音效反馈 |

---

## 项目结构

```
├─ index.html                  # 各屏幕静态结构 + iOS PWA meta
├─ vite.config.ts              # base=/maze-game/ + PWA 清单与预缓存
├─ public/icons/               # 192 / 512 / maskable / apple-touch
├─ scripts/
│  ├─ generate_icons.py        # 图标生成（含 maskable 安全边距）
│  ├─ verify.mjs               # 真浏览器验收
│  └─ verify-slider.mjs        # 滑块交互专项验证
├─ src/
│  ├─ main.ts                  # 入口：屏幕流转、主循环、事件绑定
│  ├─ core/
│  │  ├─ rng.ts                # 可播种随机数（同种子=同迷宫）
│  │  ├─ maze.ts               # 生成 / 编织 / BFS / 星星放置
│  │  └─ difficulty.ts         # 难度模型与家长自定义
│  ├─ game/
│  │  ├─ game.ts               # 状态机、移动、通关判定
│  │  ├─ renderer.ts           # Canvas 2D 绘制
│  │  ├─ input.ts              # Pointer Events 封装
│  │  ├─ audio.ts              # WebAudio 合成音效
│  │  └─ storage.ts            # 进度与偏好持久化
│  └─ ui/
│     ├─ screens.ts            # 屏幕管理与面板渲染
│     └─ styles.css            # 平板优先、safe-area、禁手势
└─ .github/workflows/deploy.yml
```

## 设计上刻意做的取舍

- **同一种子可复现**：「重玩本关」永远是同一张迷宫，孩子失败后能带着记忆重来，不被随机性惩罚；「下一关」才换新迷宫。
- **切后台自动暂停**：计时不会在孩子离开时继续跑。
- **`dt` 上限 1/20 秒**：防止平板切回前台时时间戳跳跃导致小球瞬移穿墙。
- **不使用 `Math.random()` 做关卡**：全部走可播种的 `mulberry32`，便于复现与测试。
