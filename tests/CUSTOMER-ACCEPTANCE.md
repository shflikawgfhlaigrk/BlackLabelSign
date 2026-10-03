# Private customer acceptance

Overall release verification: **NOT DONE**. Missing requirement: actual supported test-inbox receipt through the configured provider in a private runtime. Evidence below proves local sandbox behavior only. The BL Sign release verification job (`/root`) owns the next corrective action: verify provider acceptance and actual controlled-inbox receipt separately and record both before G3 closure/founder acceptance. Any required credential/account action must come from the actual access preflight; no such action is inferred from sandbox results.

The harness executes the actual Worker source and shipped browser assets. It uses isolated SQLite with the project schema and all migrations, in-memory R2, clearly labeled synthetic PDFs, and a local sandbox inbox. It binds only `127.0.0.1`. It never reads customer records, sends external email, changes production configuration, installs dependencies, modifies macOS permissions or trust, or uses a persistent browser profile.

Run the focused checks with the installed Node runtime (verified with Node 26):

```sh
node --test --test-timeout=15000 tests/customer-lifecycle.mjs tests/landing.mjs
node tests/customer-browser.mjs
```

The browser driver uses an existing Playwright package and installed headless Chromium. Optional environment overrides are `BL_SIGN_PLAYWRIGHT_MODULE` (the installed package's `index.mjs`) and `BL_SIGN_CHROMIUM_EXECUTABLE`. No package or browser download runs. The dedicated browser context blocks all external network requests and fails on browser script errors.

The API checks use actual HTTPS requests to the Worker. Static `localhost-TEST-ONLY` certificate/key fixtures are deliberately untrusted synthetic test data. The API client trusts that certificate only for its specific loopback request; the dedicated browser context ignores certificate errors only in that disposable context. There is no global TLS bypass or change to system trust.

API coverage includes fresh sender upload, two sequential recipients, actual email-code verification, consent, required fields, final download and PDF text/certificate/hash integrity, tenant isolation, daily quota concurrency, duplicate send/complete, invalid/expired/replayed codes, new-device recipient verification, sender recovery and session rotation, same-email ownership and upload-idempotency merging, cross-origin mutation rejection, administrator throttling, definitive and uncertain provider outcomes, lost provider-receipt persistence, transient R2 interruption and finalization retry. Landing checks exercise pending-submit suppression and stable upload retry keys. Browser coverage uses actual form controls, canvas PDF rendering, mouse and keyboard field placement, signature adoption, consent reload, sequential waiting, browser download and matching final hash, mobile recovery, exact requested-editor recovery, and provider/network error screens.

Email evidence has two separate sandbox states: `accepted` is the local provider's returned receipt; `received` is collection by the local sink. A provider accepted-without-receipt scenario explicitly demonstrates that acceptance does not establish inbox receipt. These are sandbox records, not Cloudflare provider or external inbox evidence. The sink refuses every recipient whose address is outside `.test` or `.invalid`.

Screenshots, a synthetic completed PDF, and a candidate source/hash manifest are written to `output/playwright/`. Regenerate them after any Worker, UI, migration or configuration change. The manifest hashes the complete shipped source/assets/schema/migrations plus package/configuration files and records the current Git commit.

For founder review on this machine:

```sh
BL_SIGN_PREVIEW_PORT=18789 node scripts/private-preview.mjs
```

Open `http://localhost:18789/`, use a synthetic address such as `founder@example.test`, and a document visibly labeled **TEST ONLY — NOT A CONTRACT**. Open `http://localhost:18789/__sandbox/inbox` to read sandbox invitation links and codes. The running, verified listener is PID `83423`, execution session `50100`; use it while it remains active. Port 8788 is occupied by the existing Black Label MCP HTTP canary, so the launch recipe explicitly overrides the script's default. The default HTTP preview emulates edge TLS termination by adapting only the local scheme, same-loopback Origin and local response links. It does not prove production TLS behavior; the automated acceptance runs use direct HTTPS. To review the HTTPS harness instead, set `BL_SIGN_PREVIEW_TRANSPORT=https`. Stop the background preview process when review finishes.

The preview is in-memory and resets when restarted. It is a private review route, not a public release. Founder acceptance, authorized public deployment and actual supported external-inbox receipt remain separate gates owned by the release task.
