// Audio procedurale Web Audio API + Musica di Sottofondo Egiziana in loop per Maze Royale

const BGM_SRC = './assets/bgm-egyptian.mp3?v=15';
const BGM_VOLUME = 0.24; // Bilanciato sotto gli effetti spada/scudo/portale

class MazeAudio {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.bgmMuted = false;
    this.bgm = null;
    this.bgmGain = null;
    this._bgmRouted = false;
    this._bgmDesired = false;
    this._iosPrimed = false;

    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && this._bgmDesired && !this.muted && !this.bgmMuted) {
          this.ctx?.resume?.().catch(() => null);
          this._playBgmSafe();
        }
      });
    }
  }

  _ensureBgmElement() {
    if (this.bgm || typeof Audio === 'undefined') return this.bgm;
    try {
      const el = new Audio(BGM_SRC);
      el.loop = true;
      el.preload = 'auto';
      el.playsInline = true;
      el.volume = BGM_VOLUME;
      this.bgm = el;
    } catch (_) {}
    return this.bgm;
  }

  _routeBgmThroughWebAudio() {
    if (this._bgmRouted || !this.ctx || !this.bgm) return;
    if (typeof this.ctx.createMediaElementSource !== 'function' || typeof this.ctx.createGain !== 'function') return;
    try {
      const source = this.ctx.createMediaElementSource(this.bgm);
      const gain = this.ctx.createGain();
      gain.gain.value = (this.muted || this.bgmMuted) ? 0 : BGM_VOLUME;
      source.connect(gain);
      gain.connect(this.ctx.destination);
      this.bgmGain = gain;
      this._bgmRouted = true;
      // Su iOS Safari element.volume e' solo lettura; usando GainNode controlliamo esattamente il 24% ovunque
      this.bgm.volume = 1.0;
    } catch (_) {}
  }

  _playBgmSafe() {
    const el = this._ensureBgmElement();
    if (!el || this.muted || this.bgmMuted) return;
    if (!this._bgmRouted) el.volume = BGM_VOLUME;
    el.muted = false;
    if (el.paused) {
      el.play().catch(() => null);
    }
  }

  startBgm() {
    this._bgmDesired = true;
    if (!this.bgmMuted && !this.muted) {
      this._playBgmSafe();
    }
  }

  isBgmMuted() {
    return this.bgmMuted || this.muted;
  }

  setBgmMuted(muted) {
    this.bgmMuted = Boolean(muted);
    if (this.bgmGain) {
      this.bgmGain.gain.value = (this.muted || this.bgmMuted) ? 0 : BGM_VOLUME;
    } else if (this.bgm) {
      this.bgm.volume = (this.muted || this.bgmMuted) ? 0 : BGM_VOLUME;
    }
    if (this.bgm) {
      this.bgm.muted = this.muted || this.bgmMuted;
      if (this.bgmMuted) {
        this.bgm.pause?.();
      } else if (this._bgmDesired && !this.muted) {
        this.unlock();
        this._playBgmSafe();
      }
    } else if (!this.bgmMuted && this._bgmDesired && !this.muted) {
      this.unlock();
      this._playBgmSafe();
    }
    return this.bgmMuted;
  }

  toggleBgmMuted() {
    return this.setBgmMuted(!this.bgmMuted);
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
    this.setBgmMuted(this.bgmMuted);
  }

  unlock() {
    if (this.muted) return;
    if (!this.ctx && typeof window !== 'undefined') {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this.ctx = new AC();
    }
    if (this.ctx) {
      if (this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => null);
      }
      // iOS Safari sblocca l'uscita audio hardware solo dopo una sorgente avviata dentro un gesto utente
      if (!this._iosPrimed) {
        this._iosPrimed = true;
        try {
          const buf = this.ctx.createBuffer(1, 1, 22050);
          const src = this.ctx.createBufferSource();
          src.buffer = buf;
          src.connect(this.ctx.destination);
          src.start(0);
        } catch (_) {}
      }
      this._routeBgmThroughWebAudio();
    }
    if (this._bgmDesired) {
      this._playBgmSafe();
    }
  }

  _tone(f0, f1, dur, type = 'triangle', vol = 0.14, delay = 0) {
    if (this.muted || !this.ctx) return;
    const t0 = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t0 + dur);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(vol, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  playSlash() { this._tone(520, 170, 0.11, 'sawtooth', 0.12); }
  playHit() { this._tone(210, 75, 0.14, 'square', 0.18); }
  playShieldBlock() { this._tone(680, 920, 0.09, 'triangle', 0.15); }
  playDash() { this._tone(340, 620, 0.12, 'sine', 0.12); }
  playPagePickup() {
    this._tone(523, 659, 0.12, 'triangle', 0.14, 0);
    this._tone(659, 880, 0.16, 'triangle', 0.14, 0.09);
  }
  playChestOpen() {
    this._tone(392, 523, 0.12, 'sine', 0.14, 0);
    this._tone(587, 784, 0.18, 'triangle', 0.14, 0.09);
  }
  playSuccess() {
    this._tone(523, 523, 0.12, 'triangle', 0.16, 0);
    this._tone(659, 659, 0.12, 'triangle', 0.16, 0.11);
    this._tone(784, 1046, 0.25, 'triangle', 0.18, 0.22);
  }
  playPunish() {
    this._tone(240, 80, 0.28, 'sawtooth', 0.22, 0);
    this._tone(160, 55, 0.30, 'square', 0.18, 0.12);
  }
  playDeath() {
    this._tone(280, 60, 0.45, 'sawtooth', 0.22);
  }
}

export const audio = new MazeAudio();
export const DEFAULT_BGM_VOLUME = BGM_VOLUME;
