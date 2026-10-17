import { describe, expect, it } from "vitest";
import { isImageFile, naturalCompare } from "../spinFrames";

describe("spin frames ordering", () => {
  it("sorts numbered frames by value, like the server's natural sort", () => {
    const names = ["10.jpg", "2.jpg", "1.jpg", "frame_011.JPG", "frame_9.jpg"];
    expect([...names].sort(naturalCompare)).toEqual([
      "1.jpg",
      "2.jpg",
      "10.jpg",
      "frame_9.jpg",
      "frame_011.JPG",
    ]);
  });

  it("accepts images by MIME type or by extension (folder picks often have no type)", () => {
    expect(isImageFile(new File(["x"], "a.bin", { type: "image/png" }))).toBe(true);
    expect(isImageFile(new File(["x"], "IMG_0001.HEIC"))).toBe(true);
    expect(isImageFile(new File(["x"], ".DS_Store"))).toBe(false);
    expect(isImageFile(new File(["x"], "notes.txt", { type: "text/plain" }))).toBe(false);
  });
});
