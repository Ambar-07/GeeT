/**
 * Offline Devanagari (Hindi) -> Hinglish (Romanized) transliterator
 * tailored for karaoke lyrics readability (including nukta consonants
 * and Hindi schwa deletion heuristics).
 */

const DEVANAGARI_RE = /[\u0900-\u097F]/;

const INDEPENDENT_VOWELS: Record<string, string> = {
  "अ": "a",
  "आ": "aa",
  "इ": "i",
  "ई": "ee",
  "उ": "u",
  "ऊ": "oo",
  "ऋ": "ri",
  "ए": "e",
  "ऐ": "ai",
  "ओ": "o",
  "औ": "au",
  "ॲ": "a",
  "ऑ": "o",
};

const MATRAS: Record<string, string> = {
  "ा": "a",
  "ि": "i",
  "ी": "i",
  "ु": "u",
  "ू": "u",
  "ृ": "ri",
  "े": "e",
  "ै": "ai",
  "ो": "o",
  "ौ": "au",
  "ॅ": "a",
  "ॉ": "o",
};

const CONSONANTS: Record<string, string> = {
  "क": "k",
  "ख": "kh",
  "ग": "g",
  "घ": "gh",
  "ङ": "ng",
  "च": "ch",
  "छ": "chh",
  "ज": "j",
  "झ": "jh",
  "ञ": "ny",
  "ट": "t",
  "ठ": "th",
  "ड": "d",
  "ढ": "dh",
  "ण": "n",
  "त": "t",
  "थ": "th",
  "द": "d",
  "ध": "dh",
  "न": "n",
  "प": "p",
  "फ": "ph",
  "ब": "b",
  "भ": "bh",
  "म": "m",
  "य": "y",
  "र": "r",
  "ल": "l",
  "ळ": "l",
  "व": "v",
  "श": "sh",
  "ष": "sh",
  "स": "s",
  "ह": "h",
  "क़": "q",
  "ख़": "kh",
  "ग़": "gh",
  "ज़": "z",
  "ड़": "r",
  "ढ़": "rh",
  "फ़": "f",
  "य़": "y",
};

const NUKTA_MAP: Record<string, string> = {
  "क": "q",
  "ख": "kh",
  "ग": "gh",
  "ज": "z",
  "ड": "r",
  "ढ": "rh",
  "फ": "f",
  "य": "y",
};

const LABIALS = new Set(["प", "फ", "ब", "भ", "म"]);
const SEMIVOWELS = new Set(["व", "य"]);
const LONG_VOWELS = new Set(["aa", "ee", "oo", "e", "ai", "o", "au"]);
const HALANT = "्";
const NUKTA = "़";
const ANUSVARA = "ं";
const CHANDRABINDU = "ँ";
const VISARGA = "ः";

interface SyllableToken {
  kind: "consonant" | "vowel" | "other";
  base: string;
  vowel: string | null; // explicit matra or "" when suppressed by halant; null = inherent schwa candidate
  nasal: string;
  hasHalant: boolean;
  rawConsonant?: string;
}

function tokenizeWord(word: string): SyllableToken[] {
  const chars = Array.from(word);
  const tokens: SyllableToken[] = [];

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];

    if (ch in INDEPENDENT_VOWELS) {
      let nasal = "";
      if (chars[i + 1] === ANUSVARA || chars[i + 1] === CHANDRABINDU) {
        const nextC = chars[i + 2];
        nasal = nextC && LABIALS.has(nextC) ? "m" : "n";
        i++;
      }
      tokens.push({
        kind: "vowel",
        base: INDEPENDENT_VOWELS[ch],
        vowel: "",
        nasal,
        hasHalant: false,
      });
      continue;
    }

    if (ch in CONSONANTS) {
      let base = CONSONANTS[ch];
      const rawConsonant = ch;

      // Consume nukta if present
      if (chars[i + 1] === NUKTA) {
        base = NUKTA_MAP[ch] ?? base;
        i++;
      }

      // Check halant or matra
      let vowel: string | null = null;
      let hasHalant = false;
      if (chars[i + 1] === HALANT) {
        vowel = "";
        hasHalant = true;
        i++;
      } else if (chars[i + 1] && chars[i + 1] in MATRAS) {
        vowel = MATRAS[chars[i + 1]];
        i++;
      }

      // Check nasalization or visarga
      let nasal = "";
      if (chars[i + 1] === ANUSVARA || chars[i + 1] === CHANDRABINDU) {
        const nextC = chars[i + 2];
        nasal = nextC && LABIALS.has(nextC) ? "m" : "n";
        i++;
      } else if (chars[i + 1] === VISARGA) {
        nasal = "h";
        i++;
      }

      tokens.push({
        kind: "consonant",
        base,
        vowel,
        nasal,
        hasHalant,
        rawConsonant,
      });
      continue;
    }

    if (ch === "।") {
      tokens.push({ kind: "other", base: ".", vowel: "", nasal: "", hasHalant: false });
    } else if (ch === "॥") {
      tokens.push({ kind: "other", base: ".", vowel: "", nasal: "", hasHalant: false });
    } else if (ch === ANUSVARA || ch === CHANDRABINDU) {
      tokens.push({ kind: "other", base: "n", vowel: "", nasal: "", hasHalant: false });
    } else {
      tokens.push({ kind: "other", base: ch, vowel: "", nasal: "", hasHalant: false });
    }
  }

  return tokens;
}

