// The three classes you can play: what each one is good and bad at. Every number that makes a class feel different
// lives here, so they can be balanced against each other in one place. No Three.js and no DOM (the server uses it too).

export const CLASS_IDS = ['penguin', 'bear', 'yeti'] as const;
export type ClassId = typeof CLASS_IDS[number];

export interface ClassDef {
  id: ClassId;
  name: string;
  /** one line for the menu */
  blurb: string;
  /** snowball hits it takes to splat you */
  health: number;
  /** on-foot speed next to the penguin's */
  speed: number;
  jump: number;
  /** body radius, and how tall the part of you a snowball can hit is */
  radius: number;
  top: number;
  /** how close a snowball has to pass to count */
  hitRadius: number;
  /** belly slide on Shift (only penguins) */
  slide: boolean;
  /** charge on Shift (only polar bears) */
  rush: boolean;
  maxCarry: number;
  /** stockpile snowballs one of yours is worth (a yeti's is a big one) */
  ballCost: number;
  /** time and snow to pack one, next to the penguin's */
  packTime: number;
  packMass: number;
  throwSpeedMin: number;
  throwSpeedMax: number;
  throwChargeTime: number;
  throwCooldown: number;
  /** where a throw leaves from: up from the feet, and out to the right */
  handY: number;
  handOut: number;
  /** the snowball itself */
  ballRadius: number;
  damage: number;
  /** everything within this of where it lands takes splashDamage (0 = an ordinary snowball) */
  splash: number;
  splashDamage: number;
  /** the hole it blasts in snow: radius and how much snow goes (2040 = one cubic metre) */
  crater: number;
  craterMass: number;
  /** digging and building speed next to the penguin's */
  dig: number;
  build: number;
  /** camera: how high above the feet it looks from, and how far back it sits */
  eyeY: number;
  camDist: number;
}

export const CLASSES: Record<ClassId, ClassDef> = {
  penguin: {
    id: 'penguin', name: 'Penguin', blurb: 'Fast and slippery. Belly slides down hills, packs snowballs quickest.',
    health: 3, speed: 1, jump: 1, radius: 0.38, top: 1.05, hitRadius: 0.5, slide: true, rush: false,
    maxCarry: 5, ballCost: 1, packTime: 1, packMass: 1,
    throwSpeedMin: 25, throwSpeedMax: 41, throwChargeTime: 0.7, throwCooldown: 0.28, handY: 1.05, handOut: 0.35,
    ballRadius: 0.13, damage: 1, splash: 0, splashDamage: 0, crater: 0, craterMass: 0,
    dig: 1, build: 1, eyeY: 1.5, camDist: 4.8,
  },
  bear: {
    id: 'bear', name: 'Polar Bear', blurb: 'Tough bruiser. Shift to charge: bowls enemies over and bursts through snow walls. No sliding.',
    health: 4, speed: 0.94, jump: 1, radius: 0.48, top: 1.35, hitRadius: 0.6, slide: false, rush: true,
    maxCarry: 5, ballCost: 1, packTime: 1.15, packMass: 1,
    throwSpeedMin: 25, throwSpeedMax: 41, throwChargeTime: 0.7, throwCooldown: 0.32, handY: 1.3, handOut: 0.45,
    ballRadius: 0.13, damage: 1, splash: 0, splashDamage: 0, crater: 0, craterMass: 0,
    dig: 1.2, build: 1, eyeY: 1.75, camDist: 5.3,
  },
  yeti: {
    id: 'yeti', name: 'Yeti', blurb: 'Slow heavy hitter. Lobs giant snowballs that splash everyone nearby and blast holes in walls. No sliding.',
    health: 5, speed: 0.76, jump: 0.92, radius: 0.56, top: 1.7, hitRadius: 0.7, slide: false, rush: false,
    maxCarry: 3, ballCost: 2, packTime: 2.2, packMass: 2.4,
    throwSpeedMin: 16, throwSpeedMax: 27, throwChargeTime: 0.9, throwCooldown: 0.85, handY: 2.0, handOut: 0.1,
    ballRadius: 0.36, damage: 2, splash: 2.5, splashDamage: 1, crater: 1.25, craterMass: 3400,
    dig: 2.5, build: 1.15, eyeY: 2.1, camDist: 6.0,
  },
};

export const asClass = (c: unknown): ClassId => (CLASS_IDS.includes(c as ClassId) ? c as ClassId : 'penguin');

/** What a team of bots is made of: slot = the bot's number on its team. Mostly penguins, with a bear and a yeti in every five. */
export const BOT_CLASS_MIX: ClassId[] = ['penguin', 'penguin', 'bear', 'penguin', 'yeti'];
