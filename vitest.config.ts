import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 核心逻辑（迷宫生成、难度、随机数）是纯函数，不需要 DOM 环境
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
