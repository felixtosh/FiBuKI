// jsdom ships no types and @types/jsdom is not a dependency; the widget tests use only this much of it.
declare module "jsdom" {
  export interface JSDOMOptions {
    runScripts?: "dangerously" | "outside-only";
    pretendToBeVisual?: boolean;
    beforeParse?(window: any): void;
  }
  export class JSDOM {
    constructor(html?: string, options?: JSDOMOptions);
    readonly window: any;
  }
}
