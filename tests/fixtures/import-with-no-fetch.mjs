// A fixed child entry point keeps the module path as argv data, never JS source.
// Import checks use test-owned file URLs and refuse every provider fetch.
let providerCalls = 0;
globalThis.fetch = () => { providerCalls++; throw new Error('IMPORT SENT'); };
const moduleUrl = new URL(process.argv[2]);
if (moduleUrl.protocol !== 'file:') throw new Error('A test-owned file URL is required.');
const loaded = await import(moduleUrl.href);
if (providerCalls) throw new Error('Import attempted a provider fetch.');
process.stdout.write(JSON.stringify({ imported: true, providerCalls, marker: loaded.marker ?? null }));
