// Generates a one-page test agreement PDF for e2e verification.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { writeFileSync } from 'node:fs';

const doc = await PDFDocument.create();
const page = doc.addPage([612, 792]);
const helv = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);

page.drawText('SERVICES AGREEMENT (TEST)', { x: 60, y: 720, size: 18, font: bold });
const body = [
  'This test agreement exists to verify the BL Sign end-to-end flow.',
  'The undersigned agrees that this envelope was created, routed, signed,',
  'and finalized entirely on Black Label infrastructure.',
  '',
  'Effective date: as dated below.',
];
body.forEach((l, i) => page.drawText(l, { x: 60, y: 670 - i * 20, size: 12, font: helv }));
page.drawText('Signature:', { x: 60, y: 240, size: 12, font: bold });
page.drawLine({ start: { x: 140, y: 236 }, end: { x: 380, y: 236 }, thickness: 1, color: rgb(0.6, 0.6, 0.6) });
page.drawText('Date:', { x: 60, y: 190, size: 12, font: bold });
page.drawLine({ start: { x: 140, y: 186 }, end: { x: 300, y: 186 }, thickness: 1, color: rgb(0.6, 0.6, 0.6) });

writeFileSync(new URL('../test-agreement.pdf', import.meta.url), await doc.save());
console.log('wrote test-agreement.pdf');
