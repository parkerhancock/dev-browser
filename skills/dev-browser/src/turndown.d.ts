// Minimal ambient types for turndown (no @types package installed).
declare module "turndown" {
  interface TurndownOptions {
    headingStyle?: "setext" | "atx";
    codeBlockStyle?: "indented" | "fenced";
    bulletListMarker?: "-" | "+" | "*";
    emDelimiter?: "_" | "*";
  }
  class TurndownService {
    constructor(options?: TurndownOptions);
    turndown(html: string): string;
    remove(filter: string | string[]): this;
  }
  export = TurndownService;
}
