const htmlEsc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));
const headerText = value => String(value ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 160);

export const MAIL_FROM = 'sign@blacklabelbots.com';

export function buildDeliveryEmail({ envelope, signer, sender, kind, link }) {
  const title = headerText(envelope.title) || 'Document';
  const recipientName = headerText(signer.name) || 'Recipient';
  const senderName = headerText(sender.name) || 'Document sender';
  const firstName = recipientName.split(/\s+/)[0];
  const isCC = signer.role === 'cc';
  const expires = envelope.expires_at
    ? ` This link expires ${new Date(envelope.expires_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}.`
    : '';

  let subject, heading, action;
  if (kind === 'completion') {
    subject = `Completed: ${title}`;
    heading = 'Your completed document is ready';
    action = `Download the completed PDF and review its certificate of completion at your recipient-specific link.${expires}`;
  } else if (kind === 'reminder') {
    subject = `Reminder: signature requested for ${title}`;
    heading = 'Signature reminder';
    action = `${senderName} is waiting for your signature on “${title}”. Review and sign at your recipient-specific link.${expires}`;
  } else if (isCC) {
    subject = `Copy of ${title}`;
    heading = 'You were copied on a document';
    action = `A completed copy of “${title}” will become available at your recipient-specific link when signing finishes.${expires}`;
  } else {
    subject = `Signature requested: ${title}`;
    heading = 'A document needs your signature';
    action = `${senderName} asked you to review and sign “${title}”.${expires}`;
  }

  const text = `Hi ${firstName},\n\n${action}\n\nOpen document:\n${link}\n\nSent by ${senderName} via BL Sign.\nReply to this email to contact the sender.\n\nDo not forward this recipient-specific link.`;
  const html = `<!doctype html><html><body style="margin:0;background:#f4f3ef;color:#171719;font:16px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <div style="max-width:620px;margin:0 auto;padding:36px 20px">
      <div style="font-weight:800;letter-spacing:.04em;margin-bottom:26px">BL Sign</div>
      <div style="background:#fff;border:1px solid #dedbd3;border-radius:16px;padding:30px">
        <p style="margin:0 0 8px;color:#666">Hi ${htmlEsc(firstName)},</p>
        <h1 style="font-size:25px;line-height:1.2;margin:0 0 14px">${htmlEsc(heading)}</h1>
        <p style="margin:0 0 24px">${htmlEsc(action)}</p>
        <a href="${htmlEsc(link)}" style="display:inline-block;background:#171719;color:#fff;text-decoration:none;border-radius:10px;padding:13px 20px;font-weight:700">Open document</a>
        <p style="margin:24px 0 0;color:#666;font-size:13px">Sent by ${htmlEsc(senderName)} via BL Sign. Reply to contact the sender.</p>
      </div>
      <p style="color:#777;font-size:12px;margin:18px 4px">Do not forward this recipient-specific link. Report abuse: michael@blacklabelbots.com</p>
    </div></body></html>`;

  return {
    to: { email: String(signer.email).trim().toLowerCase(), name: recipientName },
    from: { email: MAIL_FROM, name: 'BL Sign' },
    replyTo: String(sender.email || '').trim().toLowerCase(),
    subject,
    html,
    text,
  };
}

export function buildVerificationEmail({ envelope, signer, sender, code, expiresMinutes = 10 }) {
  const recipientName = headerText(signer.name || 'there');
  const firstName = recipientName.split(/\s+/)[0] || 'there';
  const title = headerText(envelope.title || 'Document');
  const senderName = headerText(sender.name || sender.email || 'The sender');
  const subject = `Your BL Sign verification code: ${code}`;
  const text = `Hi ${firstName},\n\nUse this verification code to open “${title}”:\n\n${code}\n\nThe code expires in ${expiresMinutes} minutes. If you did not request it, you can ignore this email.\n\nSent by ${senderName} via BL Sign.`;
  const html = `<!doctype html><html><body style="margin:0;background:#f4f3ef;color:#171719;font:16px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <div style="max-width:620px;margin:0 auto;padding:36px 20px">
      <div style="font-weight:800;letter-spacing:.04em;margin-bottom:26px">BL Sign</div>
      <div style="background:#fff;border:1px solid #dedbd3;border-radius:16px;padding:30px">
        <p style="margin:0 0 8px;color:#666">Hi ${htmlEsc(firstName)},</p>
        <h1 style="font-size:25px;line-height:1.2;margin:0 0 14px">Confirm your email</h1>
        <p style="margin:0 0 18px">Use this code to open “${htmlEsc(title)}”:</p>
        <div style="font:800 34px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.18em;background:#f4f3ef;border-radius:10px;padding:16px 18px">${code}</div>
        <p style="margin:18px 0 0;color:#666;font-size:13px">Expires in ${expiresMinutes} minutes. Sent by ${htmlEsc(senderName)} via BL Sign.</p>
      </div>
      <p style="color:#777;font-size:12px;margin:18px 4px">If you did not request this code, you can ignore this email.</p>
    </div></body></html>`;
  return {
    to: { email: String(signer.email).trim().toLowerCase(), name: recipientName },
    from: { email: MAIL_FROM, name: 'BL Sign' },
    replyTo: String(sender.email || '').trim().toLowerCase(),
    subject,
    html,
    text,
  };
}
