import { html } from '../html';
import { icon } from '../icons';
import { layout, type SiteConfig } from '../layout';

/** `proof`: a /p/<id> link that has no live proof. `page`: any other unknown address. */
export function renderNotFound(site: SiteConfig, path: string, kind: 'proof' | 'page' = 'page'): string {
  return layout(
    site,
    { title: 'Not found — TrustPhoto', description: 'This page is not available.', path, noindex: true },
    kind === 'proof'
      ? html`<section class="empty">
  ${icon('search', 'empty-icon')}
  <h1>This proof is not available.</h1>
  <p class="lead">The link is wrong, or the photo was removed.</p>
  <a class="button button-primary" href="/#check">Check a photo</a>
</section>`
      : html`<section class="empty">
  ${icon('search', 'empty-icon')}
  <h1>This page is not available.</h1>
  <p class="lead">Check the address.</p>
  <a class="button button-primary" href="/">Go to TrustPhoto</a>
</section>`,
  );
}

export function renderPrivacy(site: SiteConfig): string {
  const contact = site.contactEmail
    ? html`<a href="mailto:${site.contactEmail}">${site.contactEmail}</a>`
    : html`<strong>the contact address (not set yet)</strong>`;
  return layout(
    site,
    { title: 'Privacy — TrustPhoto', description: 'What TrustPhoto keeps, for how long, and how to remove it.', path: '/privacy' },
    html`<article class="prose">
  <h1>Privacy</h1>
  <p class="lead">TrustPhoto has no accounts. We keep only what a proof needs. <a href="/#claims">What a proof shows</a></p>

  <h2>Who we are</h2>
  <ul>
    <li>${site.operator ?? 'The operator (not set yet)'} runs TrustPhoto. Write to ${contact} about your data or to remove a photo.</li>
  </ul>

  <h2>When you take a photo</h2>
  <ul>
    <li>The app records how the phone moves for a few seconds before the shot. It sends that motion data with the photo, the phone model and a device check from Apple or Google.</li>
    <li>We publish a verified photo on a proof page. Anyone with the link can see it. Anyone with a copy of the photo can find the page with Check a photo. This includes a resized, cropped, mirrored or edited copy, and a screenshot that shows the photo.</li>
    <li>The proof page shows the photo, the phone model and the time we received the photo. We remove all photo metadata first, so the location is never public.</li>
    ${site.visionProvider ? html`<li>To find photos of screens, we send a copy without metadata to our vision provider, ${site.visionProvider}.</li>` : ''}
    <li>We do not publish a photo that does not pass.</li>
  </ul>

  <h2>What we keep, and for how long</h2>
  <ul>
    <li><strong>A verified photo:</strong> the public copy and its preview, until you delete the photo.</li>
    <li><strong>Every photo we check, verified or not:</strong> a record with its fingerprints (hashes of the photo and of the motion data), the phone model, the app version, the times and the check results. We keep it as long as TrustPhoto runs, so the same photo or motion can never verify twice. It holds no photo, no motion data and no location.</li>
    <li><strong>We do not keep</strong> the original photo file or the motion data.</li>
    <li><strong>The app install:</strong> a random ID and a hash of its key, as long as TrustPhoto runs. On an iPhone, also the public part of the device key that Apple made for the app, and a counter that the key moves forward with each photo. No name, email or phone number.</li>
    <li><strong>Reports:</strong> the reason, the details you write and a keyed hash of your IP address, as long as TrustPhoto runs, so one person cannot report a photo many times.</li>
    <li><strong>Android phone checks:</strong> a keyed hash of your IP address with the install ID, for up to two days, to limit abuse of the Google check.</li>
  </ul>

  <h2>When you check a photo on this site</h2>
  <ul>
    <li>Your browser makes fingerprints of the photo: short codes made from its detail. If the photo may match a verified photo, the browser also sends a coarse pattern of its light and dark spots (2,304 on or off values, no colours) and how the photo sits on the verified photo (size, shift and turn), so that we can confirm it. Only these come to us. The photo stays on your device, and we do not keep the fingerprints.</li>
  </ul>

  <h2>Deleting a photo</h2>
  <ul>
    <li>Open the photo in the app and choose Delete. The proof page closes at once. Copies in browser and network caches can stay for up to one hour. Copies that people saved or were sent, and link previews in other apps, can stay.</li>
    <li>We can also remove a photo after a report.</li>
    <li>After you delete a photo, we keep its record (see above), so the same photo cannot verify again. We do not keep the photo.</li>
    <li>Only the phone that took a photo can delete it in the app. After you delete the app on Android, or move to a new phone, write to ${contact} with the proof link. We remove the photo.</li>
    <li>To ask us to erase your records, write to ${contact}.</li>
  </ul>
</article>`,
  );
}
