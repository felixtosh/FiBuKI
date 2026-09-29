export interface HeaderRule {
  source: string;
  headers: { key: string; value: string }[];
}

export function securityHeaderRules(csp: string): HeaderRule[];
