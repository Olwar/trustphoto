import { html, type SafeHtml } from './html';
import { icon } from './icons';

export interface SiteConfig {
  /** Origin without a trailing slash, e.g. https://photos.example.com */
  baseUrl: string;
  appStoreUrl: string | null;
  playStoreUrl: string | null;
  /** Who runs the service (OPERATOR_NAME), shown on the privacy page. */
  operator: string | null;
  /** Where people ask for removal and erasure (CONTACT_EMAIL). */
  contactEmail: string | null;
  /** Who gets a copy of a would-pass photo for the vision check ("Example AI, in the EU"); null with no vision check. */
  visionProvider: string | null;
}

export interface PageMeta {
  title: string;
  description: string;
  /** Path for the canonical URL, e.g. "/p/abc". */
  path: string;
  /** Absolute image URL for link previews. */
  image?: string;
  imageAlt?: string;
  /** Scripts under /assets/, loaded as modules. */
  scripts?: string[];
  noindex?: boolean;
  /** Grey brand mark, so a test-proof page shows no green seal at all. */
  neutralBrand?: boolean;
}

export function layout(site: SiteConfig, meta: PageMeta, body: SafeHtml): string {
  const url = `${site.baseUrl}${meta.path}`;
  return `<!doctype html>${html`<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${meta.title}</title>
<meta name="description" content="${meta.description}">
<link rel="canonical" href="${url}">
${meta.noindex ? html`<meta name="robots" content="noindex">` : ''}
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">
<meta property="og:site_name" content="TrustPhoto">
<meta property="og:type" content="website">
<meta property="og:title" content="${meta.title}">
<meta property="og:description" content="${meta.description}">
<meta property="og:url" content="${url}">
${meta.image
  ? html`<meta property="og:image" content="${meta.image}">
<meta property="og:image:alt" content="${meta.imageAlt ?? meta.title}">
<meta name="twitter:card" content="summary_large_image">`
  : html`<meta name="twitter:card" content="summary">`}
<link rel="icon" href="/assets/${meta.neutralBrand ? 'favicon-test.svg' : 'favicon.svg'}" type="image/svg+xml">
<link rel="stylesheet" href="/assets/styles.css">
${(meta.scripts ?? []).map((s) => html`<script type="module" src="/assets/${s}"></script>`)}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="nav">
  <div class="nav-inner">
    <a class="brand" href="/" aria-label="TrustPhoto home">${icon('seal', meta.neutralBrand ? 'brand-mark neutral' : 'brand-mark')}<span>TrustPhoto</span></a>
    <nav aria-label="Main">${navLinks(site)}</nav>
  </div>
</header>
<main id="main">${body}</main>
<footer class="footer">
  <div class="footer-inner">
    <span>TrustPhoto</span>
    <a href="/privacy">Privacy</a>
    <a href="/.well-known/trustphoto-keys.json">Signing key (for developers)</a>
  </div>
</footer>
</body>
</html>`}`;
}

export const isReleased = (site: SiteConfig) => Boolean(site.appStoreUrl || site.playStoreUrl);

/** Before the app is out, "Check a photo" is the one thing a visitor can do, so it is the only button. */
function navLinks(site: SiteConfig): SafeHtml {
  return isReleased(site)
    ? html`<a class="nav-secondary" href="/#check">Check a photo</a><a class="nav-cta" href="/#get">Get the app</a>`
    : html`<a class="nav-cta" href="/#check">Check a photo</a>`;
}

/** Store badges, or a plain note before the app is out. */
export function storeButtons(site: SiteConfig): SafeHtml {
  if (!site.appStoreUrl && !site.playStoreUrl) {
    return html`<p class="soon">${icon('phone')} The app is coming soon to iPhone and Android.</p>`;
  }
  return html`<div class="stores">
    ${site.appStoreUrl ? html`<a class="button button-primary" href="${site.appStoreUrl}">Download for iPhone</a>` : ''}
    ${site.playStoreUrl ? html`<a class="button button-secondary" href="${site.playStoreUrl}">Get it for Android</a>` : ''}
  </div>`;
}
