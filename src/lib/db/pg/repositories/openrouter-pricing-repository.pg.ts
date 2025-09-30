import { pgDb as db } from "../db.pg";
import { OpenRouterPricingSchema } from "../schema.pg";
import { inArray } from "drizzle-orm";

export type OpenRouterPricing = {
  modelId: string;
  promptPrice: number; // USD per token
  completionPrice: number; // USD per token
  requestPrice?: number | null; // USD per request
  currency: string; // always USD for now
  updatedAt?: Date;
};

export const pgOpenRouterPricingRepository = {
  upsert: async (p: OpenRouterPricing) => {
    await db
      .insert(OpenRouterPricingSchema)
      .values({
        modelId: p.modelId,
        promptPrice: String(p.promptPrice),
        completionPrice: String(p.completionPrice),
        requestPrice: p.requestPrice != null ? String(p.requestPrice) : null,
        currency: p.currency,
      })
      .onConflictDoUpdate({
        target: OpenRouterPricingSchema.modelId,
        set: {
          promptPrice: String(p.promptPrice),
          completionPrice: String(p.completionPrice),
          requestPrice: p.requestPrice != null ? String(p.requestPrice) : null,
          currency: p.currency,
          updatedAt: new Date(),
        },
      });
  },
  getByModelIds: async (ids: string[]) => {
    if (ids.length === 0) return [] as OpenRouterPricing[];
    const rows = await db
      .select()
      .from(OpenRouterPricingSchema)
      .where(inArray(OpenRouterPricingSchema.modelId, ids));
    return rows.map((r) => ({
      modelId: r.modelId,
      promptPrice: Number(r.promptPrice),
      completionPrice: Number(r.completionPrice),
      requestPrice: r.requestPrice != null ? Number(r.requestPrice) : null,
      currency: r.currency,
      updatedAt: r.updatedAt,
    }));
  },
};
