// Full-page screenshot → PDF (task: PDF button next to Record).
//
// Auto-scrolls the given embedded browser view and screenshots each viewport,
// then assembles the shots into one PDF (one page per viewport — no CDP
// stitching). Plain `webContents.capturePage()`, so this never touches the
// debugger and can't collide with Record's single-client CDP session.

import fs from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { stateDir } from '../core/profile.mjs';
import path from 'node:path';
import type { WebContentsView } from 'electron';
import { PDFDocument } from 'pdf-lib';

const SCREENSHOTS_DIR = path.join(stateDir(), 'screenshots');
const MAX_SHOTS = 40; // guards against runaway/infinite-scroll pages
const SETTLE_MS = 150; // let lazy content/reflow catch up after each scroll

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultOutPath(url: string): string {
  if (!existsSync(SCREENSHOTS_DIR)) mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  let host = 'page';
  try {
    host = new URL(url).hostname || 'page';
  } catch {
    /* file:// or about: urls — keep the default */
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(SCREENSHOTS_DIR, `${host}-${stamp}.pdf`);
}

type PageMetrics = { scrollHeight: number; viewportHeight: number; scrollY0: number };

export async function capturePagePdf(
  view: WebContentsView,
  opts: { outPath?: string } = {},
): Promise<{ ok: boolean; error?: string; path?: string; pages?: number }> {
  const wc = view.webContents;
  if (!wc || wc.isDestroyed()) return { ok: false, error: 'no live web view' };

  let metrics: PageMetrics;
  try {
    metrics = (await wc.executeJavaScript(
      `({ scrollHeight: document.documentElement.scrollHeight, viewportHeight: window.innerHeight, scrollY0: window.scrollY })`,
      true,
    )) as PageMetrics;
  } catch (e) {
    return { ok: false, error: `could not read page metrics: ${(e as Error).message}` };
  }
  if (!metrics.viewportHeight) return { ok: false, error: 'zero-height viewport' };

  const shots = Math.min(
    MAX_SHOTS,
    Math.max(1, Math.ceil(metrics.scrollHeight / metrics.viewportHeight)),
  );

  const pngBuffers: Buffer[] = [];
  const sizes: Array<{ width: number; height: number }> = [];
  try {
    for (let i = 0; i < shots; i++) {
      await wc.executeJavaScript(`window.scrollTo(0, ${i * metrics.viewportHeight})`, true);
      await sleep(SETTLE_MS);
      const img = await wc.capturePage();
      pngBuffers.push(img.toPNG());
      sizes.push(img.getSize());
    }
  } finally {
    try {
      if (!wc.isDestroyed()) {
        await wc.executeJavaScript(`window.scrollTo(0, ${metrics.scrollY0})`, true);
      }
    } catch {
      /* best-effort restore */
    }
  }

  const pdfDoc = await PDFDocument.create();
  for (let i = 0; i < pngBuffers.length; i++) {
    const embedded = await pdfDoc.embedPng(pngBuffers[i]);
    const { width, height } = sizes[i];
    const page = pdfDoc.addPage([width, height]);
    page.drawImage(embedded, { x: 0, y: 0, width, height });
  }
  const bytes = await pdfDoc.save();

  const outPath = opts.outPath || defaultOutPath(wc.getURL());
  const outDir = path.dirname(outPath);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  await fs.writeFile(outPath, bytes);

  return { ok: true, path: outPath, pages: pngBuffers.length };
}
