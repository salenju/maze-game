/**
 * 音效：全部用 WebAudio 实时合成，不引入任何音频文件。
 *
 * 理由很实际：
 *  - 离线缓存体积为 0，PWA 预缓存列表更短，冷启动更快；
 *  - 不需要处理 mp3/ogg 的跨浏览器编解码差异；
 *  - 平板上的音效只需「清脆短促」，正弦/三角波加包络已经足够好听。
 *
 * iOS/安卓的自动播放限制：AudioContext 必须在用户手势中创建或 resume，
 * 因此由第一次 pointerdown 触发 unlock()。
 */

export type SoundName = 'step' | 'star' | 'bump' | 'win' | 'click' | 'wrong' | 'caught';

export class Audio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private enabled = true;
  private unlocked = false;

  get isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(on ? 0.5 : 0, this.ctx.currentTime, 0.02);
    }
  }

  /**
   * 必须在真实用户手势中调用一次。
   * 返回是否成功解锁（安卓/iOS 都可能静默失败，调用方无需处理，属正常情况）。
   */
  unlock(): void {
    if (this.unlocked) {
      void this.ctx?.resume();
      return;
    }
    try {
      const Ctor =
        globalThis.AudioContext ??
        (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;

      const ctx = new Ctor();
      const master = ctx.createGain();
      master.gain.value = this.enabled ? 0.5 : 0;
      master.connect(ctx.destination);

      this.ctx = ctx;
      this.master = master;
      this.unlocked = true;
      void ctx.resume();
    } catch {
      // 无音频设备或被策略阻止：静默降级为无声游戏，不影响任何玩法
      this.ctx = null;
      this.master = null;
    }
  }

  play(name: SoundName): void {
    if (!this.enabled || !this.ctx || !this.master) return;
    if (this.ctx.state === 'suspended') void this.ctx.resume();

    switch (name) {
      case 'star':
        // 上行两音，最典型的「得分」听感
        this.blip(880, 0.09, 'sine', 0.5);
        this.blip(1320, 0.14, 'sine', 0.4, 0.07);
        break;
      case 'win':
        this.blip(523, 0.14, 'triangle', 0.5);
        this.blip(659, 0.14, 'triangle', 0.5, 0.12);
        this.blip(784, 0.28, 'triangle', 0.55, 0.24);
        break;
      case 'bump':
        // 低频短促，表示「撞到东西了」，但不能刺耳吓到孩子
        this.blip(150, 0.09, 'square', 0.18);
        break;
      case 'step':
        this.blip(420, 0.035, 'sine', 0.08);
        break;
      case 'wrong':
        // 下行两音 =「这条路不对」。与得分的上行音正好相反，孩子不用教就分得清
        this.blip(392, 0.12, 'triangle', 0.32);
        this.blip(262, 0.18, 'triangle', 0.3, 0.1);
        break;
      case 'caught':
        // 低沉的「被抓」音：比撞墙更重，但仍不刺耳
        this.blip(180, 0.14, 'sawtooth', 0.2);
        this.blip(120, 0.26, 'sawtooth', 0.2, 0.12);
        break;
      case 'click':
        this.blip(660, 0.06, 'sine', 0.3);
        break;
    }
  }

  private blip(
    freq: number,
    duration: number,
    type: OscillatorType,
    peak: number,
    delay = 0,
  ): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;

    const start = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);

    // 指数衰减包络：自然、无爆音
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    osc.connect(gain);
    gain.connect(master);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }
}