function transliterateWord(word: string): string {
  const tokens = tokenizeWord(word);
  const n = tokens.length;
  let out = "";

  for (let i = 0; i < n; i++) {
    const tok = tokens[i];
    if (tok.kind !== "consonant") {
      out += tok.base + tok.nasal;
      continue;
    }

    if (tok.vowel !== null) {
      // Explicit matra or halant
      out += tok.base + tok.vowel + tok.nasal;
      continue;
    }

    // Inherent schwa decision
    const prev = i > 0 ? tokens[i - 1] : null;
    const next = i + 1 < n ? tokens[i + 1] : null;
    const prevHadHalant = prev?.hasHalant ?? false;

    let keepSchwa = true;

    if (i === n - 1) {
      // Word-final consonant: drop inherent schwa unless single consonant or following halant cluster (e.g. कृष्ण)
      keepSchwa = n === 1 || prevHadHalant || tok.nasal !== "";
    } else if (i > 0 && next && next.kind === "consonant" && !prevHadHalant && tok.nasal === "") {
      // Medial schwa deletion heuristic for natural Hindi pronunciation:
      // - Keep schwa in 3-consonant bare-ending words (सुबह -> subah, नज़र -> nazar, सफ़र -> safar)
      // - Keep schwa on semivowels (व/य) after long vowels (बेवफ़ा -> bewafa)
      // - Drop schwa before a voweled next consonant (तुमसे -> tumse, पहली -> pahli, डरना -> darna)
      //   or in 4+ syllable words (बचपन -> bachpan, धड़कन -> dharkan)
      const prevVowelStr =
        prev?.kind === "vowel" ? prev.base : prev?.kind === "consonant" ? prev.vowel : null;
      const prevIsLong = prevVowelStr !== null && LONG_VOWELS.has(prevVowelStr);
      const isSemivowelAfterLong =
        Boolean(tok.rawConsonant && SEMIVOWELS.has(tok.rawConsonant)) && prevIsLong;

      const prevHadFullVowel =
        prev !== null &&
        (prev.kind === "vowel" || (prev.kind === "consonant" && !prev.hasHalant));
      const nextHasExplicitVowel = next.vowel !== null && next.vowel !== "";
      const hasFurtherSyllable = i + 2 < n;

      if (
        !isSemivowelAfterLong &&
        prevHadFullVowel &&
        (nextHasExplicitVowel || hasFurtherSyllable) &&
        !next.hasHalant
      ) {
        // Avoid deleting two consecutive schwas (e.g. बचपन -> bachpan, मखमल -> makhmal)
        const prevKeptSchwa =
          prev?.kind === "consonant" && prev.vowel === null && out.endsWith("a");
        const prevExplicitVowel =
          prev?.kind === "vowel" ||
          (prev?.kind === "consonant" && prev.vowel !== null && prev.vowel !== "");
        if (prevKeptSchwa || prevExplicitVowel) {
          keepSchwa = false;
        }
      }
    }

    // Special natural Hinglish spelling for common word-initial / medial "व" after vowel -> "w"
    const consonantText =
      tok.rawConsonant === "व" && i > 0 && prev && !prev.hasHalant ? "w" : tok.base;

    out += consonantText + (keepSchwa ? "a" : "") + tok.nasal;
  }

  return out;
}

/** Returns true if the input string contains any Devanagari characters. */
export function hasDevanagari(text: string): boolean {
  return DEVANAGARI_RE.test(text);
}

/** Transliterates Devanagari segments in a line into readable Hinglish, preserving punctuation and Latin text. */
export function transliterateDevanagari(text: string): string {
  if (!DEVANAGARI_RE.test(text)) return text;
  return text.replace(/[\u0900-\u097F]+/g, (word) => transliterateWord(word));
}
