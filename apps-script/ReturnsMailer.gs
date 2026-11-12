/**
 * GoodTech staff portal → Returns: sends queued customer emails (return labels) from the service mailbox.
 *
 * Install once, signed in as the service mailbox account:
 *   1. script.google.com → New project → paste this file.
 *   2. Project Settings → Script properties → add RETURNS_MAIL_TOKEN = <token from Fraser>.
 *   3. Run `sendQueuedReturnEmails` once and allow the Gmail permission.
 *   4. Triggers → Add trigger → sendQueuedReturnEmails, time-driven, every minute.
 * Emails are sent from this account, so customer replies land in the service inbox.
 */
var RETURNS_URL = 'https://mniqcdqajhhsrvfagmra.supabase.co/functions/v1/portal-returns';

function returnsCall_(action, body) {
  var token = PropertiesService.getScriptProperties().getProperty('RETURNS_MAIL_TOKEN');
  if (!token) throw new Error('Set the RETURNS_MAIL_TOKEN script property.');
  var payload = body || {};
  payload.action = action;
  var r = UrlFetchApp.fetch(RETURNS_URL, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(payload),
    headers: { 'x-mail-token': token }, muteHttpExceptions: true,
  });
  var data = JSON.parse(r.getContentText() || '{}');
  if (r.getResponseCode() >= 300) throw new Error('Portal: ' + (data.error || r.getResponseCode()));
  return data;
}

function sendQueuedReturnEmails() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    var emails = returnsCall_('mail.pending').emails || [];
    emails.forEach(function (m) {
      try {
        var options = { name: 'GoodTech' };
        if (m.attachment_b64) {
          options.attachments = [Utilities.newBlob(Utilities.base64Decode(m.attachment_b64), 'application/pdf', m.attachment_name || 'label.pdf')];
        }
        GmailApp.sendEmail(m.to_email, m.subject, m.body, options);
        returnsCall_('mail.ack', { id: m.id, ok: true });
      } catch (e) {
        returnsCall_('mail.ack', { id: m.id, ok: false, error: String(e && e.message || e).slice(0, 400) });
      }
    });
  } finally {
    lock.releaseLock();
  }
}
