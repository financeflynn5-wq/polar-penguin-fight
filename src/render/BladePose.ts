// How the Candy Cane Blade sits in a penguin's mitten and moves through a swing. Shared by the blade (GunsView)
// and the arm that holds it (PenguinModel) so the two stay together. Pure numbers: the penguin's own frame, with
// x to its right, y up and -z ahead; rx/ry/rz are the blade's 'YXZ' Euler angles (at 0 it points straight ahead).
export interface BladeAt { x: number; y: number; z: number; rx: number; ry: number; rz: number; }

const ease = (t: number) => { t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** u: how far through a swing (0..1), or negative when the blade is just being carried. pitch: where the penguin looks. */
export function bladePose(u: number, pitch: number, out: BladeAt): BladeAt {
  // carried: grip beside the right hip, blade up and a little forward, like a knight on parade
  out.x = 0.5; out.y = 0.6; out.z = -0.12; out.rx = 1.05 + pitch * 0.35; out.ry = 0.12; out.rz = -0.18;
  if (u < 0) return out;
  // a swing: back over the shoulder, then down and across in front
  const a = ease(u / 0.3), b = ease((u - 0.3) / 0.5);
  out.x = mix(mix(0.5, 0.46, a), 0.22, b);
  out.y = mix(mix(0.6, 0.98, a), 0.5 + pitch * 0.25, b);
  out.z = mix(mix(-0.12, 0.06, a), -0.46, b);
  out.rx = mix(mix(1.05, 2.25, a), -0.4 + pitch * 0.6, b);
  out.ry = mix(mix(0.12, -0.25, a), 0.6, b);
  out.rz = mix(-0.18, -0.5, b);
  return out;
}
