import { NoReceiptCategoryTemplate } from "@/types/no-receipt-category";

/**
 * Predefined no-receipt category templates.
 * These are used to initialize user-specific categories.
 */
export const NO_RECEIPT_CATEGORY_TEMPLATES: NoReceiptCategoryTemplate[] = [
  {
    id: "bank-fees",
    name: "Bank & Payment Fees",
    description: "Fees charged by banks, payment processors, or financial services",
    helperText: "e.g., Account maintenance fees, transfer fees, card fees, FX fees, PSP fee portions (Stripe, PayPal)",
    vatTreatment: "exempt-class",
  },
  {
    id: "interest",
    name: "Interest",
    description: "Interest charged or paid by banks and financial institutions",
    helperText: "e.g., Loan interest, overdraft interest, credit interest, savings interest",
    vatTreatment: "exempt-class",
  },
  {
    id: "internal-transfers",
    name: "Internal Transfers",
    description: "Money transfers between your own accounts",
    helperText: "e.g., Account-to-account transfers, wallet movements, clearing & timing differences",
    vatTreatment: "documented-elsewhere",
  },
  {
    id: "payment-provider-settlements",
    name: "Payment Provider Settlements",
    description: "Automated payouts and fee settlements from payment providers",
    helperText: "e.g., Stripe payouts, PayPal withdrawals, Adyen settlements (net payouts minus fees)",
    vatTreatment: "documented-elsewhere",
  },
  {
    id: "taxes-government",
    name: "Taxes & Government Payments",
    description: "Tax payments and fees to public authorities",
    helperText: "e.g., VAT payments, corporate tax, payroll taxes, social security contributions, late fees",
    vatTreatment: "exempt-class",
  },
  {
    id: "payroll",
    name: "Payroll Payments",
    description: "Salary payments and employment-related contributions",
    helperText: "e.g., Net salaries, employer contributions, payroll taxes (documented through payroll records)",
    vatTreatment: "exempt-class",
  },
  {
    id: "private-personal",
    name: "Private or Personal Spending",
    description: "Personal expenses paid with the business account",
    helperText: "Not a business expense - will be settled privately (shareholder/employee clearing account)",
    vatTreatment: "documented-elsewhere",
  },
  {
    id: "zero-value",
    name: "Zero-Value Transactions",
    description: "Transactions with no financial impact",
    helperText: "e.g., Authorizations, reversals, technical corrections, zero-amount entries",
    vatTreatment: "documented-elsewhere",
  },
  {
    id: "receipt-lost",
    name: "Receipt Lost",
    description: "Receipt was lost or unavailable - requires documentation",
    helperText: "Creates an Eigenbeleg (self-generated receipt). Should be exceptional.",
    vatTreatment: "needs-receipt",
    requiresConfirmation: true,
  },
];

/**
 * Get a category template by its ID
 */
export function getCategoryTemplate(
  templateId: string
): NoReceiptCategoryTemplate | undefined {
  return NO_RECEIPT_CATEGORY_TEMPLATES.find((t) => t.id === templateId);
}

/**
 * Get all category templates
 */
export function getAllCategoryTemplates(): NoReceiptCategoryTemplate[] {
  return NO_RECEIPT_CATEGORY_TEMPLATES;
}
