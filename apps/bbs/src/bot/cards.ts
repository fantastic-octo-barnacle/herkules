/**
 * Feishu interactive card builders (card JSON schema 2.0). Every builder returns plain JSON;
 * `present.ts` freezes the result as an `interactive` payload.
 *
 * Text placed inside `markdown` elements must go through `md()`: forum titles contain `[1]`
 * reference markers, asterisks and angle brackets that Feishu would otherwise interpret.
 */

export type CardTemplate = "blue" | "green" | "orange" | "red" | "grey" | "indigo";

export interface CardElement {
  readonly tag: string;
  readonly [key: string]: unknown;
}

export interface Card {
  readonly schema: "2.0";
  readonly config: { readonly wide_screen_mode: true; readonly update_multi: true };
  readonly header: {
    readonly title: { readonly tag: "plain_text"; readonly content: string };
    readonly subtitle?: { readonly tag: "plain_text"; readonly content: string };
    readonly template: CardTemplate;
  };
  readonly body: { readonly elements: readonly CardElement[] };
}

const MARKDOWN_SPECIALS: Record<string, string> = {
  "[": "［",
  "]": "］",
  "*": "＊",
  "~": "～",
  "`": "ˋ",
  "<": "＜",
  ">": "＞",
  "#": "＃",
};

/** Neutralises card-markdown syntax in user or corpus text and collapses whitespace to one line. */
export function md(text: string): string {
  return text
    .replace(/[[\]*~`<>#]/gu, (char) => MARKDOWN_SPECIALS[char] ?? char)
    .replace(/\s+/gu, " ")
    .trim();
}

/** Feishu only accepts absolute http(s) URLs in link syntax; anything else is rendered as text. */
export function link(text: string, url: string): string {
  return /^https?:\/\//iu.test(url) ? `[${md(text)}](${url})` : md(text);
}

export function card(
  title: string,
  elements: readonly CardElement[],
  options: { readonly template?: CardTemplate; readonly subtitle?: string } = {},
): Card {
  return {
    schema: "2.0",
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      title: { tag: "plain_text", content: title },
      ...(options.subtitle ? { subtitle: { tag: "plain_text", content: options.subtitle } } : {}),
      template: options.template ?? "blue",
    },
    body: { elements },
  };
}

export function markdown(content: string): CardElement {
  return { tag: "markdown", content };
}

export function hr(): CardElement {
  return { tag: "hr" };
}

/** Small grey helper line; schema 2.0 dropped the dedicated `note` element. */
export function note(text: string): CardElement {
  return markdown(`<font color='grey'>${text}</font>`);
}

/** Two-column label/value layout. Values are markdown. */
export function kvTable(rows: readonly (readonly [label: string, value: string])[]): CardElement {
  return {
    tag: "column_set",
    flex_mode: "none",
    horizontal_spacing: "8px",
    columns: [
      {
        tag: "column",
        width: "weighted",
        weight: 1,
        elements: [
          markdown(rows.map(([label]) => `<font color='grey'>${md(label)}</font>`).join("\n")),
        ],
      },
      {
        tag: "column",
        width: "weighted",
        weight: 3,
        elements: [markdown(rows.map(([, value]) => value).join("\n"))],
      },
    ],
  };
}

export function linkButton(
  text: string,
  url: string,
  options: { readonly primary?: boolean } = {},
): CardElement {
  return {
    tag: "button",
    text: { tag: "plain_text", content: text },
    type: options.primary ? "primary" : "default",
    behaviors: [{ type: "open_url", default_url: url }],
  };
}

/** Button whose click reaches the bot as a `card.action.trigger` callback carrying `value`. */
export function callbackButton(
  text: string,
  value: Record<string, unknown>,
  options: { readonly primary?: boolean } = {},
): CardElement {
  return {
    tag: "button",
    text: { tag: "plain_text", content: text },
    type: options.primary ? "primary" : "default",
    behaviors: [{ type: "callback", value }],
  };
}

export function buttonRow(...buttons: readonly CardElement[]): CardElement {
  return {
    tag: "column_set",
    flex_mode: "none",
    horizontal_spacing: "8px",
    columns: buttons.map((button) => ({
      tag: "column",
      width: "auto",
      elements: [button],
    })),
  };
}

export function errorCard(title: string, detail: string, hint: string): Card {
  return card(title, [markdown(detail), note(hint)], { template: "red" });
}
