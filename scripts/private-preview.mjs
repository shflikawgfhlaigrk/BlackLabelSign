import { serveHarness } from '../tests/helpers/worker-harness.mjs';
const transport = process.env.BL_SIGN_PREVIEW_TRANSPORT || 'http';
const harness = await serveHarness({ port: Number(process.env.BL_SIGN_PREVIEW_PORT || 8788), transport });
console.log(`BL SIGN PRIVATE SANDBOX: ${harness.origin}`);
console.log('Synthetic PDFs only. Email is collected locally; this is not live provider or inbox proof.');
if (transport === 'http') console.log('Loopback HTTP preview adapter emulates edge TLS termination. Security acceptance tests use direct HTTPS.');
console.log(`Local sandbox receipts: ${harness.origin}/__sandbox/inbox`);
console.log(`Exact Worker SHA-256: ${harness.sourceHash}`);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await harness.close(); process.exit(0); });
