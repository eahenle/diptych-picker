import { describe, expect, it } from "vitest";
import {
  cropTransform,
  fitTransform,
  rotatedBounds,
} from "./import-image-transform";

describe("import image transforms", () => {
  it("covers a square viewport for landscape and portrait crops", () => {
    expect(cropTransform({ width: 1600, height: 900 }).scale).toBeCloseTo(
      1024 / 900,
    );
    expect(cropTransform({ width: 900, height: 1600 }).scale).toBeCloseTo(
      1024 / 900,
    );
  });

  it("accounts for arbitrary rotation when covering the crop", () => {
    const transform = cropTransform(
      { width: 1600, height: 900 },
      { width: 1024, height: 1024 },
      { rotation: 37, zoom: 1, panX: 0, panY: 0 },
    );
    const radians = (37 * Math.PI) / 180;
    const requiredWidth =
      1024 * Math.abs(Math.cos(radians)) + 1024 * Math.abs(Math.sin(radians));
    expect(transform.scale).toBeCloseTo(
      Math.max(requiredWidth / 1600, requiredWidth / 900),
    );
  });

  it("keeps every rotated fit boundary inside a one-pixel inset", () => {
    for (const rotation of [0, 37, 90]) {
      const transform = fitTransform(
        { width: 1600, height: 900 },
        { width: 1024, height: 1024 },
        rotation,
      );
      expect(transform.rotatedWidth).toBeLessThanOrEqual(1022.000001);
      expect(transform.rotatedHeight).toBeLessThanOrEqual(1022.000001);
      expect(transform.panX).toBe(0);
      expect(transform.panY).toBe(0);
    }
  });

  it("computes the exact swapped bounds at ninety degrees", () => {
    expect(rotatedBounds({ width: 1200, height: 800 }, 90)).toEqual({
      width: expect.closeTo(800),
      height: expect.closeTo(1200),
    });
  });

  it("clamps crop zoom and pan to finite safe values", () => {
    const transform = cropTransform(
      { width: 100, height: 100 },
      { width: 1024, height: 1024 },
      { rotation: 0, zoom: 99, panX: 1e9, panY: -1e9 },
    );
    expect(transform.scale).toBeCloseTo((1024 / 100) * 4);
    expect(Math.abs(transform.panX)).toBeLessThan(2_000);
    expect(Math.abs(transform.panY)).toBeLessThan(2_000);
  });

  it("keeps crop position proportional between preview and saved output", () => {
    const edit = {
      rotation: 0,
      zoom: 2,
      panX: 256,
      panY: -128,
    };
    const preview = cropTransform(
      { width: 1200, height: 800 },
      { width: 512, height: 512 },
      edit,
    );
    const saved = cropTransform(
      { width: 1200, height: 800 },
      { width: 1024, height: 1024 },
      edit,
    );

    expect(saved.scale).toBeCloseTo(preview.scale * 2);
    expect(saved.panX).toBeCloseTo(preview.panX * 2);
    expect(saved.panY).toBeCloseTo(preview.panY * 2);
  });
});
