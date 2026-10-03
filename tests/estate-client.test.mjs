import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWholesaleTerms, buildWholesaleDrafts } from '../src/estate-wholesale.mjs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
const terms = { deal_id: 'UT:test-1', property_address: '10 Test Street, Provo, UT', parcel_id: 'test-1', state: 'UT', legal_description: 'Lot 1, Test Subdivision', seller_name: 'Jane Example', seller_email: 'seller@example.com', seller_address: 'PO Box 9, Provo, UT 84601', seller_phone: '8015550100', seller_signer_name: 'Jane Example', seller_signer_capacity: 'Self', contract_buyer_name: 'Client Alpha LLC', buyer_email: 'alpha@example.com', buyer_signer_name: 'Alice Example', buyer_signer_capacity: 'Manager', title_company: 'Example Title', escrow_holder: 'Example Escrow', contract_date: '2026-09-24', closing_date: '2026-10-24', possession_date: '2026-10-24', purchase_price: '250000', earnest_money: '2500', inspection_days: '10', title_objection_days: '5', property_type: 'residential', financing_type: 'cash', closing_costs: 'each_own', assignment_rights: 'prohibited' };
async function content(bytes) { const task = getDocument({ data: Uint8Array.from(bytes), useSystemFonts: true }); const pdf = await task.promise; const pages = []; for(let i=1;i<=pdf.numPages;i++) pages.push((await (await pdf.getPage(i)).getTextContent()).items.map(item=>item.str).join(' ')); await task.destroy();return pages.join('\n'); }
test('real legal PDFs print owner address and phone and remain specific to each client', async () => {
  for (const [name,email] of [['Client Alpha LLC','alpha@example.com'],['Client Beta LLC','beta@example.com']]) {
    const checked = validateWholesaleTerms({ ...terms, contract_buyer_name: name, buyer_email: email });
    assert.equal(checked.ok,true);assert.equal(checked.terms.seller_address,terms.seller_address);
    const docs = await buildWholesaleDrafts(checked.terms);
    const text = await content(docs.purchase);
    assert.match(text,/Purchase and sale agreement/);assert.match(text,/PO Box 9, Provo, UT 84601/);assert.match(text,/8015550100/);
    assert.ok(text.includes(name));assert.ok(text.includes(email));assert.ok(!text.includes(name === 'Client Alpha LLC' ? 'Client Beta LLC' : 'Client Alpha LLC'));
    assert.match(text,/\$250,000.00/);assert.match(text,/10 Test Street/);
  }
});
