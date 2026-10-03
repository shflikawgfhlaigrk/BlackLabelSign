import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const printable = value => String(value ?? '').replace(/[\u2018\u2019]/g, "'").replace(/[\u2013\u2014]/g, '-')
  .replace(/[^\x20-\x7e\n]/g, '?').trim();
const text = (value, max = 240) => printable(value).slice(0, max);
const date = value => {
  const s = text(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`)) ||
      new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) !== s) return null;
  return s;
};
const dollars = (value, allowZero = false) => {
  const s = String(value ?? '').trim().replace(/^\$/, '').replaceAll(',', '');
  if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(s)) return null;
  const amount = Number(s);
  return Number.isFinite(amount) && (amount > 0 || (allowZero && amount === 0)) ? amount : null;
};
const money = amount => `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const WHOLESALE_DOCUMENT_KINDS = Object.freeze([
  'purchase', 'assignment', 'inspection', 'financing', 'disclosure', 'closing', 'rider', 'packet',
]);

export function validateWholesaleTerms(input) {
  const source = input && typeof input === 'object' ? input : {};
  const fields = ['deal_id', 'property_address', 'parcel_id', 'state', 'legal_description',
    'seller_name', 'seller_email', 'seller_signer_name', 'seller_signer_capacity',
    'contract_buyer_name', 'buyer_email', 'buyer_signer_name', 'buyer_signer_capacity',
    'title_company', 'escrow_holder'];
  const terms = Object.fromEntries(fields.map(key => [key, text(source[key], key === 'legal_description' ? 1200 : 200)]));
  for (const key of fields) if (!terms[key]) return { ok: false, error: `${key} is required` };
  terms.seller_address = text(source.seller_address, 300);
  terms.seller_phone = text(source.seller_phone, 40);
  if (!/^[A-Z]{2}$/.test(terms.state)) return { ok: false, error: 'state must be a two-letter code' };
  for (const key of ['seller_email', 'buyer_email'])
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(terms[key])) return { ok: false, error: `${key} must be a valid email` };
  for (const [key, values] of Object.entries({
    property_type: ['residential', 'land', 'commercial', 'new_construction', 'other'],
    financing_type: ['cash', 'conventional', 'other'],
    closing_costs: ['each_own', 'seller', 'buyer'],
    assignment_rights: ['allowed', 'consent', 'prohibited'],
  })) {
    terms[key] = text(source[key], 32);
    if (!values.includes(terms[key])) return { ok: false, error: `${key} is not supported` };
  }
  for (const key of ['contract_date', 'closing_date', 'possession_date']) {
    terms[key] = date(source[key]);
    if (!terms[key]) return { ok: false, error: `${key} must be a valid YYYY-MM-DD date` };
  }
  if (terms.closing_date < terms.contract_date) return { ok: false, error: 'closing_date must be on or after contract_date' };
  if (terms.possession_date < terms.contract_date) return { ok: false, error: 'possession_date must be on or after contract_date' };
  for (const key of ['purchase_price', 'earnest_money']) {
    terms[key] = dollars(source[key], key === 'earnest_money');
    if (terms[key] === null) return { ok: false, error: `${key} must be a positive dollar amount` };
  }
  if (terms.earnest_money > terms.purchase_price) return { ok: false, error: 'earnest_money exceeds purchase_price' };
  for (const key of ['inspection_days', 'title_objection_days']) {
    const days = Number(source[key]);
    if (!Number.isInteger(days) || days < 0 || days > 180) return { ok: false, error: `${key} must be 0 to 180` };
    terms[key] = days;
  }
  terms.assignee_name = text(source.assignee_name, 180);
  terms.assignee_email = text(source.assignee_email, 200);
  terms.assignee_signer_name = text(source.assignee_signer_name, 180);
  terms.assignee_signer_capacity = text(source.assignee_signer_capacity, 120);
  terms.assignment_fee = source.assignment_fee !== '' && source.assignment_fee != null
    ? dollars(source.assignment_fee, true) : null;
  if (terms.assignment_rights !== 'prohibited' && (!terms.assignee_name || !terms.assignee_email ||
      !terms.assignee_signer_name || !terms.assignee_signer_capacity || terms.assignment_fee === null))
    return { ok: false, error: 'assignee legal name, signer name, capacity, email and fee are required when assignment is planned' };
  if (terms.assignee_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(terms.assignee_email))
    return { ok: false, error: 'assignee_email must be a valid email' };
  terms.loan_amount = terms.financing_type === 'cash' ? null : dollars(source.loan_amount);
  terms.financing_deadline = terms.financing_type === 'cash' ? null : date(source.financing_deadline);
  if (terms.financing_type !== 'cash' && (!terms.loan_amount || !terms.financing_deadline || terms.loan_amount > terms.purchase_price))
    return { ok: false, error: 'loan amount and financing commitment date are required for financed deals' };
  if (terms.financing_deadline && (terms.financing_deadline < terms.contract_date || terms.financing_deadline > terms.closing_date))
    return { ok: false, error: 'financing commitment date must fall between contract and closing' };
  terms.additional_terms = text(source.additional_terms, 1500);
  return { ok: true, terms };
}

async function makeDocument(title, terms, sections) {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.12, 0.12, 0.14);
  const muted = rgb(0.38, 0.39, 0.41);
  const gold = rgb(0.57, 0.40, 0.16);
  const width = 612;
  let page;
  let y;
  let pageNumber = 0;
  const newPage = () => {
    page = pdf.addPage([612, 792]);
    pageNumber++;
    page.drawText(title, { x: 48, y: 744, size: 17, font: bold, color: ink });
    page.drawText(`Deal ID: ${text(terms.deal_id, 80)}`, { x: 48, y: 721, size: 9, font: regular, color: muted });
    page.drawText('TRANSACTION AGREEMENT', { x: 48, y: 706, size: 9, font: bold, color: muted });
    page.drawLine({ start: { x: 48, y: 691 }, end: { x: 564, y: 691 }, thickness: 1, color: gold });
    page.drawText(`Prepared ${new Date().toISOString().slice(0, 10)}  /  Page ${pageNumber}`, { x: 48, y: 34, size: 8, font: regular, color: muted });
    page.drawText('Made by Black Label', { x: 460, y: 34, size: 8, font: bold, color: gold });
    y = 667;
  };
  const lines = (value, font, size, maxWidth) => {
    const out = [];
    for (const paragraph of text(value, 2000).split('\n')) {
      let line = '';
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        const candidate = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(candidate, size) <= maxWidth) { line = candidate; continue; }
        if (line) out.push(line);
        line = '';
        for (const char of word) {
          if (font.widthOfTextAtSize(line + char, size) > maxWidth && line) {
            out.push(line);
            line = '';
          }
          line += char;
        }
      }
      out.push(line || ' ');
    }
    return out;
  };
  const paragraph = (value, size = 10, emphasis = false) => {
    const font = emphasis ? bold : regular;
    const wrapped = lines(value, font, size, 516);
    for (const line of wrapped) {
      if (y < 76) newPage();
      page.drawText(line, { x: 48, y, size, font, color: ink });
      y -= 14;
    }
    y -= 7;
  };
  newPage();
  for (const [heading, body] of sections) {
    if (y < 110) newPage();
    paragraph(heading.toUpperCase(), 10, true);
    paragraph(body);
  }
  return pdf.save();
}

