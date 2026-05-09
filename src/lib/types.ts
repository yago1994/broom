export type RuleType = "hide" | "restyle" | "inject" | "replace";

export interface RuleSelector {
  primary: string;
  fallbacks: string[];
  semantic: string;
}

export interface HidePayload {
  kind: "hide";
}

export interface RestylePayload {
  kind: "restyle";
  css: string;
}

export interface InjectPayload {
  kind: "inject";
  html: string;
  position: "before" | "after" | "prepend" | "append";
}

export interface ReplacePayload {
  kind: "replace";
  schema: A2UIComponentSchema;
}

export type RulePayload =
  | HidePayload
  | RestylePayload
  | InjectPayload
  | ReplacePayload;

export interface Rule {
  id: string;
  hostname: string;
  type: RuleType;
  selector: RuleSelector;
  payload: RulePayload;
  enabled: boolean;
  createdAt: number;
  lastAppliedAt: number | null;
  lastFailedAt: number | null;
  failCount: number;
}

// v1 catalog placeholder (replace flow not yet implemented).
export type A2UIComponentSchema =
  | { component: "PlainText"; props: { text: string } }
  | { component: "ArticleView"; props: { title: string; body: string; readingTime?: string } }
  | { component: "List"; props: { items: { title: string; meta?: string; body?: string }[] } }
  | { component: "Table"; props: { headers: string[]; rows: string[][] } }
  | { component: "CardGrid"; props: { cards: { title: string; image?: string; body: string; link?: string }[] } };

export interface Settings {
  provider: "anthropic";
  model: string;
  apiKey: string;
}

// Message protocol — content <-> background <-> popup
export type Msg =
  | { type: "BG_GENERATE_RULE"; instruction: string; ruleType: RuleType; element: ElementContext; hostname: string }
  | { type: "BG_GENERATE_RULE_RESULT"; ok: true; rule: Rule } | { type: "BG_GENERATE_RULE_RESULT"; ok: false; error: string }
  | { type: "POPUP_START_PICKER" }
  | { type: "CONTENT_START_PICKER" }
  | { type: "CONTENT_APPLY_RULE"; rule: Rule }
  | { type: "CONTENT_REMOVE_RULE"; ruleId: string }
  | { type: "ACK" };

export interface ElementContext {
  outerHTML: string;       // truncated
  tagName: string;
  id: string | null;
  classes: string[];
  selectorGuess: string;   // from finder
  parentSelectorGuess: string | null;
  textSnippet: string;
}
