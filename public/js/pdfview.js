// Renders every page of a PDF into a container. Pages scale to the container
// width (so they fit on a phone) and field overlays are positioned in
// percentages, so they line up at any size without re-rendering.
import * as pdfjsLib from '/vendor/pdfjs/build/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.min.mjs';

const MAX_PAGE_WIDTH = 900;

export async function renderPdf(container, url) {
  container.innerHTML = '<div class="empty">Loading document…</div>';
  const pdf = await pdfjsLib.getDocument({
    url,
    cMapUrl: '/vendor/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
    wasmUrl: '/vendor/pdfjs/wasm/',
    iccUrl: '/vendor/pdfjs/iccs/'
  }).promise;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pages = [];
  const frag = document.createDocumentFragment();

  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const base = page.getViewport({ scale: 1 });
    // Render at up to MAX_PAGE_WIDTH CSS px (times DPR for sharpness); CSS
    // then shrinks the canvas to whatever width the screen allows.
    const viewport = page.getViewport({ scale: (MAX_PAGE_WIDTH / base.width) * dpr });

    const wrap = document.createElement('div');
    wrap.className = 'pdf-page-wrap';
    wrap.dataset.page = String(n - 1);
    wrap.style.maxWidth = `${MAX_PAGE_WIDTH}px`;
    wrap.style.aspectRatio = `${base.width} / ${base.height}`;
    wrap.setAttribute('aria-label', `Page ${n} of ${pdf.numPages}`);

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    wrap.appendChild(canvas);
    frag.appendChild(wrap);
    pages.push({ el: wrap, page, viewport, canvas });
  }

  container.innerHTML = '';
  container.appendChild(frag);

  // Render page images after layout so the first page appears quickly.
  (async () => {
    for (const p of pages) {
      await p.page.render({ canvas: p.canvas, canvasContext: p.canvas.getContext('2d'), viewport: p.viewport }).promise;
    }
  })().catch(e => console.error('PDF render failed', e));

  return pages.map(p => p.el);
}

// Position an absolutely-placed overlay using fractional (0..1) coordinates.
export function placeBox(el, f) {
  el.style.left = `${f.x * 100}%`;
  el.style.top = `${f.y * 100}%`;
  el.style.width = `${f.width * 100}%`;
  el.style.height = `${f.height * 100}%`;
}
