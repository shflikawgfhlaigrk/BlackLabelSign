# Controlled private email acceptance

Outcome: NOT DONE for the full real-email customer journey. The reusable tooling has focused fake-REST evidence; actual signing, final retrieval and new-browser sender recovery still require owner inbox input and founder acceptance. Root owns the real-mail receipts and the next owner-ready checkpoint. No automated follow-up, resend or future-time job is created.

This helper is separate from the synthetic inbox preview at `http://localhost:18788`. Its default review route is `http://localhost:18889/__private`, bound only to loopback. HTTP models edge TLS termination into the exact Worker while keeping every emailed recipient URL on that same local listener. The owner sees no certificate warning. `--https-fixture` is available only for an isolated automated client using the existing synthetic fixture; it does not authorize manual certificate bypass or a system trust/permission change.

The already approved subset has exactly one controlled owner recipient, with no subscription or real contract:

- From: `sign@blacklabelbots.com`; to/reply address supplied explicitly by `OWNER_APPROVED_TEST_EMAIL` (the approved owner is `mtuburnsbarber@gmail.com`). No guessed address, extra recipient, CC, BCC, alternate sender, header or attachment is accepted.
- Title: `BL SIGN TEST ONLY 20261003-1816 — NOT A CONTRACT`.
- Sender: `BL SIGN TEST ONLY synthetic sender`; signer: `TEST ONLY synthetic signer 1`.
- Every subject begins `[BL SIGN TEST ONLY 20261003-1816]`.
- Approved templates 1, 2, 5 and 7: invitation, recipient verification, completion and sender recovery. Six-digit codes and the bound private recipient URL are the only dynamic variables. Keep editor expiration **Never** and the prepared document/parties unchanged.

Preparation writes the exact HTML/text/subject templates with inert `123456` and `TEST_ONLY_RECIPIENT_LINK` placeholders. It never creates a real code, sender session or provider request. Importing either module also performs no provider request. The REST mapping uses `from` as a string, `to` as a one-address array and `reply_to` as a string; successful `result.message_id` maps to the Worker binding's `messageId`. These fields are documented in the [Cloudflare send API](https://developers.cloudflare.com/api/resources/email_sending/methods/send/). A `queued` or provider-reported `delivered` address is provider evidence; separately observed owner inbox receipt is a different fact.

The release job supplies existing provider credentials internally as `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`; values are never logged or written into the review template, ledger, receipt page or source bundle. Use this explicit preparation/start recipe from the candidate checkout after the approved prior receipt export exists:

```sh
export OWNER_APPROVED_TEST_EMAIL='mtuburnsbarber@gmail.com'
export OWNER_APPROVED_PRIOR_EMAIL_ATTEMPTS=3
export BL_SIGN_PRIVATE_EMAIL_PRIOR_RECONCILIATION='output/private/prior-email-reconciliation.json'
export BL_SIGN_PRIVATE_EMAIL_LEDGER='output/private/email-review-ledger.json'
node scripts/private-email-review.mjs
node scripts/private-email-review.mjs --serve --review-approved
```

The first command prepares templates for inspection. The second requires that exact inspected file, explicit review flag, approved owner address, provider credentials and sanitized prior reconciliation. Startup creates only a synthetic PDF and single-recipient draft; it sends **zero** emails and remains paused. Root can verify the listener and template/status routes while Michael is unavailable. The owner readiness button is an explicit local action; it sends nothing itself. Product Send/code requests remain blocked with 503 until readiness, preserving the draft. No startup timer, scheduler, retry loop or hidden email send runs.

The prior export retains all three reservations: one definitive REST schema rejection and two accepted Message IDs reconciled against owner Gmail INBOX/authentication evidence. These remain three consumed attempts; the eight-attempt cap never resets on process restart. The new single-recipient flow permits one invitation, one verification, one completion and one recovery attempt, for at most seven total with those prior three. The remaining capacity is not an automatic resend allowance. Unknown network outcomes, missing or malformed provider receipts, server errors and persistence failures block subsequent sends. Identical accepted requests return the stored Message ID without a second provider call. Definitive rejections stay consumed and do not trigger automatic retry, alternate sender or a new template attempt.

Keep the review process running through acceptance: the private Worker document/session/object state is process-local, and its links belong to that running instance. The ledger persists separately. A restart requires `BL_SIGN_PRIVATE_EMAIL_RESUME_RECONCILIATION` containing `reviewed: true`, the exact current ledger file SHA-256 and every prior attempt ID/state/provider Message ID or rejection with an evidence reference; unresolved reservations need affirmative provider evidence before they can be classified. The original imported prior count and receipts are revalidated against the root export. A new synthetic state after restart does not restore an old emailed URL. Never remove an active writer's lock; the helper holds it until in-flight provider/persistence work finishes and permanently fences a closed instance.

When the owner is ready, complete this single batch using the prepared review page:

1. Enable readiness locally, open the prepared synthetic editor and send its one invitation.
2. Read the invitation in the owner inbox and open its localhost18889 link. Request one verification code, read it in that inbox and enter it on the signing page within ten minutes.
3. Consent and sign the synthetic TEST ONLY document. Open the completion email and retrieve the final PDF/certificate from this same Worker state.
4. Open `/me` in a fresh browser session. Request the single recovery code, read it in the inbox and enter it to retrieve that same envelope; prior sender sessions should then be invalidated.

The connector deliberately withholds active OTP subjects/plaintext/HTML. The helper never publishes active codes or mail bodies: `/__sandbox/inbox` returns 410, `/__private/status` contains only redacted hashes/counts/receipt metadata, and template previews contain inert placeholders. Owner code entry is the genuine remaining input gate. Do not extract a withheld code through another account, browser or assistant, or reuse an expired prior code.

Focused checks: `npm run test:private-email` uses fake REST functions and synthetic addresses only. It verifies canonical payloads, exact-template/allowlist refusals, provider acceptance versus inbox evidence, retained caps/counts/Message IDs, duplicate suppression, uncertainty and lost-persistence handling, writer fencing during close/restart, credential-echo redaction, HTTP same-origin/paused behavior and actual bound recipient URL. These checks establish private tooling behavior, never real-provider or actual inbox completion.
