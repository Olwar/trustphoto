import { html } from '../html';
import { icon } from '../icons';
import { isReleased, layout, storeButtons, type SiteConfig } from '../layout';

/** The hero picture: a sample proof card around a drawn landscape (no stock photo, nothing to license). */
const sampleCard = html`<div class="sample" aria-hidden="true">
  <svg class="sample-photo" viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice">
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#2b5876"/><stop offset=".55" stop-color="#f4a261"/><stop offset="1" stop-color="#f7d08a"/>
      </linearGradient>
      <linearGradient id="hill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#3a4a5c"/><stop offset="1" stop-color="#1f2833"/>
      </linearGradient>
    </defs>
    <rect width="400" height="300" fill="url(#sky)"/>
    <circle cx="270" cy="170" r="34" fill="#fff3d6" opacity=".9"/>
    <path d="M0 210 C 70 170 120 190 180 175 S 300 150 400 185 V300 H0Z" fill="#5b6b7d"/>
    <path d="M0 240 C 90 215 160 235 230 220 S 340 210 400 228 V300 H0Z" fill="url(#hill)"/>
  </svg>
  <div class="sample-body">
    <p class="badge badge-verified">${icon('seal')} Verified</p>
    <p class="sample-title">A phone camera took this photo.</p>
    <p class="sample-meta">Received today at 7:42 · iPhone</p>
  </div>
</div>`;

export function renderHome(site: SiteConfig): string {
  return layout(
    site,
    {
      title: 'TrustPhoto — Proof that a phone took the photo',
      description: 'Take a photo in TrustPhoto and share its link anywhere. Anyone can see that a phone camera took it, and when.',
      path: '/',
      scripts: ['check.js'],
    },
    html`
<section class="hero">
  <div class="hero-text">
    <h1>Proof that a phone took the photo.</h1>
    <p class="lead">Take a photo in TrustPhoto. Share its link anywhere. People see that a phone camera took it, and when.</p>
    ${isReleased(site)
      ? storeButtons(site)
      : html`<div class="stores"><a class="button button-primary" href="#check">${icon('search')}<span>Check a photo</span></a></div>${storeButtons(site)}`}
  </div>
  ${sampleCard}
</section>

<section class="steps" aria-labelledby="how">
  <h2 id="how" class="section-title">How it works</h2>
  <ol class="step-list">
    <li>${icon('camera', 'step-icon')}<h3>Take the photo</h3><p>Use the TrustPhoto camera. It records how the phone moves at the shot.</p></li>
    <li>${icon('seal', 'step-icon')}<h3>We check it</h3><p>Our server checks the phone, the motion and the image. It takes a few seconds.</p></li>
    <li>${icon('link', 'step-icon')}<h3>Share the link</h3><p>Post the photo with its link. Anyone with the link can see the photo and its proof.</p></li>
  </ol>
</section>

<section id="check" class="check" aria-labelledby="check-title">
  <h2 id="check-title" class="section-title">Check a photo</h2>
  <p class="section-lead">Find the proof of a photo you saw. A crop or a screenshot of it works too. The photo stays on your device.</p>
  <label class="drop" id="drop" for="file">
    ${icon('image', 'drop-icon')}
    <span class="drop-title"><span class="on-pointer">Drop a photo here</span><span class="on-touch">Choose a photo</span></span>
    <span class="drop-hint"><span class="on-pointer">or <span class="link">choose a file</span> · </span>JPEG, PNG, WebP or AVIF</span>
    <input id="file" type="file" accept="image/jpeg,image/png,image/webp,image/avif" class="visually-hidden">
  </label>
  <div id="result" class="result" role="status" aria-live="polite"></div>
  <noscript><p class="note">Turn on JavaScript to check a photo.</p></noscript>
</section>

<section id="claims" class="claims" aria-labelledby="claims-title">
  <h2 id="claims-title" class="section-title">What a proof shows</h2>
  <div class="claim-grid">
    <div class="claim">
      <h3>It shows</h3>
      <ul class="ticks">
        <li>${icon('check')} A phone camera took the photo in the TrustPhoto app.</li>
        <li>${icon('check')} The original file came straight from the camera. The proof page shows a copy without metadata.</li>
        <li>${icon('check')} The time our server received it.</li>
      </ul>
    </div>
    <div class="claim">
      <h3>It does not show</h3>
      <ul class="ticks ticks-muted">
        <li>${icon('minus')} Where the photo was taken.</li>
        <li>${icon('minus')} That the scene was not staged.</li>
        <li>${icon('minus')} Who took the photo.</li>
      </ul>
    </div>
  </div>
</section>

${isReleased(site)
  ? html`<section id="get" class="get" aria-labelledby="get-title">
  <h2 id="get-title">Get TrustPhoto</h2>
  <p class="section-lead">Free. No account.</p>
  ${storeButtons(site)}
</section>`
  : ''}`,
  );
}
