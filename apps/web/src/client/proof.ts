/** Proof page: local time, copy and share the link, report the photo. */

import { formatLocal } from './time';

for (const node of document.querySelectorAll<HTMLTimeElement>('time[data-local]')) {
  node.textContent = formatLocal(node.dateTime);
}

const announcer = document.getElementById('announcer');
function announce(text: string): void {
  if (!announcer) return;
  announcer.textContent = '';
  // A fresh text node makes screen readers read it again for a repeat copy.
  setTimeout(() => (announcer.textContent = text), 50);
}

const copyButton = document.querySelector<HTMLButtonElement>('[data-copy]');
copyButton?.addEventListener('click', async () => {
  const label = copyButton.querySelector('span');
  let text = 'Link copied';
  try {
    await navigator.clipboard.writeText(copyButton.dataset.copy ?? location.href);
    if (label) label.textContent = 'Copied';
  } catch {
    text = 'The link did not copy. Select the address bar and copy it.';
    if (label) label.textContent = 'Copy failed';
  }
  announce(text);
  setTimeout(() => {
    if (label) label.textContent = 'Copy link';
  }, 2000);
});

const shareButton = document.querySelector<HTMLButtonElement>('[data-share]');
if (shareButton && typeof navigator.share === 'function') {
  shareButton.hidden = false;
  shareButton.addEventListener('click', () => {
    navigator.share({ title: 'TrustPhoto proof', url: shareButton.dataset.share }).catch(() => undefined);
  });
}

const dialog = document.getElementById('report-dialog') as HTMLDialogElement | null;
const form = document.getElementById('report-form') as HTMLFormElement | null;
const status = form?.querySelector<HTMLParagraphElement>('.form-status');
const submit = form?.querySelector<HTMLButtonElement>('button[type="submit"]');

document.querySelector('[data-report]')?.addEventListener('click', () => {
  form?.reset();
  if (status) status.textContent = '';
  if (submit) submit.disabled = false;
  dialog?.showModal();
});
form?.querySelector('[data-close]')?.addEventListener('click', () => dialog?.close());

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const reason = data.get('reason');
  const details = String(data.get('details') ?? '').trim();
  if (!reason || !submit || !status) return;
  submit.disabled = true;
  status.textContent = 'Sending…';
  try {
    const res = await fetch(`/v1/photos/${encodeURIComponent(form.dataset.photo ?? '')}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(details ? { reason, details } : { reason }),
    });
    if (!res.ok) throw new Error(String(res.status));
    status.textContent = 'Thank you. We got your report.';
    setTimeout(() => dialog?.close(), 1600);
  } catch {
    status.textContent = 'The report did not send. Try again.';
    submit.disabled = false;
  }
});
