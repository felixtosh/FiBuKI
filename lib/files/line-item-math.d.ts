export interface EditableRow {
  description: string;
  vatPercent: string;
  vatAmount: string;
  amount: string;
}

export type LineItemRowProblem = "vatNotInsideAmount" | "rateOutOfRange" | "rateUnusual";

/** The row after a person typed into one box, with the coupled box recomputed (#540). */
export function updateLineItemRow<T extends EditableRow>(
  row: T,
  field: "description" | "vatPercent" | "vatAmount" | "amount",
  value: string
): T;

/** What is wrong with a row, or null (#540). */
export function lineItemRowProblem(row: EditableRow): LineItemRowProblem | null;

/** Whether a row problem prevents saving. */
export function blocksSave(problem: LineItemRowProblem | null): boolean;