// The visible signature areas are part of the PDF that BL Sign seals. Coordinates
// are returned in its normalized, top-origin field format.
export async function appendWholesaleExecutionPage(packet, terms) {
  let pageIndex = packet.getPageCount();
  let page = packet.addPage([612, 792]);
  const regular = await packet.embedFont(StandardFonts.Helvetica);
  const bold = await packet.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.12, 0.12, 0.14);
  const gold = rgb(0.57, 0.40, 0.16);
  const muted = rgb(0.38, 0.39, 0.41);
  const line = (value, y, font = regular, size = 10) =>
    page.drawText(printable(value), { x: 48, y, font, size, color: ink });
  const wrap = (value, top, maxWidth = 516) => {
    let current = '', y = top;
    const words = [];
    for (const word of printable(value).split(/\s+/)) {
      if (regular.widthOfTextAtSize(word, 9) <= maxWidth) { words.push(word); continue; }
      let chunk = '';
      for (const char of word) {
        if (regular.widthOfTextAtSize(chunk + char, 9) > maxWidth && chunk) {
          words.push(chunk); chunk = '';
        }
        chunk += char;
      }
      if (chunk) words.push(chunk);
    }
    for (const word of words) {
      const next = current ? `${current} ${word}` : word;
      if (regular.widthOfTextAtSize(next, 9) > maxWidth && current) {
        line(current, y, regular, 9); y -= 13; current = word;
      } else current = next;
    }
    if (current) line(current, y, regular, 9);
    return y - 17;
  };
  line('TRANSACTION EXECUTION PAGE', 744, bold, 17);
  page.drawLine({ start: { x: 48, y: 730 }, end: { x: 564, y: 730 }, thickness: 1, color: gold });
  let y = wrap(`Deal ${terms.deal_id}. Property: ${terms.property_address}. Parcel ${terms.parcel_id}. Purchase agreement dated ${terms.contract_date}.`, 708);
  y = wrap('By signing this page, Seller and Contract Buyer execute the Purchase and Sale Agreement, Inspection and Due Diligence Addendum, Financing and Appraisal Addendum, and Property Type Rider contained in this packet. Their signatures apply to those documents as one transaction agreement.', y);
  if (terms.assignment_rights !== 'prohibited') {
    y = wrap(`Contract Buyer as Assignor and ${terms.assignee_name} as Assignee execute the Assignment Agreement in this packet. The assignment takes effect only after the purchase agreement is fully executed and the assignment conditions in that agreement are met.`, y);
    if (terms.assignment_rights === 'consent')
      y = wrap(`Seller expressly consents to assignment to ${terms.assignee_name} by signing below. Seller does not release Contract Buyer from its obligations unless a separate writing signed by Seller states that release.`, y);
  }
  y = wrap('The Seller Disclosure Questionnaire must be completed and signed on its own terms. The Closing Instructions Sheet is a coordination record; neither is adopted as an amendment by this execution page. An alteration to the signed agreement requires a later writing signed by the affected parties.', y);
  const rows = [
    ['seller', 'SELLER', terms.seller_name, terms.seller_signer_name, terms.seller_signer_capacity, 405],
    ['buyer', 'CONTRACT BUYER / ASSIGNOR', terms.contract_buyer_name, terms.buyer_signer_name, terms.buyer_signer_capacity, 270],
  ];
  if (terms.assignment_rights !== 'prohibited')
    rows.push(['assignee', 'ASSIGNEE', terms.assignee_name, terms.assignee_signer_name, terms.assignee_signer_capacity, 135]);
  const fields = [];
  const separateSignatures = rows.some(([, label, party, signer, capacity]) =>
    bold.widthOfTextAtSize(`${label}: ${party}`, 9) > 516 ||
    regular.widthOfTextAtSize(`Authorized signer: ${signer}  |  Capacity: ${capacity}`, 8.5) > 516);
  if (separateSignatures) {
    page.drawText('Made by Black Label', { x: 460, y: 34, size: 8, font: bold, color: gold });
    for (const [role, label, party, signer, capacity] of rows) {
      pageIndex = packet.getPageCount();
      page = packet.addPage([612, 792]);
      line(`${label} SIGNATURE`, 744, bold, 17);
      page.drawLine({ start: { x: 48, y: 730 }, end: { x: 564, y: 730 }, thickness: 1, color: gold });
      let next = wrap(`Party: ${party}`, 708);
      next = wrap(`Authorized signer: ${signer}. Capacity: ${capacity}.`, next);
      wrap(`Signing the transaction documents identified on the preceding execution page for ${terms.property_address}.`, next);
      page.drawRectangle({ x: 56, y: 429, width: 294, height: 43, borderColor: muted, borderWidth: 0.7 });
      page.drawRectangle({ x: 378, y: 429, width: 176, height: 43, borderColor: muted, borderWidth: 0.7 });
      line('Signature', 415, regular, 8);
      page.drawText('Date signed', { x: 378, y: 415, size: 8, font: regular, color: ink });
      fields.push({ role, type: 'signature', page: pageIndex, x: 59 / 612, y: (792 - 469) / 792, w: 288 / 612, h: 37 / 792 });
      fields.push({ role, type: 'date', page: pageIndex, x: 382 / 612, y: (792 - 469) / 792, w: 168 / 612, h: 37 / 792 });
      page.drawText('Made by Black Label', { x: 460, y: 34, size: 8, font: bold, color: gold });
    }
    return fields;
  }
  if (y < 485) {
    page.drawText('Made by Black Label', { x: 460, y: 34, size: 8, font: bold, color: gold });
    pageIndex = packet.getPageCount();
    page = packet.addPage([612, 792]);
    line('TRANSACTION SIGNATURES', 744, bold, 17);
    page.drawLine({ start: { x: 48, y: 730 }, end: { x: 564, y: 730 }, thickness: 1, color: gold });
    wrap(`These signatures execute the transaction documents identified on the preceding execution page for ${terms.property_address}.`, 708);
  }
  for (const [role, label, party, signer, capacity, bottom] of rows) {
    line(`${label}: ${party}`, bottom + 89, bold, 9);
    line(`Authorized signer: ${signer}  |  Capacity: ${capacity}`, bottom + 74, regular, 8.5);
    page.drawRectangle({ x: 56, y: bottom + 24, width: 294, height: 43, borderColor: muted, borderWidth: 0.7 });
    page.drawRectangle({ x: 378, y: bottom + 24, width: 176, height: 43, borderColor: muted, borderWidth: 0.7 });
    line('Signature', bottom + 10, regular, 8);
    page.drawText('Date signed', { x: 378, y: bottom + 10, size: 8, font: regular, color: ink });
    fields.push({ role, type: 'signature', page: pageIndex,
      x: 59 / 612, y: (792 - (bottom + 64)) / 792, w: 288 / 612, h: 37 / 792 });
    fields.push({ role, type: 'date', page: pageIndex,
      x: 382 / 612, y: (792 - (bottom + 64)) / 792, w: 168 / 612, h: 37 / 792 });
  }
  page.drawText('Made by Black Label', { x: 460, y: 34, size: 8, font: bold, color: gold });
  return fields;
}

