import { describe, expect, it } from 'vitest';
import { INCONCLUSIVE_NOTE, PROOF_LIMITS, TEST_PROOF_NOTE, type PublicPhoto } from '@trustphoto/shared';
import { html, raw } from '../html';
import { formatUtc, renderHome, renderNotFound, renderPrivacy, renderProof } from '../index';

const site = { baseUrl: 'https://trustphoto.test', appStoreUrl: null, playStoreUrl: null, operator: 'Example Oy', contactEmail: 'privacy@example.com', visionProvider: 'Example Vision, in the EU' };
const photo: PublicPhoto = {
  id: 'Abc123Def456',
  url: 'https://trustphoto.test/p/Abc123Def456',
  imageUrl: 'https://trustphoto.test/i/Abc123Def456.jpg',
  receivedAt: '2026-11-24T14:03:00.000Z',
  device: '<img src=x onerror=alert(1)>',
  width: 1600,
  height: 1200,
  isTest: false,
  checks: [
    { key: 'device', state: 'passed' },
    { key: 'motion', state: 'inconclusive' },
  ],
};

describe('html', () => {
  it('escapes every value and keeps trusted markup', () => {
    expect(html`<p title="${'"x"'}">${'<b>'}${raw('<i>ok</i>')}${['a', '&']}</p>`.value).toBe('<p title="&quot;x&quot;">&lt;b&gt;<i>ok</i>a&amp;</p>');
  });
});

describe('proof page', () => {
  it('escapes the phone label the phone reported', () => {
    const page = renderProof(site, photo);
    expect(page).not.toContain('<img src=x');
    expect(page).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('shows UTC time, link preview tags and each check state', () => {
    const page = renderProof(site, photo);
    expect(formatUtc(photo.receivedAt)).toBe('24 Nov 2026, 14:03 UTC');
    expect(page).toContain('24 Nov 2026, 14:03 UTC');
    expect(page).toContain('<meta property="og:image" content="https://trustphoto.test/i/Abc123Def456/preview.jpg">');
    expect(page).toContain('Passed');
    expect(page).toContain('No clear result');
    expect(page).toContain('A phone camera took this photo.');
  });

  it('never presents a test proof as verified', () => {
    // As the server makes them: a test proof has no passed device check.
    const page = renderProof(site, { ...photo, isTest: true, checks: [{ key: 'device', state: 'inconclusive' }] });
    expect(page).toContain('This is not a real proof.');
    expect(page).not.toContain('badge-verified');
    expect(page).not.toContain('data-copy');
    expect(page).toContain('brand-mark neutral');
    expect(page).toContain('favicon-test.svg');
    expect(page).not.toContain('og:image');
    expect(page).toContain(TEST_PROOF_NOTE);
    expect(page).not.toContain(INCONCLUSIVE_NOTE);
    expect(page).toContain('Did not run');
  });

  it('says what a proof cannot show, and that it covers only the photo on the page', () => {
    const page = renderProof(site, photo);
    expect(page).toContain(PROOF_LIMITS);
    expect(page).toContain('This proof is only for the photo on this page.');
  });

  it('explains "No clear result" only when a check has one', () => {
    expect(renderProof(site, photo)).toContain(INCONCLUSIVE_NOTE);
    expect(renderProof(site, { ...photo, checks: [{ key: 'device', state: 'passed' }] })).not.toContain(INCONCLUSIVE_NOTE);
  });

  it('warns a reader who came from a similar match that their file is a different file', () => {
    expect(renderProof(site, photo, { fromSimilar: true })).toContain('Your file is not this file.');
    expect(renderProof(site, photo)).not.toContain('Your file is not this file.');
  });
});

describe('privacy page', () => {
  it('names the vision provider when there is one, and says nothing about a vision check when there is none', () => {
    expect(renderPrivacy(site)).toContain('our vision provider, Example Vision, in the EU.');
    expect(renderPrivacy({ ...site, visionProvider: null })).not.toContain('vision provider');
  });

  it('names the operator and the address for removal, and lists what is kept', () => {
    const page = renderPrivacy(site);
    expect(page).toContain('Example Oy runs TrustPhoto');
    expect(page).toContain('mailto:privacy@example.com');
    expect(page).toContain('What we keep, and for how long');
  });
});

describe('not found', () => {
  it('blames a missing proof only on proof links', () => {
    expect(renderNotFound(site, '/p/x', 'proof')).toContain('This proof is not available.');
    expect(renderNotFound(site, '/about')).toContain('This page is not available.');
  });
});

describe('home page', () => {
  it('before release, offers Check a photo and no Get section; after, the store links', () => {
    const before = renderHome(site);
    expect(before).toContain('coming soon');
    expect(before).not.toContain('id="get"');
    expect(before).toContain('href="#check"');
    const withStores = renderHome({ ...site, appStoreUrl: 'https://apps.apple.com/app/id1', playStoreUrl: null });
    expect(withStores).toContain('href="https://apps.apple.com/app/id1"');
    expect(withStores).not.toContain('Get it for Android');
  });
});
