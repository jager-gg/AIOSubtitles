import { describe, expect, it } from "vitest";
import { decodeSubtitle } from "../src/text.js";

describe("subtitle text decoding", () => {
  it("keeps UTF-8 and drops a BOM", () => {
    expect(decodeSubtitle(Buffer.from("﻿مرحبا", "utf8"), "ara")).toBe("مرحبا");
  });
  it("reads Windows-1256 Arabic", () => {
    // "مرحبا" in Windows-1256
    expect(decodeSubtitle(Buffer.from([0xe3, 0xd1, 0xcd, 0xc8, 0xc7]), "ara")).toBe("مرحبا");
  });
  it("reads each language's usual legacy page, by the name a link gives it", () => {
    // Bytes as those pages write them.
    expect(decodeSubtitle(Buffer.from([0xe8, 0xe6, 0x9a]), "Croatian")).toBe("čćš"); // Windows-1250
    expect(decodeSubtitle(Buffer.from([0xe8, 0xe6, 0x9a]), "Serbian")).toBe("čćš");
    expect(decodeSubtitle(Buffer.from([0xe8, 0xe6, 0xf0]), "Lithuanian")).toBe("čęš"); // Windows-1257
    expect(decodeSubtitle(Buffer.from([0xca, 0xc7, 0xd1, 0xca]), "Thai")).toBe("สวัส"); // Windows-874
    expect(decodeSubtitle(Buffer.from([0xc4, 0xe3, 0xba, 0xc3]), "Chinese (Simplified)")).toBe("你好"); // GBK
    expect(decodeSubtitle(Buffer.from([0xa7, 0x41, 0xa6, 0x6e]), "Chinese (Traditional)")).toBe("你好"); // Big5
    expect(decodeSubtitle(Buffer.from([0x93, 0xfa, 0x96, 0x7b]), "Japanese")).toBe("日本"); // Shift JIS
    expect(decodeSubtitle(Buffer.from([0xc7, 0xd1, 0xb1, 0xb9]), "Korean")).toBe("한국"); // EUC-KR
  });
  it("falls back to Windows-1252 for any other language", () => {
    expect(decodeSubtitle(Buffer.from([0x63, 0x61, 0x66, 0xe9]), "French")).toBe("café");
    expect(decodeSubtitle(Buffer.from([0x63, 0x61, 0x66, 0xe9]))).toBe("café");
  });
});
