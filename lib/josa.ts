// Korean particles picked by the last syllable, e.g. josa("알림", "을/를") → "을".
// "으로/로" uses 로 after a vowel or ㄹ. Words not ending in Hangul get the "을(를)" form.
export function josa(word: string, pair: "을/를" | "이/가" | "은/는" | "과/와" | "으로/로") {
  const [a, b] = pair.split("/");
  const w = word.replace(/['"’”)\]\s.]+$/, "");
  const c = w.charCodeAt(w.length - 1);
  if (!(c >= 0xac00 && c <= 0xd7a3)) {
    if (/\d$/.test(w)) return "0136783".includes(w.slice(-1)) ? (pair === "으로/로" && "17".includes(w.slice(-1)) ? b : a) : b;
    return `${a}(${pair === "으로/로" ? "로" : b})`;
  }
  const jong = (c - 0xac00) % 28;
  if (pair === "으로/로") return jong === 0 || jong === 8 ? b : a;
  return jong ? a : b;
}
