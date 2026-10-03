# Private review configuration

`wrangler.private.example.json` declares loopback development with local D1, R2,
and simulated email. It has no production account, routes, database identifier,
bucket, public preview, remote binding, or automatic delivery schedule. The zero
database UUID is a local placeholder, not a provisioned resource.

Run `node scripts/preflight.mjs` from the repository to inspect this template,
source fingerprints, and the installed `blp` metadata cache. The preflight reads
only configuration/source and service metadata. It never sends mail, reads
customer tables or mail, provisions resources, changes secrets, or deploys.

The application requires `DB`, `DOCS`, `ASSETS`, `EMAIL`, the complete schema and
migrations, and `SESSION_SECRET`. `ADMIN_TOKEN` is optional for private admin
access. `ESTATE_BRIDGE_TOKEN` is optional for the existing SalesSwipe bridge.
Local fixture secrets belong to the private harness. Production secret presence
cannot be inferred from an absent local `.dev.vars` file.

The browser harness adapts loopback HTTP to the Worker's HTTPS cookie/origin
semantics. A direct Wrangler browser session needs an independently verified
HTTPS origin/cookie setup; this template alone does not establish that flow.
`PUBLIC_ORIGIN` must match that review origin so invites and recovery links return
to the private candidate.

For an explicitly authorized metadata check, `node scripts/preflight.mjs --live`
uses only `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` already provided to its
environment. It makes bounded GET requests for Worker settings, deployments,
secret names, and code fingerprints. Secret values and code are never output or
saved. An unavailable request reports UNKNOWN, not a missing production secret.
The target defaults to `bl-sign`; `CLOUDFLARE_WORKER_NAME` can select a private
review Worker. No deployment command is included.

Live email testing requires an already approved controlled recipient, accessible
test inbox, an onboarded sender domain, and compatible binding restrictions.
Provider acceptance and a Message-ID are separate from inbox receipt. Simulated
email remains simulated even when the complete private browser journey passes.

The current public application has social and localization wrappers. Before any
later authorized release, capture current modules and assets, preserve those
wrappers, and use the registered guarded release path. The canonical
`deploy.sh` does not reconcile that newer deployed state.

References: [Cloudflare local email simulation](https://developers.cloudflare.com/email-service/local-development/sending/),
[send bindings](https://developers.cloudflare.com/email-service/configuration/send-bindings/),
[Worker configuration](https://developers.cloudflare.com/workers/wrangler/configuration/).
