import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

import pkg from './package.json' with { type: 'json' };

/**
 * GitHub Pages 项目站点部署在 https://<user>.github.io/<repo>/ 子路径下。
 * base 必须与仓库名一致，否则所有资源路径都会 404（表现为整页白屏）。
 */
const REPO = 'maze-game';
const BASE = `/${REPO}/`;

/**
 * 版本号在构建时从 package.json 读入并注入前端。
 *
 * 为什么必须注入而不是让前端运行时去 fetch：版本号要显示在首页上，
 * 而首页恰恰是「离线打开旧版本」时最需要看到版本号的地方 ——
 * 若运行时再去请求 package.json，离线时正好拿不到，徽标反而消失。
 * 注入成常量后，版本号随 JS 一起被 Service Worker 预缓存，离线也准确。
 */
const APP_VERSION = pkg.version;

export default defineConfig({
  base: BASE,
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  build: {
    target: 'es2020',
    // 平板上的 Puzzle 不需要 sourcemap，省流量也省缓存体积
    sourcemap: false,
    assetsInlineLimit: 4096,
    rollupOptions: {
      output: {
        // 把 PWA 运行时单独拆出来，便于 SW 精准预缓存
        manualChunks: undefined,
      },
    },
  },
  plugins: [
    VitePWA({
      // autoUpdate：孩子在平板上不会去点「有新版本，是否更新」，
      // 必须让新版本在下次打开时自动生效，否则会长期停留在旧版。
      registerType: 'autoUpdate',
      includeAssets: ['icons/apple-touch-icon.png', 'icons/favicon.svg'],
      manifest: {
        name: '迷宫大冒险',
        short_name: '迷宫',
        description: '为 6-10 岁小朋友设计的触控笔迷宫游戏，可以离线游玩。',
        lang: 'zh-CN',
        dir: 'ltr',
        start_url: BASE,
        scope: BASE,
        display: 'standalone',
        // 注意：orientation 在 iOS Safari 上被忽略（无法锁定方向）。
        // 这里声明 any，让安卓可以自由旋转，布局层已做横竖屏双向适配。
        orientation: 'any',
        background_color: '#0f1729',
        theme_color: '#0f1729',
        categories: ['games', 'education'],
        icons: [
          {
            src: 'icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            // maskable 图标：安卓会裁成圆形/方形，安全区必须留足
            src: 'icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // 预缓存全部构建产物，实现完全离线可玩。
        // wasm 也纳入，方便后续若引入生成算法优化时无需再改配置。
        globPatterns: ['**/*.{js,css,html,png,svg,webmanifest,woff2}'],
        // 单文件上限：图标 512 大约 20KB，1MB 足够宽裕
        maximumFileSizeToCacheInBytes: 1024 * 1024,
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        navigateFallback: `${BASE}index.html`,
      },
      devOptions: {
        // 开发时也启用 SW，便于在真机上通过局域网 IP 直接验证离线与安装
        enabled: false,
        type: 'module',
      },
    }),
  ],
});
