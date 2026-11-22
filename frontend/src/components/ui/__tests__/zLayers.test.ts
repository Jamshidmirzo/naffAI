import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Selects open inside modals («assign to operator» etc.); a popover layer
// below the modal hid the list behind the backdrop (2026-10-22).
const css = readFileSync(resolve(__dirname, "../../../index.css"), "utf8");
const z = (name: string) => Number(css.match(new RegExp(`--z-${name}:\\s*(\\d+)`))?.[1]);

describe("z-index layers", () => {
  it("popover sits above modals and under toasts", () => {
    expect(z("popover")).toBeGreaterThan(z("modal"));
    expect(z("popover")).toBeLessThan(z("toast"));
  });
});