export async function buildWholesaleDrafts(terms) {
  const property = `${terms.property_address}; parcel ${terms.parcel_id}; ${terms.state}. Legal description: ${terms.legal_description}`;
  const financing = terms.financing_type === 'cash'
    ? `This is a cash purchase. Buyer shall provide reasonably satisfactory proof of available funds within five business days after the effective date. No loan or appraisal contingency applies unless a later signed addendum says otherwise.`
    : `Buyer shall seek ${terms.financing_type === 'conventional' ? 'a conventional mortgage' : 'the financing described in the signed financing addendum'} in the amount of ${money(terms.loan_amount)} and deliver a written lender commitment by ${terms.financing_deadline}. Buyer may terminate by written notice before that deadline if financing is declined despite timely, good-faith application and cooperation, with earnest money returned subject to any other uncured default.`;
  const costs = terms.closing_costs === 'each_own'
    ? 'Each party pays its own legal, lender and advisory costs; ordinary escrow and recording charges are shared equally unless the closing statement and local custom require a different allocation.'
    : terms.closing_costs === 'seller'
      ? 'Seller pays ordinary escrow and recording charges, excluding Buyer lender charges and Buyer legal or advisory costs.'
      : 'Buyer pays ordinary escrow and recording charges, excluding Seller legal or advisory costs and charges required of Seller by law.';
  const assign = terms.assignment_rights === 'allowed'
    ? 'Buyer may assign its interest by written notice to Seller before closing. Buyer remains liable for performance unless Seller separately releases Buyer in writing.'
    : terms.assignment_rights === 'consent'
      ? 'Buyer may assign only with Seller prior written consent. Buyer remains liable unless Seller separately releases Buyer in writing.'
      : 'Buyer may not assign this agreement without a later written amendment signed by Seller and Buyer.';
  const purchase = await makeDocument('Purchase and sale agreement', terms, [
    ['1. Parties and property', `Document date: ${terms.contract_date}. This agreement becomes effective when Seller and Contract Buyer have both signed the transaction execution page; that last signature date is the effective date for periods measured from the effective date. Seller: ${terms.seller_name} (${terms.seller_email}).${terms.seller_address ? ` Seller mailing address: ${terms.seller_address}.` : ''}${terms.seller_phone ? ` Seller phone: ${terms.seller_phone}.` : ''} Buyer: ${terms.contract_buyer_name} (${terms.buyer_email}). Seller agrees to sell, and Buyer agrees to buy, the real property identified as ${property}, together with improvements, fixtures, built-in equipment, transferable warranties and appurtenant rights owned by Seller, except items specifically excluded in a signed rider. Property type: ${terms.property_type.replaceAll('_', ' ')}.`],
    ['2. Price and earnest money', `Purchase price: ${money(terms.purchase_price)}, payable in immediately available funds at closing, subject to credits and prorations. Buyer shall deposit ${money(terms.earnest_money)} with ${terms.escrow_holder} within three business days after the effective date. The holder shall credit the deposit toward the price at closing and shall release it earlier only on joint written instructions, a final order, or the express termination terms of this agreement.`],
    ['3. Inspection and due diligence', terms.inspection_days
      ? `Buyer may inspect the property and relevant records, at Buyer's expense, during the ${terms.inspection_days}-calendar-day period after the effective date. Buyer shall restore damage caused by inspections and maintain reasonable liability coverage. Buyer may terminate for an unsatisfactory inspection by written notice before that period expires; the earnest money shall be returned if Buyer is not otherwise in default. Any repair request or price change must be in a written amendment signed by both parties.`
      : 'Buyer has no general inspection termination period under these entered terms. Seller must still provide disclosures and access required by applicable law or a signed rider.'],
    ['4. Title, survey and objections', `Seller shall convey marketable title free of monetary liens other than items paid at closing, subject to permitted easements, restrictions and other exceptions disclosed in the title commitment. Buyer may object in writing to title or survey defects within ${terms.title_objection_days} calendar days after receiving the last of the title commitment and available survey. Seller has ten business days after notice to cure. If Seller cannot cure by closing, Buyer may waive the defect or terminate and recover earnest money, provided Buyer is not otherwise in default. Closing shall be handled by ${terms.title_company}.`],
    ['5. Financing and appraisal', financing],
    ['6. Closing, costs and possession', `Closing shall occur on ${terms.closing_date} through ${terms.title_company}, or another place the parties agree in writing. Seller shall deliver a deed sufficient under ${terms.state} law to convey the agreed title, and Buyer shall deliver the balance of the price. ${costs} Taxes, rents, utilities and association charges are prorated as of closing. Possession shall transfer on ${terms.possession_date}, subject to any signed occupancy agreement.`],
    ['7. Condition, disclosures and risk', `Seller shall deliver disclosures required by ${terms.state} law and any signed disclosure questionnaire. Buyer acknowledges that public-record estimates are not a warranty of value, condition or permitted use. Except for Seller express representations, required disclosures and signed repair obligations, the property is conveyed in its condition at closing, ordinary wear excepted. Seller bears risk of material casualty or condemnation before closing; Buyer may terminate and recover earnest money or accept available insurance proceeds and credits.`],
    ['8. Assignment', assign],
    ['9. Default and remedies', 'A party alleging default shall give written notice describing it and five business days to cure, unless closing or another express deadline makes cure impracticable. After an uncured default, the nondefaulting party may seek remedies available under applicable law, including damages or specific performance where available. The escrow holder may retain disputed funds until joint instructions or a final order.'],
    ['10. Notices, entire agreement and signatures', `Notices must be in writing and delivered to Seller at ${terms.seller_email} and Buyer at ${terms.buyer_email}; an email notice is effective when received without an automated failure notice. This document and signed riders are the entire agreement. Changes require a writing signed by both parties. Counterparts and electronic signatures may be used to the extent permitted by law. ${terms.state} law governs.`],
    ...(terms.additional_terms ? [['11. Additional negotiated terms', terms.additional_terms]] : []),
    ['Seller signature', `Signature: __________________________  Date: __________  Printed name/capacity: ${terms.seller_name}`],
    ['Buyer signature', `Signature: __________________________  Date: __________  Printed name/capacity: ${terms.contract_buyer_name}`],
  ]);
  const drafts = { purchase };
  if (terms.assignment_rights !== 'prohibited') {
    drafts.assignment = await makeDocument('Assignment agreement', terms, [
      ['1. Underlying purchase contract', `This assignment concerns the purchase and sale agreement dated ${terms.contract_date} between ${terms.seller_name} and ${terms.contract_buyer_name} for ${property}. The assignment becomes effective only after that underlying agreement has been executed and remains in force.`],
      ['2. Assignment and assumption', `${terms.contract_buyer_name} (Assignor) assigns to ${terms.assignee_name} (Assignee) all of Assignor's right, title and interest as buyer under the identified purchase contract, subject to its terms. Assignee accepts the assignment and assumes all buyer obligations arising on and after the effective date. Assignor remains liable to Seller unless Seller expressly releases Assignor in a separate signed writing.`],
      ['3. Consideration and deposit', `Assignee shall pay Assignor an assignment fee of ${money(terms.assignment_fee)} from closing proceeds through ${terms.title_company} at the same closing as the property purchase. The fee is earned only if that purchase closes, unless the parties state a different outcome in a signed amendment. The parties shall instruct escrow in writing concerning reimbursement or transfer of the ${money(terms.earnest_money)} earnest money deposit; no reimbursement is assumed by this draft.`],
      ['4. Consent and closing', terms.assignment_rights === 'consent'
        ? `Seller written consent is a condition to this assignment. No transfer is effective until Seller signs the consent below. The property closing remains scheduled for ${terms.closing_date}.`
        : `Assignor shall give Seller written notice of this assignment before the scheduled ${terms.closing_date} closing. Seller consent is not required under the entered purchase terms, subject to any later amendment.`],
      ['5. Representations and records', 'By signing, Assignor represents that it has provided Assignee a complete copy of the executed purchase contract and disclosed written amendments and notices known to Assignor. Each party shall verify the contract status, title, closing statement and its own authority before performance. Neither party represents that the property has a particular condition or value except as expressly stated in a signed writing.'],
      ['6. Notices and governing law', `Notices to Assignor: ${terms.buyer_email}. Notices to Assignee: ${terms.assignee_email}. Changes require a writing signed by both parties. ${terms.state} law governs. Electronic counterparts are permitted to the extent allowed by law.`],
      ['Assignor signature', `Signature: __________________________  Date: __________  Printed name/capacity: ${terms.contract_buyer_name}`],
      ['Assignee signature', `Signature: __________________________  Date: __________  Printed name/capacity: ${terms.assignee_name}`],
      ...(terms.assignment_rights === 'consent' ? [['Seller consent', `Seller consents to the assignment without releasing Assignor unless expressly stated here. Signature: __________________________  Date: __________  Printed name/capacity: ${terms.seller_name}`]] : []),
    ]);
  }
  drafts.inspection = await makeDocument('Inspection and due diligence addendum', terms, [
    ['Property and parties', `${property}. Seller: ${terms.seller_name}. Buyer: ${terms.contract_buyer_name}. This addendum supplements the purchase agreement dated ${terms.contract_date}.`],
    ['Access and inspections', terms.inspection_days
      ? `Buyer may enter at reasonable times on prior notice during the ${terms.inspection_days}-calendar-day inspection period. Buyer shall use qualified inspectors where required, comply with site rules, avoid destructive testing without Seller prior written consent, and restore inspection damage.`
      : 'No general inspection period was entered. Access for any further inspection requires a signed amendment.'],
    ['Documents and objections', 'Seller shall make available documents in Seller possession concerning title, leases, service contracts, permits, notices of violation and material property conditions, subject to privacy and privilege. Buyer must deliver any objection or termination notice before the inspection period ends. A requested repair, concession or extension is binding only when both parties sign it.'],
    ['Environmental and specialized review', 'Buyer shall independently evaluate environmental, structural, zoning, flood, insurance, utility and use matters relevant to this property. This addendum does not replace required state or local disclosures.'],
    ['Signatures', 'Seller: __________________________  Date: __________    Buyer: __________________________  Date: __________'],
  ]);
  drafts.financing = await makeDocument('Financing and appraisal addendum', terms, [
    ['Property and financing election', `${property}. Purchase price: ${money(terms.purchase_price)}. ${financing}`],
    ['Application and cooperation', terms.financing_type === 'cash'
      ? 'Buyer shall timely provide proof of funds and deliver the required closing funds. No lender or appraisal condition is included in this cash election.'
      : `Buyer shall submit a complete financing application promptly, provide documents reasonably requested by the lender, and notify Seller promptly of denial or material change. The contemplated loan amount is ${money(terms.loan_amount)} and written commitment is due ${terms.financing_deadline}. Seller shall provide reasonable property access for appraisal.`],
    ['Appraisal and funding', terms.financing_type === 'cash'
      ? 'Any appraisal Buyer obtains is for Buyer information only and does not extend closing or create a new termination right.'
      : 'If the lender requires an appraisal below the purchase price, Buyer may propose a price adjustment or additional cash. Neither party is bound to a change without a signed amendment. If no agreement is reached before the financing commitment deadline, Buyer may use the financing termination procedure in the purchase agreement.'],
    ['Signatures', 'Seller: __________________________  Date: __________    Buyer: __________________________  Date: __________'],
  ]);
  drafts.disclosure = await makeDocument('Seller disclosure questionnaire', terms, [
    ['Property and completion instructions', `${property}. Seller: ${terms.seller_name}. Seller must personally complete the following questions from actual knowledge, attach explanations for any Yes or Unknown response, and deliver disclosures required by ${terms.state} law. Blank answers are not representations.`],
    ['Structure and systems', 'For each item mark Yes / No / Unknown and explain any Yes or Unknown: water intrusion or flooding ___; roof leak or replacement ___; foundation movement ___; plumbing defect ___; electrical defect ___; heating or cooling defect ___; fire or casualty loss ___.'],
    ['Use and legal matters', 'For each item mark Yes / No / Unknown and explain: unpermitted work ___; zoning or use notice ___; boundary or encroachment dispute ___; easement dispute ___; environmental condition ___; lead-based paint or asbestos notice ___; pending litigation or governmental notice affecting the property ___.'],
    ['Financial and occupancy matters', 'For each item mark Yes / No / Unknown and explain: unpaid taxes or assessments ___; association dues or special assessments ___; leases, occupants or possession rights ___; service or construction contracts that survive closing ___; liens or unpaid contractors ___.'],
    ['Explanations and attachments', 'Additional explanation / attachment reference: ________________________________________________________________\n________________________________________________________________________________'],
    ['Seller certification', 'Seller certifies only that the completed answers and attachments are true to Seller actual knowledge as of the signature date. Seller shall update a material change learned before closing when required by law or agreement. Seller signature: __________________________  Date: __________'],
    ['Buyer receipt', 'Buyer acknowledges receipt, not acceptance of condition or waiver of rights. Buyer signature: __________________________  Date: __________'],
  ]);
  drafts.closing = await makeDocument('Closing instructions sheet', terms, [
    ['Transaction identifiers', `${property}. Seller: ${terms.seller_name} (${terms.seller_email}).${terms.seller_address ? ` Seller mailing address: ${terms.seller_address}.` : ''}${terms.seller_phone ? ` Seller phone: ${terms.seller_phone}.` : ''} Buyer: ${terms.contract_buyer_name} (${terms.buyer_email}). Escrow and title company: ${terms.title_company}. Earnest money holder: ${terms.escrow_holder}.`],
    ['Funds and statement', `Purchase price ${money(terms.purchase_price)}; earnest money ${money(terms.earnest_money)} credited at closing; balance subject to signed credits and prorations. ${costs} Escrow shall prepare a settlement statement for both parties to review before disbursement. Verify wire instructions by a trusted callback to a known number before sending funds.`],
    ['Title and documents', 'Confirm executed purchase agreement and all addenda, deed and legal description, title commitment and cure of monetary liens, identity and signing authority of each party, required disclosures, lender documents if financed, tax and association prorations, recording instructions and insurance requirements.'],
    ['Schedule and possession', `Target closing: ${terms.closing_date}. Possession: ${terms.possession_date}. Escrow shall obtain written confirmation of any extension, occupancy arrangement or assignment before closing. Do not disburse an assignment fee unless an executed assignment and matching settlement statement authorize it.`],
    ['Instruction status', 'This sheet summarizes entered terms for coordination. It does not amend the executed purchase agreement. If documents conflict, obtain written direction from the parties and their closing professionals before proceeding.'],
  ]);
  const riderContent = terms.property_type === 'land'
    ? ['Buyer shall investigate legal access, boundaries, survey, soils, utilities, water rights, septic or sewer availability, zoning, subdivision and development entitlements during the inspection period. No buildability representation is made solely from parcel data.', 'Seller shall identify any mineral, timber, water or development rights excluded from the sale in a signed exhibit.']
    : terms.property_type === 'commercial'
      ? ['Seller shall provide available leases, rent roll, operating statements, service contracts, zoning notices and environmental reports for Buyer review. Buyer shall independently verify income, expenses, tenant rights and permitted use.', 'A signed exhibit shall identify which leases, deposits, contracts and licenses transfer at closing and allocate pre-closing obligations.']
    : terms.property_type === 'new_construction'
      ? ['A signed plans-and-specifications exhibit shall identify the work to be delivered, completion standard, change-order process, inspection rights and punch-list procedure. Any warranty, permit and certificate of occupancy obligation must be expressly stated in that exhibit.', 'Closing is subject to the completion and occupancy conditions expressly agreed in the signed construction exhibit.']
    : terms.property_type === 'residential'
      ? ['Seller shall deliver the residential disclosures required by applicable law, together with known association documents, occupancy information and warranties in Seller possession.', 'Included appliances, fixtures and exclusions shall be identified in a signed exhibit to prevent disputes at closing.']
      : ['The parties shall attach a signed use-specific exhibit identifying fixtures, personal property, permitted uses, approvals and any specialized inspections or disclosures.', 'Public parcel data alone does not establish permitted use, square footage or condition.'];
  drafts.rider = await makeDocument('Property type rider', terms, [
    ['Property and selected type', `${property}. Selected property type: ${terms.property_type.replaceAll('_', ' ')}. This rider supplements the purchase agreement dated ${terms.contract_date}.`],
    ['Specialized due diligence', riderContent[0]],
    ['Deliverables and exclusions', riderContent[1]],
    ['Priority', 'A completed, signed exhibit controls over inconsistent general language for the matter it specifically addresses. This draft does not supply missing state or local disclosures.'],
    ['Seller signature', `Signature: __________________________  Date: __________  Printed name/capacity: ${terms.seller_name}`],
    ['Buyer signature', `Signature: __________________________  Date: __________  Printed name/capacity: ${terms.contract_buyer_name}`],
  ]);
  return drafts;
}
