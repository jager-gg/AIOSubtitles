/** Codes whose subtitles, when not UTF-8, are usually in this Windows code page. */
const LEGACY: Record<string, string> = {
  ara: "windows-1256", ar: "windows-1256", arabic: "windows-1256",
  fas: "windows-1256", per: "windows-1256", persian: "windows-1256", farsi: "windows-1256", urdu: "windows-1256",
  rus: "windows-1251", russian: "windows-1251", ukr: "windows-1251", ukrainian: "windows-1251", bul: "windows-1251", bulgarian: "windows-1251",
  gre: "windows-1253", greek: "windows-1253", tur: "windows-1254", turkish: "windows-1254", heb: "windows-1255", hebrew: "windows-1255",
  pol: "windows-1250", polish: "windows-1250", cze: "windows-1250", czech: "windows-1250", hun: "windows-1250", hungarian: "windows-1250", rum: "windows-1250", romanian: "windows-1250"
};

/**
 * UTF-16, which Windows tools often save subtitles in, from its byte order
 * mark or, without one, from the zero byte that every timing digit and line
 * break has on one side. UTF-8 and the legacy code pages never have zeros.
 */
function utf16Encoding(raw: Buffer): "utf-16le" | "utf-16be" | undefined {
  if (raw[0] === 0xff && raw[1] === 0xfe) return "utf-16le";
  if (raw[0] === 0xfe && raw[1] === 0xff) return "utf-16be";
  const pairs = Math.floor(Math.min(raw.length, 1024) / 2);
  if (pairs < 8) return undefined;
  let even = 0;
  let odd = 0;
  for (let i = 0; i < pairs * 2; i += 2) {
    if (raw[i] === 0) even++;
    if (raw[i + 1] === 0) odd++;
  }
  if (odd >= pairs * 0.1 && even <= pairs * 0.01) return "utf-16le";
  if (even >= pairs * 0.1 && odd <= pairs * 0.01) return "utf-16be";
  return undefined;
}

/** A UTF-16 subtitle file re-encoded as UTF-8; anything else is returned as it is. */
export function utf16ToUtf8(raw: Buffer): Buffer {
  const encoding = utf16Encoding(raw);
  return encoding ? Buffer.from(new TextDecoder(encoding).decode(raw).replace(/^﻿/, ""), "utf8") : raw;
}

/** A subtitle file as text: UTF-16 or UTF-8 when it is, else the language's usual legacy code page (Windows-1252 by default). */
export function decodeSubtitle(raw: Buffer, lang?: string): string {
  const utf16 = utf16Encoding(raw);
  if (utf16) return new TextDecoder(utf16).decode(raw).replace(/^﻿/, "");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw).replace(/^﻿/, "");
  } catch {
    return new TextDecoder(LEGACY[(lang ?? "").toLowerCase()] ?? "windows-1252").decode(raw);
  }
}
