/**
 * A Transaction's log line when automatic category matching changes it (#752).
 *
 * Category matching re-runs on every category edit and Transaction update, so
 * a line is written only when something moved: a category auto-assigned that
 * the Transaction did not have, or a new best suggestion. A re-run with the
 * same answer writes nothing.
 */

import { activityEntry } from "../utils/activity";

interface CategoryLike {
  id: string;
  name?: string | null;
  templateId?: string | null;
}

type Data = Record<string, unknown>;

function topCategoryId(suggestions: unknown): string | undefined {
  if (!Array.isArray(suggestions) || suggestions.length === 0) return undefined;
  const top = suggestions[0] as { categoryId?: unknown } | undefined;
  return typeof top?.categoryId === "string" ? top.categoryId : undefined;
}

export function categoryMatchActivity(
  before: Data,
  updates: Data,
  categories: CategoryLike[],
  via: string
): Record<string, unknown> | null {
  const nameOf = (id: string) => {
    const c = categories.find((x) => x.id === id);
    return c?.name || c?.templateId || id;
  };
  const assigned = updates.noReceiptCategoryId;
  if (typeof assigned === "string" && assigned !== before.noReceiptCategoryId) {
    const confidence = typeof updates.noReceiptCategoryConfidence === "number" ? updates.noReceiptCategoryConfidence : null;
    return activityEntry({
      type: "category_matched",
      actor: "auto",
      categoryName: nameOf(assigned),
      confidence,
      summary: `Category "${nameOf(assigned)}" assigned by ${via}${confidence != null ? ` (${Math.round(confidence)}%)` : ""}`,
    });
  }
  const nextTop = topCategoryId(updates.categorySuggestions);
  if (nextTop && nextTop !== topCategoryId(before.categorySuggestions) && !before.noReceiptCategoryId) {
    return activityEntry({
      type: "category_suggested",
      actor: "auto",
      categoryName: nameOf(nextTop),
      summary: `Category "${nameOf(nextTop)}" suggested by ${via}`,
    });
  }
  return null;
}
