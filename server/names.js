// Stream-safe display names. The same file lives in Time of War
// (server/names.js), Flynn Fall (server/names.js) and Scrapforge (names.js):
// keep the copies identical.
//
// cleanName(raw, fallback, opts) tidies a player-chosen name and swaps one
// that carries a slur or strong profanity for a neutral stand-in. The check
// sees through the usual dodges: case, accents (NFKD) and look-alike letters,
// leetspeak (0>o, 1 ! |>i or l, 3>e, 4 @>a, 5 $>s, 6 9>g, 7 +>t, 8>b),
// symbols or spaces between letters ("f.u.c.k", "f u c k") and stretched
// letters ("fuuuck"). Slurs match anywhere in a name, strong profanity
// anywhere inside a word, and short ambiguous words ("ass", "tit", "cum",
// "hoe") only as whole words, so "Classic", "Cassie" and "Scunthorpe" pass.
//
// The word lists are ROT13 so this file can be on screen during a stream
// without spelling them out; rot13() decodes them.

export const rot13 = (s) => s.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 84) % 26) + 97));

// Slurs: matched anywhere, across spaces and symbols too.
const SLURS = 'avtt avdd avoon avthe avttn snttbg sntbg sntt snttvg ergneq puvax xvxr xlxr jrgonpx ornare genaal genaavr gbjryurnq enturnq wvtnobb wvttnobb cbepuzbaxrl whatyrohaal tbyyvjbt fcrnepuhpxre furznyr shqtrcnpxre pnecrgzhapure uvgyre fvrturvy juvgrcbjre erqfxva';
// Strong profanity: matched anywhere inside a word (spaces separate words).
const PROFANE = 'shpx sipx cuhpx sphx shxx shxva fuvg phag ovgpu ovngpu ovbgpu orbgpu juber fyhg gjng jnaxre pbpxfhpx qvpxurnq nffubyr nefrubyr nffung nffzhapu onfgneq chffl cravf intvan qvyqb oybjwbo unaqwbo evzwbo phzfubg phzfyhg wvmm cbea zvys betnfz znfgheong wrexbss wnpxbss grfgvpyr fpebghz pyvgbevf uragnv zbyrfg crqbcuvy cnrqbcuvy xvyylbhefrys xvyyhefrys obyybpx fxnax gvggvrf';
// Short or ambiguous words: whole words only.
const WHOLE = 'nff nffrf nefr nany nahf gvg gvgf gvggl phz phzf ubr ubrf gubg fynt pbpx pbpxf qvpx qvpxf cevpx cvff obbo obbof obare frk betl encr encrq encrf encvfg crqb cnrqb xlf shx shd snt sntf fcvp fcvpx pbba pbbaf tbbx tbbxf cnxv qlxr qlxrf ubzb yrfob gneq jbt xxx arteb artebf anmv anmvf fcnm cvxrl ubaxl qntb jbc wnc fdhnj phpx jnax pyvg xhag ogpu';
// Innocent words that happen to contain one of the above.
const ALLOW = 'fphagubecr cravfgbar fuvvgnxr fuvgnxr zngfhfuvgn';

const list = (s) => rot13(s).split(' ');
// A word as a pattern that also matches it stretched: "ass" -> a+s{2,}.
const stretch = (w) => w.replace(/([a-z])\1*/g, (run, c) => (run.length > 1 ? `${c}{${run.length},}` : `${c}+`));
const anyOf = (s) => list(s).map(stretch).join('|');
const SLUR_RE = new RegExp(anyOf(SLURS));
const PROFANE_RE = new RegExp(anyOf(PROFANE));
const WHOLE_RE = new RegExp(`^(?:${anyOf(WHOLE)})$`);
const ALLOW_RE = new RegExp(list(ALLOW).join('|'), 'g');

