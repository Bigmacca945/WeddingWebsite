(function initSheetRsvp() {
  const frame = document.getElementById('rsvp-sheet-frame');
  const status = document.getElementById('rsvp-connection-status');
  const openLink = document.getElementById('rsvp-open-form');
  if (!frame || !status || !openLink) return;

  const appUrl = window.WEDDING_RSVP?.appUrl;
  if (!appUrl) return;
  if (typeof appUrl !== 'string' || !/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(appUrl)) {
    status.textContent = 'The RSVP connection is not configured correctly. Please contact Cathan or Laura.';
    status.setAttribute('role', 'alert');
    return;
  }

  const channel = crypto.randomUUID();
  const embeddedUrl = new URL(appUrl);
  embeddedUrl.searchParams.set('channel', channel);
  status.textContent = 'Loading your private RSVP form. If it does not appear, use the new-tab link below.';
  openLink.href = appUrl;
  openLink.hidden = false;
  frame.src = embeddedUrl.href;
  frame.hidden = false;

  // Apps Script's HTML service uses a nested googleusercontent.com iframe.
  window.addEventListener('message', event => {
    if (!/^https:\/\/(?:[a-z0-9-]+-)?script\.googleusercontent\.com$/.test(event.origin)) return;
    const data = event.data;
    if (!data || data.type !== 'wedding-rsvp-height' || data.channel !== channel ||
        !Number.isFinite(data.height) || data.height <= 0) return;
    frame.style.height = `${Math.min(4000, Math.max(480, Math.ceil(data.height)))}px`;
    status.hidden = true;
  });
}());
