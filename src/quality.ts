/**
 * Translation quality from what SubSource tells us. Its own
 * type tag (Retail / Translated / Machine/AI) is empty on most older uploads,
 * so the uploader's notes and release names are read too.
 *
 *   -1  machine or AI translation: never served
 *    3  official (retail, Crunchyroll, Netflix, ...)
 *    2  a person's translation (tagged translated/improved, or credited to a team or site)
 *    1  nothing known
 */
import type { SubSourceSubtitle } from "./types.js";

export type QualityTier = -1 | 1 | 2 | 3;

const MACHINE =
  /machine[\s-]*translat|\bmt\b|\bai\b[\s-]*(?:translat|generat|sub)|\ba\.i\.|chat\s?gpt|\bgpt-?\d|gemini|deepl|google\s*translat|whisper|auto[\s-]*generat|ترجم[ةه]\s*(?:آلي|ال[يى])|ترجم[ةه]\s*(?:جوجل|قوقل|غوغل)|(?:ال)?ذكاء\s*(?:ال)?اصطناعي/i;
const OFFICIAL =
  /crunchy\s*roll|كرا?نشي\s*رول|كرانشيرول|netflix|نت?فليكس|نيتفليكس|amazon|prime\s*video|disney|\bhidive\b|\bofficial\b|\bretail\b|رسمي[ةه]?/i;
const HUMAN = /https?:\/\/|www\.|ترجم|فريق|\bteam\b|fansub|\bsubs?\b|translated\s+by/i;

export function qualityTier(subtitle: SubSourceSubtitle): QualityTier {
  const type = `${subtitle.productionType ?? ""}`.toLowerCase();
  const text = [subtitle.commentary ?? "", ...(subtitle.releaseInfo ?? [])].join(" ");

  if (/machine|\bai\b/.test(type) || MACHINE.test(text)) return -1;
  if (/retail|official/.test(type) || OFFICIAL.test(text)) return 3;
  if (/translat|improv|human/.test(type) || HUMAN.test(subtitle.commentary ?? "")) return 2;
  return 1;
}

export function tierName(tier: QualityTier): string {
  return tier === 3 ? "official" : tier === 2 ? "human" : tier === 1 ? "unknown" : "machine";
}
