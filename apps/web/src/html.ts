/** Tiny HTML templating: every interpolated value is escaped unless it is a SafeHtml from html`` or raw(). */

export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

type Value = SafeHtml | string | number | boolean | null | undefined | Value[];

function render(value: Value): string {
  if (value === null || value === undefined || value === false) return '';
  if (Array.isArray(value)) return value.map(render).join('');
  if (value instanceof SafeHtml) return value.value;
  return escapeHtml(String(value));
}

export function html(strings: TemplateStringsArray, ...values: Value[]): SafeHtml {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

/** Trusted markup only (our own icons). */
export function raw(markup: string): SafeHtml {
  return new SafeHtml(markup);
}
