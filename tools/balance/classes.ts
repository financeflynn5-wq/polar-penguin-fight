// Bot matches for balancing the classes. Runs whole matches headless (no browser) and prints who won and how each
// class did.   npm run balance -- [matches per line-up] [mode] [team size]
//
// Each line-up is played an even number of times with the two teams swapping sides, so a map that favours one
// side doesn't show up as a class being stronger.
import { buildMap, mapForMode, Mode } from '../../src/world/Maps';
import { World } from '../../src/sim/World';
import { BotBrain } from '../../src/sim/Bot';
import { CLASS_IDS, ClassId, BOT_CLASS_MIX } from '../../src/sim/Classes';

const N = Math.max(2, +(process.argv[2] ?? 6));
const MODE = (process.argv[3] ?? 'tdm') as Mode;
const SIZE = +(process.argv[4] ?? 5);
const ONLY = process.argv[5];
const DT = 1 / 60;

interface Tally { n: number; splats: number; downs: number; }
const blank = (): Record<ClassId, Tally> => ({ penguin: { n: 0, splats: 0, downs: 0 }, bear: { n: 0, splats: 0, downs: 0 }, yeti: { n: 0, splats: 0, downs: 0 } });

function play(a: ClassId[], b: ClassId[], swap: boolean, tally: Record<ClassId, Tally>) {
  const mix: [ClassId[], ClassId[]] = swap ? [b, a] : [a, b];
  const w = new World(buildMap(mapForMode(MODE)), { teamSize: SIZE, playerName: '', playerHat: '', allBots: true, mode: MODE, botClasses: mix });
  let seed = 1 + Math.floor(Math.random() * 1e6);
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const slots = [0, 0];
  const bots = w.penguins.map((p, i) => new BotBrain(i, rnd, slots[p.team]++));
  let ticks = 0;
  while (w.phase !== 'end' && ticks < 60 * 60 * 30) {
    for (let i = 0; i < bots.length; i++) bots[i].think(w, w.penguins[i], DT);
    w.step(DT);
    w.events.length = 0;
    ticks++;
  }
  for (const p of w.penguins) { const t = tally[p.cls]; t.n++; t.splats += p.splats; t.downs += p.downs; }
  // which line-up won: 0 = a, 1 = b, -1 = draw
  const win = w.winner < 0 ? -1 : (w.winner === 0) !== swap ? 0 : 1;
  const sa = w.scores[swap ? 1 : 0], sb = w.scores[swap ? 0 : 1];
  return { win, sa, sb, secs: ticks / 60 };
}

const all = (c: ClassId) => [c];
const LINEUPS: [string, ClassId[], ClassId[]][] = [
  ['penguins only', all('penguin'), all('penguin')],
  ['mixed v mixed', BOT_CLASS_MIX, BOT_CLASS_MIX],
  ['one of each', ['penguin', 'bear', 'yeti'], ['penguin', 'bear', 'yeti']],
  ['penguins v bears', all('penguin'), all('bear')],
  ['penguins v yetis', all('penguin'), all('yeti')],
  ['bears v yetis', all('bear'), all('yeti')],
  ['penguins v mixed', all('penguin'), BOT_CLASS_MIX],
];

const total = blank();
const t0 = Date.now();
for (const [name, a, b] of LINEUPS) {
  if (ONLY && !name.includes(ONLY)) continue;
  const tally = blank();
  let wa = 0, wb = 0, dr = 0, sa = 0, sb = 0, secs = 0;
  for (let n = 0; n < N; n++) {
    // bots have jobs by their number on the team (packer, builder, roller...), so turn the line-ups round each time:
    // every class gets a go at every job
    const turn = (m: ClassId[]) => m.map((_, i) => m[(i + (n >> 1)) % m.length]);
    const r = play(turn(a), turn(b), n % 2 === 1, tally);
    if (r.win === 0) wa++; else if (r.win === 1) wb++; else dr++;
    sa += r.sa; sb += r.sb; secs += r.secs;
  }
  const kd = CLASS_IDS.filter(c => tally[c].n).map(c => `${c} ${(tally[c].splats / Math.max(1, tally[c].downs)).toFixed(2)} (${(tally[c].splats / tally[c].n).toFixed(1)} splats, ${(tally[c].downs / tally[c].n).toFixed(1)} downs each)`).join(' · ');
  console.log(`${name.padEnd(18)} ${wa}-${wb}${dr ? ` (${dr} drawn)` : ''}   score ${(sa / N).toFixed(1)}-${(sb / N).toFixed(1)}   ${(secs / N / 60).toFixed(1)} min   splats per down: ${kd}`);
  for (const c of CLASS_IDS) { total[c].n += tally[c].n; total[c].splats += tally[c].splats; total[c].downs += tally[c].downs; }
}
console.log(`\nall line-ups: ${CLASS_IDS.map(c => `${c} ${(total[c].splats / Math.max(1, total[c].downs)).toFixed(2)}`).join(' · ')} splats per down   (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
