import { z } from "zod";

const sourceIdSchema = z.string().trim().min(1).max(200);

export const preferenceRevisionSchema = z
  .object({
    themes: z
      .string()
      .max(2_000)
      .refine((value) => value.trim().length >= 20),
    inspiration: z.string().max(1_000),
    mediaTypes: z.string().max(500),
    visualStyle: z.string().max(500),
    colorPalette: z.string().max(500),
    contentLevel: z.enum(["family-friendly", "adult-allowed"]),
    avoid: z.string().max(800),
  })
  .strict();

const adaptationFields = {
  adaptationStrength: z.enum(["guided", "unfettered"]).optional(),
  adaptationLastDecision: z.number().int().nonnegative().optional(),
};

const currentPreferenceProfileSchema = preferenceRevisionSchema.extend({
  adaptationMode: z.enum(["static", "adaptive"]),
  ...adaptationFields,
  adaptationSourceWinnerIds: z.array(sourceIdSchema).max(12),
  adaptationSourceRejectedIds: z.array(sourceIdSchema).max(12).default([]),
});

const transitionalPreferenceProfileSchema = preferenceRevisionSchema
  .extend({
    inspirationBase: z.string().optional(),
    inspirationMode: z.enum(["static", "adaptive"]),
    inspirationSourceWinnerIds: z.array(sourceIdSchema).max(12).optional(),
    adaptationMode: z.enum(["static", "adaptive"]).optional(),
    ...adaptationFields,
    adaptationSourceWinnerIds: z.array(sourceIdSchema).max(12).optional(),
    adaptationSourceRejectedIds: z.array(sourceIdSchema).max(12).optional(),
  })
  .transform((profile) => ({
    themes: profile.themes,
    inspiration: profile.inspiration,
    mediaTypes: profile.mediaTypes,
    visualStyle: profile.visualStyle,
    colorPalette: profile.colorPalette,
    contentLevel: profile.contentLevel,
    avoid: profile.avoid,
    adaptationMode: profile.adaptationMode ?? profile.inspirationMode,
    ...(profile.adaptationStrength
      ? { adaptationStrength: profile.adaptationStrength }
      : {}),
    ...(profile.adaptationLastDecision !== undefined
      ? { adaptationLastDecision: profile.adaptationLastDecision }
      : {}),
    adaptationSourceWinnerIds:
      profile.adaptationSourceWinnerIds ??
      profile.inspirationSourceWinnerIds ??
      [],
    adaptationSourceRejectedIds: profile.adaptationSourceRejectedIds ?? [],
  }));

export const preferenceProfileSchema = z.union([
  currentPreferenceProfileSchema,
  transitionalPreferenceProfileSchema,
]);

const persistedCurrentPreferenceProfileSchema = z
  .object({
    themes: z
      .string()
      .max(2_000)
      .refine((value) => value.trim().length >= 20),
    inspiration: z.string().max(1_000).optional(),
    mediaTypes: z.string().max(500),
    visualStyle: z.string().max(500),
    colorPalette: z.string().max(500),
    contentLevel: z.enum(["family-friendly", "adult-allowed"]),
    avoid: z.string().max(800),
    adaptationMode: z.enum(["static", "adaptive"]).optional(),
    ...adaptationFields,
    adaptationSourceWinnerIds: z.array(sourceIdSchema).max(12).optional(),
    adaptationSourceRejectedIds: z.array(sourceIdSchema).max(12).optional(),
  })
  .strict()
  .transform((profile) => ({
    ...profile,
    inspiration: profile.inspiration ?? "",
    adaptationMode: profile.adaptationMode ?? ("static" as const),
    adaptationSourceWinnerIds: profile.adaptationSourceWinnerIds ?? [],
    adaptationSourceRejectedIds: profile.adaptationSourceRejectedIds ?? [],
  }));

const persistedTransitionalPreferenceProfileSchema = z
  .object({
    themes: z
      .string()
      .max(2_000)
      .refine((value) => value.trim().length >= 20),
    inspiration: z.string().max(1_000).optional(),
    inspirationBase: z.string().max(1_000).optional(),
    inspirationMode: z.enum(["static", "adaptive"]),
    inspirationSourceWinnerIds: z.array(sourceIdSchema).max(12).optional(),
    mediaTypes: z.string().max(500),
    visualStyle: z.string().max(500),
    colorPalette: z.string().max(500),
    contentLevel: z.enum(["family-friendly", "adult-allowed"]),
    avoid: z.string().max(800),
    adaptationMode: z.enum(["static", "adaptive"]).optional(),
    ...adaptationFields,
    adaptationSourceWinnerIds: z.array(sourceIdSchema).max(12).optional(),
    adaptationSourceRejectedIds: z.array(sourceIdSchema).max(12).optional(),
  })
  .strict()
  .transform((profile) => ({
    themes: profile.themes,
    inspiration: profile.inspiration ?? "",
    mediaTypes: profile.mediaTypes,
    visualStyle: profile.visualStyle,
    colorPalette: profile.colorPalette,
    contentLevel: profile.contentLevel,
    avoid: profile.avoid,
    adaptationMode: profile.adaptationMode ?? profile.inspirationMode,
    ...(profile.adaptationStrength
      ? { adaptationStrength: profile.adaptationStrength }
      : {}),
    ...(profile.adaptationLastDecision !== undefined
      ? { adaptationLastDecision: profile.adaptationLastDecision }
      : {}),
    adaptationSourceWinnerIds:
      profile.adaptationSourceWinnerIds ??
      profile.inspirationSourceWinnerIds ??
      [],
    adaptationSourceRejectedIds: profile.adaptationSourceRejectedIds ?? [],
  }));

export const persistedPreferenceProfileSchema = z.union([
  persistedCurrentPreferenceProfileSchema,
  persistedTransitionalPreferenceProfileSchema,
]);

export const preferenceProfileRequestSchema = z
  .object({
    themes: z
      .string()
      .max(2_000)
      .refine((value) => value.trim().length >= 20),
    inspiration: z.string().max(1_000).default(""),
    adaptationMode: z.enum(["static", "adaptive"]).default("static"),
    adaptationStrength: z.enum(["guided", "unfettered"]).default("guided"),
    adaptationLastDecision: z.number().int().nonnegative().default(0),
    adaptationSourceWinnerIds: z.array(sourceIdSchema).max(12).default([]),
    adaptationSourceRejectedIds: z.array(sourceIdSchema).max(12).default([]),
    mediaTypes: z.string().max(500),
    visualStyle: z.string().max(500),
    colorPalette: z.string().max(500),
    contentLevel: z.enum(["family-friendly", "adult-allowed"]),
    avoid: z.string().max(800),
  })
  .strict();