// Cyrillic and Greek letters that look like Latin ones, plus a few Latin
// letters NFKD leaves alone.
const LOOKALIKE = {
  'а': 'a', 'в': 'b', 'е': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p',
  'с': 'c', 'т': 't', 'у': 'y', 'х': 'x', 'ѕ': 's', 'і': 'i', 'ј': 'j', 'ԁ': 'd',
  'α': 'a', 'β': 'b', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ο': 'o', 'ρ': 'p',
  'τ': 't', 'υ': 'u', 'χ': 'x', 'ϲ': 'c', 'ɡ': 'g', 'ı': 'i', 'ł': 'l', 'ø': 'o',
  'đ': 'd', 'ħ': 'h',
};
const LEET = { 0: 'o', 3: 'e', 4: 'a', '@': 'a', 5: 's', $: 's', 6: 'g', 7: 't', '+': 't', 8: 'b', 9: 'g' };

// The ways a name can be read: as typed, with leetspeak decoded (1 ! | as
// i, or as l), and with l and i swapped for each other ("nlgger").
function readings(text) {
  const base = text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\x00-\x7f]/g, (c) => LOOKALIKE[c] ?? c);
  const leet = base.replace(/[034@5$67+89]/g, (c) => LEET[c]);
  const asI = leet.replace(/[1!|]/g, 'i'), asL = leet.replace(/[1!|]/g, 'l');
  return [base, asI, asL, asI.replace(/l/g, 'i'), asL.replace(/i/g, 'l')];
}

const letters = (s) => s.replace(/[^a-z]/g, '');
const allowed = (s) => s.replace(ALLOW_RE, '-');

function blocked(r) {
  const tokens = r.split(/[^a-z]+/).filter(Boolean);
  // Runs of single letters ("f u c k", "a.s.s") also read as one word.
  const glued = [];
  let run = '';
  for (const t of [...tokens, '']) {
    if (t.length === 1) run += t;
    else {
      if (run.length > 1) glued.push(run);
      run = '';
    }
  }
  if (SLUR_RE.test(allowed(letters(r)))) return true;
  for (const w of [...r.split(/\s+/).map(letters), ...glued]) if (PROFANE_RE.test(allowed(w))) return true;
  for (const w of [...tokens, ...glued]) if (WHOLE_RE.test(w)) return true;
  return false;
}

// True when the text has a slur or strong profanity in it.
export function isOffensive(text) {
  const s = String(text ?? '').slice(0, 256);
  if (/1\W*4\W*8\W*8/.test(s)) return true;
  return readings(s).some(blocked);
}

// What never belongs in a name: control and format characters (zero-width,
// right-to-left overrides), broken surrogates, line breaks, and the blank
// "letters" used for invisible names.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}ᅟᅠ⠀ㅤﾠ]/gu;
// Shorten to n UTF-16 units without leaving half an emoji.
const cut = (s, n) => {
  s = s.slice(0, n);
  return /[\ud800-\udbff]$/.test(s) ? s.slice(0, -1) : s;
};
const digits = (n) => String(10 ** (n - 1) + Math.floor(Math.random() * 9 * 10 ** (n - 1)));

// raw: what the player typed. fallback: the name for an empty one.
// opts: max length, drop (a /g RegExp of characters the game doesn't allow),
// upper (upper-case it), and the stand-in for a blocked name: prefix plus
// that many random digits ("Player" + 3 by default).
export function cleanName(raw, fallback = 'Player', opts = {}) {
  const { max = 16, drop = null, upper = false, prefix = 'Player', digits: n = 3 } = opts;
  const typed = String(raw ?? '').replace(INVISIBLE, '').trim();
  let name = cut((drop ? typed.replace(drop, '') : typed).trim(), max).trim();
  if (upper) name = name.toUpperCase();
  if (!name) return fallback;
  // Check the name as shown and, where the game drops symbols, as typed
  // ("n!gger" would show as "NGGER").
  return isOffensive(name) || (drop && isOffensive(cut(typed, max * 2))) ? prefix + digits(n) : name;
}
