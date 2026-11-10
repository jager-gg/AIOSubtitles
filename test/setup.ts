/**
 * Tests never touch real DNS: every name resolves to one public address unless a test says
 * otherwise (src/net.ts looks a name up before fetching it).
 */
import { vi } from "vitest";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }])
}));
