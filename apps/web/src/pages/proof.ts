import { CHECK_LABELS, INCONCLUSIVE_NOTE, PROOF_LIMITS, TEST_PROOF_NOTE, type PublicPhoto, type PublicCheck } from '@trustphoto/shared';
import { html } from '../html';
import { icon } from '../icons';
import { layout, type SiteConfig } from '../layout';

/** A proof link can be posted next to any image, so the page says what it covers. */
const ONLY_THIS_PHOTO = 'This proof is only for the photo on this page. Compare it with the photo you saw.';

/** "24 Nov 2026, 14:03 UTC". The page script rewrites it in the reader's own time zone. */
export function formatUtc(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  return `${date}, ${time} UTC`;
}

/** A test proof's device row says what the lead says: the phone check did not run. */
function checkValue(check: PublicCheck, test: boolean): string {
  return test && check.key === 'device' ? 'Did not run' : 'No clear result';
}

export interface ProofOptions {
  /** The reader came from "Check a photo" with a file that only looks like this one. */
  fromSimilar?: boolean;
}

export function renderProof(site: SiteConfig, photo: PublicPhoto, opts: ProofOptions = {}): string {
  const when = formatUtc(photo.receivedAt);
  const test = photo.isTest;
  return layout(
    site,
    {
      title: test ? 'Test proof — TrustPhoto' : 'Verified photo — TrustPhoto',
      description: test
        ? 'A test proof from a development build of TrustPhoto. It is not a real proof.'
        : `${ONLY_THIS_PHOTO} A phone camera took it in the TrustPhoto app. Received ${when}.`,
      path: `/p/${photo.id}`,
      // A test proof gets no link-preview image: a shared preview must never look like a proof.
      image: test ? undefined : `${site.baseUrl}/i/${photo.id}/preview.jpg`,
      imageAlt: 'A photo with a TrustPhoto proof',
      scripts: ['proof.js'],
      noindex: true,
      neutralBrand: test,
    },
    html`
${opts.fromSimilar
  ? html`<p class="notice" role="note">${icon('info')}<span><strong>Your file is not this file.</strong> Your file, or a part of it, only looks like this photo. Compare this photo with your file before you trust your file.</span></p>`
  : ''}
<article class="proof">
  <figure class="proof-photo">
    <img src="/i/${photo.id}.jpg" width="${photo.width}" height="${photo.height}" alt="${test ? 'The photo of this test proof' : 'The photo of this proof'}" decoding="async">
  </figure>

  <div class="proof-panel">
    ${test
      ? html`<p class="badge badge-test">${icon('info')} Test proof</p>
        <h1>This is not a real proof.</h1>
        <p class="lead">A development build of TrustPhoto made it. The phone check did not run.</p>`
      : html`<p class="badge badge-verified">${icon('seal')} Verified</p>
        <h1>A phone camera took this photo.</h1>
        <p class="lead">Someone took it in the TrustPhoto app. Our server checked it.</p>
        <p class="only-this">${icon('image')}<span>${ONLY_THIS_PHOTO} <a href="/#check">Check a photo</a></span></p>`}

    <ul class="facts">
      <li>${icon('clock', 'fact-icon')}<span class="fact-label">Received</span><time class="fact-value" datetime="${photo.receivedAt}" data-local>${when}</time></li>
      ${photo.device
        ? html`<li>${icon('phone', 'fact-icon')}<span class="fact-label">Phone</span><span class="fact-value">${photo.device}</span></li>`
        : ''}
    </ul>

    <h2 class="list-title">Checks</h2>
    <ul class="facts">
      ${photo.checks.map((c) =>
        c.state === 'passed'
          ? html`<li>${icon('check', 'fact-icon ok')}<span class="fact-label">${CHECK_LABELS[c.key]}</span><span class="fact-value">Passed</span></li>`
          : html`<li>${icon('minus', 'fact-icon')}<span class="fact-label">${CHECK_LABELS[c.key]}</span><span class="fact-value">${checkValue(c, test)}</span></li>`,
      )}
    </ul>
    ${test
      ? html`<p class="limits">${TEST_PROOF_NOTE}</p>`
      : photo.checks.some((c) => c.state !== 'passed')
        ? html`<p class="limits">${INCONCLUSIVE_NOTE}</p>`
        : ''}
    <p class="limits">${PROOF_LIMITS} <a href="/#claims">What a proof shows</a></p>

    ${test
      ? ''
      : html`<div class="actions">
      <button class="button button-primary" type="button" data-copy="${photo.url}">${icon('link')}<span>Copy link</span></button>
      <button class="button button-secondary" type="button" data-share="${photo.url}" hidden>${icon('share')}<span>Share</span></button>
    </div>`}
    <ul class="fine">
      <li><a href="/i/${photo.id}.jpg" download="trustphoto-${photo.id}.jpg">Download photo</a></li>
      <li><a href="/p/${photo.id}/receipt.json" title="A signed JSON record of this proof, for developers">Signed receipt (for developers)</a></li>
      <li><button class="text-button" type="button" data-report>Report this photo</button></li>
    </ul>
    <p id="announcer" class="visually-hidden" role="status" aria-live="polite"></p>
  </div>
</article>

<dialog id="report-dialog" class="sheet" aria-labelledby="report-title">
  <form method="dialog" id="report-form" data-photo="${photo.id}">
    <h2 id="report-title">Report this photo</h2>
    <fieldset>
      <legend>What is wrong?</legend>
      <label><input type="radio" name="reason" value="not_real" required> It is not a real photo</label>
      <label><input type="radio" name="reason" value="private"> It shows private information</label>
      <label><input type="radio" name="reason" value="offensive"> It is offensive or illegal</label>
      <label><input type="radio" name="reason" value="other"> Something else</label>
    </fieldset>
    <label class="details-label" for="report-details">More details (optional)</label>
    <textarea id="report-details" name="details" rows="3" maxlength="500"></textarea>
    ${site.contactEmail
      ? html`<p class="form-note">Is this a photo of you, or did you take it and lose the phone? Write to <a href="mailto:${site.contactEmail}">${site.contactEmail}</a> to have it removed.</p>`
      : ''}
    <p class="form-status" role="status" aria-live="polite"></p>
    <div class="sheet-actions">
      <button class="button button-secondary" type="button" data-close>Cancel</button>
      <button class="button button-primary" type="submit">Send report</button>
    </div>
  </form>
</dialog>`,
  );
}
