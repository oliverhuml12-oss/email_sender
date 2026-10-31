// Template rendering, tracking rewrites and HTML -> text. Mirrored in web/src/lib/render.ts for previews.

export type Contact = {
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
  fields?: Record<string, unknown> | null;
};

const VAR = /\{\{\s*([a-zA-Z0-9_.\- ]+?)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function lookup(contact: Contact, extra: Record<string, string>, key: string): string {
  const k = key.trim();
  if (k in extra) return extra[k];
  const direct: Record<string, unknown> = {
    email: contact.email,
    first_name: contact.first_name,
    last_name: contact.last_name,
    company: contact.company,
  };
  let v: unknown = direct[k];
  if (v === undefined || v === null || v === "") {
    const f = contact.fields ?? {};
    v = f[k] ?? f[k.replace(/^fields\./, "")];
  }
  return v === undefined || v === null ? "" : String(v);
}

/** Replace {{var}} / {{var | fallback}}. In HTML mode contact values are escaped; extra values are inserted raw. */
export function fill(tpl: string, contact: Contact, extra: Record<string, string>, html: boolean): string {
  return tpl.replace(VAR, (_m, key: string, fallback: string | undefined) => {
    const raw = lookup(contact, extra, key);
    const val = raw !== "" ? raw : (fallback ?? "");
    if (!html || key.trim() in extra) return val;
    return escapeHtml(val);
  });
}

export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<(head|style|script|title)[^>]*>[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) => {
    const t = text.replace(/<[^>]+>/g, "").trim();
    if (!t || t === href) return href;
    if (href.startsWith("mailto:")) return t;
    return `${t} (${href})`;
  });
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|h[1-6]|tr|table|li|blockquote)>/gi, "\n\n");
  s = s.replace(/<li[^>]*>/gi, "- ");
  s = s.replace(/<[^>]+>/g, "");
  s = s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)));
  s = s.split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).join("\n");
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

/** Rewrite http(s) links to go through the click tracker. Returns new html and the original link list. */
export function trackLinks(html: string, makeUrl: (i: number) => string, skip: (href: string) => boolean) {
  const links: string[] = [];
  const out = html.replace(/(<a\s[^>]*?href=)(["'])(https?:\/\/[^"']+)\2/gi, (m, pre: string, q: string, href: string) => {
    const decoded = href.replace(/&amp;/g, "&");
    if (skip(decoded)) return m;
    links.push(decoded);
    return `${pre}${q}${makeUrl(links.length - 1)}${q}`;
  });
  return { html: out, links };
}

function insertBeforeBodyEnd(html: string, snippet: string): string {
  const i = html.search(/<\/body>/i);
  return i >= 0 ? html.slice(0, i) + snippet + html.slice(i) : html + snippet;
}

export type RenderInput = {
  subject: string;
  html: string;
  text_body?: string | null;
  footer_html: string;
  footer_text: string;
};

export type RenderOptions = {
  unsubscribeUrl: string;
  clickUrl?: (i: number) => string; // set to enable click tracking
  pixelUrl?: string; // set to enable open tracking
};

export function renderEmail(t: RenderInput, contact: Contact, opts: RenderOptions) {
  const extra = { unsubscribe_url: opts.unsubscribeUrl };
  const subject = fill(t.subject, contact, extra, false).replace(/[\r\n]+/g, " ").trim();

  let html = fill(t.html || "", contact, extra, true);
  const hasUnsubHtml = /\{\{\s*unsubscribe_url/.test(t.html || "");
  let links: string[] = [];
  if (opts.clickUrl) {
    const r = trackLinks(html, opts.clickUrl, (href) => href === opts.unsubscribeUrl);
    html = r.html;
    links = r.links;
  }
  if (!hasUnsubHtml) html = insertBeforeBodyEnd(html, fill(t.footer_html, contact, extra, true));
  if (opts.pixelUrl) {
    html = insertBeforeBodyEnd(
      html,
      `<img src="${opts.pixelUrl}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px;" />`,
    );
  }
  if (!/<html[\s>]/i.test(html)) {
    html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${html}</body></html>`;
  }

  const textSource = t.text_body && t.text_body.trim() ? fill(t.text_body, contact, extra, false) : htmlToText(
    fill(t.html || "", contact, extra, true),
  );
  const hasUnsubText = /\{\{\s*unsubscribe_url/.test(t.text_body || t.html || "");
  const text = hasUnsubText ? textSource : `${textSource}\n\n${fill(t.footer_text, contact, extra, false)}`;

  return { subject, html, text, links };
}
