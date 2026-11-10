import { describe, expect, it } from "vitest";
import { decodeSubtitle } from "../src/text.js";

describe("subtitle text decoding", () => {
  it("keeps UTF-8 and drops a BOM", () => {
    expect(decodeSubtitle(Buffer.from("\uFEFFمرحبا", "utf8"), "ara")).toBe("مرحبا");
  });
  it("reads Windows-1256 Arabic", () => {
    // "مرحبا" in Windows-1256
    expect(decodeSubtitle(Buffer.from([0xe3, 0xd1, 0xcd, 0xc8, 0xc7]), "ara")).toBe("مرحبا");
  });
});
