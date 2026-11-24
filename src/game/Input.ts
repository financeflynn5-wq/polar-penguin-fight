// Keyboard + mouse with pointer lock.
export class Input {
  keys = new Set<string>();
  mouse = [false, false, false];
  yaw = 0;
  pitch = -0.12;
  sensitivity = 1;
  locked = false;
  jumpQueued = false;
  enabled = false;
  onLockChange: ((locked: boolean) => void) | null = null;
  onKey: ((code: string) => void) | null = null;
  /** the browser refused to capture the mouse (e.g. no recent click): ask for a click */
  onLockError: (() => void) | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', e => {
      if (!this.enabled) return;
      if (e.code === 'Tab') e.preventDefault();
      if (e.code === 'Space') { e.preventDefault(); if (!this.keys.has('Space')) this.jumpQueued = true; }
      this.keys.add(e.code);
      this.onKey?.(e.code);
    });
    window.addEventListener('keyup', e => { this.keys.delete(e.code); });
    window.addEventListener('blur', () => { this.keys.clear(); this.mouse = [false, false, false]; });
    canvas.addEventListener('mousedown', e => {
      if (!this.enabled) return;
      if (!this.locked) { this.lock(); return; }
      this.mouse[e.button] = true;
    });
    window.addEventListener('mouseup', e => { this.mouse[e.button] = false; });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    document.addEventListener('mousemove', e => {
      if (!this.locked) return;
      const s = 0.0022 * this.sensitivity;
      this.yaw -= e.movementX * s;
      this.pitch -= e.movementY * s;
      this.pitch = Math.max(-1.2, Math.min(0.95, this.pitch));
    });
    document.addEventListener('pointerlockerror', () => this.onLockError?.());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) { this.mouse = [false, false, false]; this.keys.clear(); }
      this.onLockChange?.(this.locked);
    });
  }

  lock() {
    const c = this.canvas as any;
    const plain = () => {
      try { const r = c.requestPointerLock(); if (r && r.catch) r.catch(() => this.onLockError?.()); } catch { this.onLockError?.(); }
    };
    try {
      const r = c.requestPointerLock({ unadjustedMovement: true });
      if (r && r.catch) r.catch(plain);
    } catch { plain(); }
  }

  unlock() { if (document.pointerLockElement) document.exitPointerLock(); }

  down(code: string) { return this.keys.has(code); }
}
