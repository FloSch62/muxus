import { z } from 'zod';

const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const keywordHighlightRuleSchema = z.object({
  id: z.string().min(1).max(100),
  keyword: z.string().min(1).max(500),
  foreground: hexColorSchema,
  background: hexColorSchema.optional(),
  caseSensitive: z.boolean(),
  wholeWord: z.boolean(),
});

export const hostKeywordHighlightsSchema = z.object({
  inheritGlobal: z.boolean(),
  rules: z.array(keywordHighlightRuleSchema).max(100),
});

/** Muxus-owned display metadata, shared by OpenSSH hosts and saved profiles. */
export const metadataPatchSchema = z
  .object({
    displayName: z.string().max(200).nullable().optional(),
    // A group is a folder path ("Production/EU/Edge"), so the cap has to cover
    // several nested names rather than a single one.
    group: z.string().max(300).nullable().optional(),
    color: z.string().max(64).nullable().optional(),
    icon: z.string().max(64).nullable().optional(),
    keywordHighlights: hostKeywordHighlightsSchema.nullable().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, 'at least one metadata field is required');
