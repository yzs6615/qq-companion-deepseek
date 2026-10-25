#!/usr/bin/env node
/** Generate a QR PNG from text: node scripts/qr.mjs <text> <out.png> */
import QRCode from 'qrcode';

const [data, out] = process.argv.slice(2);
if (!data || !out) {
  console.error('usage: node scripts/qr.mjs <text> <out.png>');
  process.exit(1);
}
await QRCode.toFile(out, data, { width: 380, margin: 2, errorCorrectionLevel: 'M' });
console.log(out);
