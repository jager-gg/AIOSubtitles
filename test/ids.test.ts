import { describe, expect, it } from "vitest";
import { parseKitsuId } from "../src/ids.js";

describe("Kitsu ids", () => {
  it("parses series episodes and movies, and nothing else", () => {
    expect(parseKitsuId("kitsu:1000:13")).toEqual({ kitsuId: "1000", episode: 13 });
    expect(parseKitsuId("kitsu:1000")).toEqual({ kitsuId: "1000", episode: undefined });
    expect(parseKitsuId("tt0000004:1:13")).toBeUndefined();
    expect(parseKitsuId("mal:34572:13")).toBeUndefined();
  });
});
