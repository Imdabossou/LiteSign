const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

// pdf-lib's standard fonts only cover WinAnsi (roughly Latin-1). Anything
// else (Polish names, CJK, emoji...) makes drawText throw, which would stop
// the document from ever completing. Strip accents where that helps and
// replace what's left with "?".
function makeSanitizer(font) {
  const cache = new Map();
  const encodable = ch => {
    if (!cache.has(ch)) {
      try { font.encodeText(ch); cache.set(ch, true); } catch { cache.set(ch, false); }
    }
    return cache.get(ch);
  };
  return text => {
    let out = '';
    for (const ch of String(text == null ? '' : text).replace(/[\r\n\t]+/g, ' ')) {
      if (encodable(ch)) { out += ch; continue; }
      const base = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
      out += [...base].every(encodable) && base ? base : '?';
    }
    return out;
  };
}

// Split text into lines that fit maxWidth at the given size.
function wrap(text, font, size, maxWidth) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) { line = candidate; continue; }
    if (line) lines.push(line);
    // A single word wider than the line: hard-break it.
    line = word;
    while (font.widthOfTextAtSize(line, size) > maxWidth && line.length > 1) {
      let cut = line.length - 1;
      while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > maxWidth) cut--;
      lines.push(line.slice(0, cut));
      line = line.slice(cut);
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function fmtTime(iso) {
  if (!iso) return '-';
  return iso.replace('T', ' ').replace(/\.\d+Z$/, ' UTC').replace(/Z$/, ' UTC');
}

// Stamp every field value into the original PDF and append a signature
// certificate. Returns the finished PDF bytes.
async function buildSignedPdf({ srcBytes, doc, signers, fields, completedAt }) {
  const pdfDoc = await PDFDocument.load(srcBytes);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const clean = makeSanitizer(font);
  const pages = pdfDoc.getPages();

  for (const f of fields) {
    const page = pages[f.page];
    if (!page || f.value == null) continue;
    const { width: pw, height: ph } = page.getSize();
    const boxX = f.x * pw;
    const boxWidth = f.width * pw;
    const boxHeight = f.height * ph;
    const boxY = ph - f.y * ph - boxHeight; // stored top-down, pdf-lib origin is bottom-left

    if (f.type === 'signature' || f.type === 'initials') {
      const png = await pdfDoc.embedPng(Buffer.from(String(f.value).split(',')[1] || '', 'base64'));
      const scale = Math.min(boxWidth / png.width, boxHeight / png.height);
      const drawW = png.width * scale;
      const drawH = png.height * scale;
      page.drawImage(png, {
        x: boxX + (boxWidth - drawW) / 2,
        y: boxY + (boxHeight - drawH) / 2,
        width: drawW,
        height: drawH
      });
    } else {
      // Shrink the text to fit the box width, within reason.
      const text = clean(f.value).slice(0, 500);
      let size = Math.min(12, boxHeight * 0.7);
      while (size > 5 && font.widthOfTextAtSize(text, size) > boxWidth - 4) size -= 0.5;
      page.drawText(text, {
        x: boxX + 2,
        y: boxY + (boxHeight - size) / 2 + size * 0.2,
        size,
        font,
        color: rgb(0.05, 0.05, 0.05),
        maxWidth: boxWidth - 4
      });
    }
  }

  // Signature certificate, flowing onto extra pages if there are many signers.
  const margin = 50;
  let page, y, width;
  const newPage = () => {
    page = pdfDoc.addPage();
    width = page.getWidth() - margin * 2;
    y = page.getHeight() - margin;
  };
  const line = (text, { size = 11, f = font, color = rgb(0, 0, 0), indent = 0, gap = 4 } = {}) => {
    for (const l of wrap(clean(text), f, size, width - indent)) {
      if (y - size < margin) newPage();
      y -= size;
      page.drawText(l, { x: margin + indent, y, size, font: f, color });
      y -= gap;
    }
  };
  const grey = rgb(0.38, 0.38, 0.38);

  newPage();
  line('Signature Certificate', { size: 18, f: bold, gap: 14 });
  line(`Document: ${doc.title}`);
  line(`Document ID: ${doc.id}`, { size: 9, color: grey });
  if (doc.original_sha256) line(`Original file SHA-256: ${doc.original_sha256}`, { size: 9, color: grey });
  if (doc.sent_at) line(`Sent for signing: ${fmtTime(doc.sent_at)}`, { size: 9, color: grey });
  line(`Completed: ${fmtTime(completedAt)}`, { gap: 18 });

  for (const s of signers) {
    line(`${s.name}${s.email ? ` <${s.email}>` : ''}`, { f: bold });
    if (s.viewed_at) line(`First viewed: ${fmtTime(s.viewed_at)}`, { size: 9, color: grey, indent: 10 });
    line(`Signed: ${fmtTime(s.signed_at)}`, { size: 9, color: grey, indent: 10 });
    line(`IP address: ${s.signed_ip || '-'}`, { size: 9, color: grey, indent: 10, gap: 14 });
  }

  y -= 6;
  line('Each signer was sent a unique signing link and agreed to sign electronically before signing. ' +
    'The SHA-256 hash of this finished file is recorded in the sender\'s audit log.', { size: 8, color: grey });

  return pdfDoc.save();
}

module.exports = { buildSignedPdf };
