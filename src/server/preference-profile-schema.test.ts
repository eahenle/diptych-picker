import { describe, expect, it } from "vitest";
import {
  persistedPreferenceProfileSchema,
  preferenceProfileRequestSchema,
  preferenceProfileSchema,
} from "./preference-profile-schema";

const fields = {
  themes: "mythic engineering and strange ecosystems",
  inspiration: "ultraviolet rim light",
  mediaTypes: "large-format photography",
  visualStyle: "cinematic and tactile",
  colorPalette: "ultraviolet and copper",
  contentLevel: "family-friendly" as const,
  avoid: "readable text",
};

describe("shared preference profile schemas", () => {
  it("normalizes transitional worker and challenger profiles identically", () => {
    expect(
      preferenceProfileSchema.parse({
        ...fields,
        inspirationMode: "adaptive",
        inspirationSourceWinnerIds: ["winner-1"],
      }),
    ).toEqual({
      ...fields,
      adaptationMode: "adaptive",
      adaptationSourceWinnerIds: ["winner-1"],
      adaptationSourceRejectedIds: [],
    });
  });

  it("keeps persisted legacy defaults backward compatible", () => {
    expect(
      persistedPreferenceProfileSchema.parse({
        ...fields,
        inspiration: undefined,
      }),
    ).toMatchObject({
      inspiration: "",
      adaptationMode: "static",
      adaptationSourceWinnerIds: [],
      adaptationSourceRejectedIds: [],
    });
  });

  it("applies the same request defaults to profile saves and presets", () => {
    expect(preferenceProfileRequestSchema.parse(fields)).toMatchObject({
      ...fields,
      adaptationMode: "static",
      adaptationStrength: "guided",
      adaptationLastDecision: 0,
      adaptationSourceWinnerIds: [],
      adaptationSourceRejectedIds: [],
    });
  });
});
