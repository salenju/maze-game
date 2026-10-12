import { afterEach, describe, expect, it } from 'vitest';
import { appVersion, versionLabel } from '../src/ui/version';

/**
 * 版本号徽标。
 *
 * 这类「给家长看的」文案很容易在重构中被顺手删掉或改成运行时不存在的值，
 * 而一旦它显示错了，判断线上版本这件事就彻底失效，所以固定下来。
 */

/** 模拟 Vite 的 define 注入：define 会把 `__APP_VERSION__` 替换成字面量，等价于挂到全局。 */
function injectVersion(value: unknown): void {
  (globalThis as Record<string, unknown>)['__APP_VERSION__'] = value;
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)['__APP_VERSION__'];
});

describe('版本号', () => {
  it('未注入时降级为 dev 兜底值，不抛异常', () => {
    expect(appVersion()).toBe('0.0.0-dev');
  });

  it('读取构建时注入的版本号', () => {
    injectVersion('0.2.0');
    expect(appVersion()).toBe('0.2.0');
  });

  it('注入值为空白时同样降级，不显示空的徽标', () => {
    injectVersion('   ');
    expect(appVersion()).toBe('0.0.0-dev');
  });

  it('注入值类型异常时不把 undefined 渲染到页面上', () => {
    injectVersion(undefined);
    expect(appVersion()).toBe('0.0.0-dev');
  });

  it('徽标文案带 v 前缀', () => {
    injectVersion('0.2.0');
    expect(versionLabel()).toBe('v0.2.0');
  });
});
