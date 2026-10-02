import { AmountFormatConfig, AmountParser } from "@/types/import";

/**
 * Pre-configured amount format presets
 */
export const AMOUNT_PARSERS: AmountParser[] = [
  {
    id: "de",
    name: "German (1.234,56)",
    config: {
      decimalSeparator: ",",
      thousandsSeparator: ".",
      negativeFormat: "minus",
      currencyPosition: "suffix",
    },
  },
  {
    id: "de-space",
    name: "German with spaces (1 234,56)",
    config: {
      decimalSeparator: ",",
      thousandsSeparator: " ",
      negativeFormat: "minus",
      currencyPosition: "suffix",
    },
  },
  {
    id: "us",
    name: "US/UK (1,234.56)",
    config: {
      decimalSeparator: ".",
      thousandsSeparator: ",",
      negativeFormat: "minus",
      currencyPosition: "prefix",
    },
  },
  {
    id: "us-space",
    name: "International (1 234.56)",
    config: {
      decimalSeparator: ".",
      thousandsSeparator: " ",
      negativeFormat: "minus",
      currencyPosition: "prefix",
    },
  },
  {
    id: "accounting",
    name: "Accounting ((1,234.56))",
    config: {
      decimalSeparator: ".",
      thousandsSeparator: ",",
      negativeFormat: "parentheses",
      currencyPosition: "prefix",
    },
  },
  {
    id: "accounting-de",
    name: "Accounting German ((1.234,56))",
    config: {
      decimalSeparator: ",",
      thousandsSeparator: ".",
      negativeFormat: "parentheses",
      currencyPosition: "suffix",
    },
  },
  {
    id: "simple",
    name: "Simple (1234.56)",
    config: {
      decimalSeparator: ".",
      thousandsSeparator: "",
      negativeFormat: "minus",
      currencyPosition: "none",
    },
  },
  {
    id: "simple-comma",
    name: "Simple Comma (1234,56)",
    config: {
      decimalSeparator: ",",
      thousandsSeparator: "",
      negativeFormat: "minus",
      currencyPosition: "none",
    },
  },
];

/**
 * Parse an amount string into cents (integer)
 * Returns null if parsing fails
 */
export function parseAmount(
  value: string,
  config: AmountFormatConfig
): number | null {
  if (!value || typeof value !== "string") return null;

  let str = value.trim();
  if (str.length === 0) return null;

  // Track if negative
  let isNegative = false;

  // Handle parentheses format: (123.45) means negative
  if (config.negativeFormat === "parentheses") {
    if (str.startsWith("(") && str.endsWith(")")) {
      isNegative = true;
      str = str.slice(1, -1).trim();
    }
  }

  // Handle minus sign
  if (str.startsWith("-")) {
    isNegative = true;
    str = str.slice(1).trim();
  } else if (str.endsWith("-")) {
    // Some formats put minus at the end
    isNegative = true;
    str = str.slice(0, -1).trim();
  }

  // Remove currency symbols and codes
  str = str.replace(/[€$£¥₹CHF]|EUR|USD|GBP|JPY|INR/gi, "").trim();

  // Remove thousands separators
  if (config.thousandsSeparator) {
    // Escape special regex characters
    const escaped = config.thousandsSeparator.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    );
    str = str.replace(new RegExp(escaped, "g"), "");
  }

  // Replace decimal separator with standard period
  if (config.decimalSeparator === ",") {
    str = str.replace(",", ".");
  }

  // Remove any remaining non-numeric characters except decimal point
  str = str.replace(/[^\d.]/g, "");

  // Parse the number
  const num = parseFloat(str);
  if (isNaN(num)) return null;

  // Convert to cents (multiply by 100 and round)
  const cents = Math.round(num * 100);

  return isNegative ? -cents : cents;
}

/**
 * Auto-detect the amount format from sample values
 */
export function detectAmountFormat(samples: string[]): string | null {
  const validSamples = samples.filter((s) => s && s.trim().length > 0);
  if (validSamples.length === 0) return null;

  let bestParser: string | null = null;
  let bestScore = 0;
  let tied: string[] = [];

  for (const parser of AMOUNT_PARSERS) {
    let score = 0;
    for (const sample of validSamples) {
      const result = parseAmount(sample, parser.config);
      if (result !== null) {
        score++;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestParser = parser.id;
      tied = [parser.id];
    } else if (score === bestScore && score > 0) {
      tied.push(parser.id);
    }
  }

  // Require at least 70% match rate for amounts
  if (bestScore >= validSamples.length * 0.7) {
    // Several parsers can read the same column without error ("-89.99" parses
    // under German rules too, as -8999). The first in the list used to win such
    // a tie, which read a US-style column 100 times too large. Break the tie on
    // where the separators actually sit.
    if (tied.length > 1) {
      const byPattern = detectAmountFormatFromPatterns(validSamples);
      if (byPattern && tied.includes(byPattern)) return byPattern;
    }
    return bestParser;
  }

  // Fallback: try to detect based on common patterns
  return detectAmountFormatFromPatterns(validSamples);
}

/**
 * Detect amount format by analyzing patterns in the samples
 */
function detectAmountFormatFromPatterns(samples: string[]): string | null {
  // Count occurrences of separators
  let commaBeforeDot = 0;
  let dotBeforeComma = 0;
  let hasParentheses = false;

  for (const sample of samples) {
    const str = sample.trim();

    // Check for parentheses
    if (str.startsWith("(") && str.endsWith(")")) {
      hasParentheses = true;
    }

    // Find positions of comma and dot
    const commaPos = str.lastIndexOf(",");
    const dotPos = str.lastIndexOf(".");

    if (commaPos > -1 && dotPos > -1) {
      if (commaPos > dotPos) {
        // 1.234,56 - German format
        commaBeforeDot++;
      } else {
        // 1,234.56 - US format
        dotBeforeComma++;
      }
    } else if (commaPos > -1) {
      // Only comma found - likely German decimal
      const afterComma = str.slice(commaPos + 1).replace(/[^\d]/g, "");
      if (afterComma.length <= 2) {
        commaBeforeDot++;
      }
    } else if (dotPos > -1) {
      // Only dot found - likely US decimal
      const afterDot = str.slice(dotPos + 1).replace(/[^\d]/g, "");
      if (afterDot.length <= 2) {
        dotBeforeComma++;
      }
    }
  }

  // Determine format based on analysis
  if (hasParentheses) {
    return commaBeforeDot > dotBeforeComma ? "accounting-de" : "accounting";
  }

  if (commaBeforeDot > dotBeforeComma) {
    return "de";
  } else if (dotBeforeComma > commaBeforeDot) {
    return "us";
  }

  // Default to German format for Austrian tool
  return "de";
}

/**
 * Get parser by ID
 */
export function getAmountParser(id: string): AmountParser | undefined {
  return AMOUNT_PARSERS.find((p) => p.id === id);
}

/**
 * Get parser name for display
 */
export function getAmountParserName(id: string): string {
  const parser = getAmountParser(id);
  return parser?.name ?? id;
}

/**
 * Get parser config by ID
 */
export function getAmountParserConfig(id: string): AmountFormatConfig | null {
  const parser = getAmountParser(id);
  return parser?.config ?? null;
}

/**
 * Format an amount in cents to display string
 */
export function formatAmountForDisplay(
  cents: number,
  currency: string = "EUR"
): string {
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency,
  }).format(cents / 100);
}
