// `perceive` — the CAPTURE-PASS verb: fields + fingerprints + annotated shot,
// all from ONE enumeration (docs/operator-speed/perceive-once-act-from-memory.md).
//
// WHY ONE VERB. Run 1 of a task is allowed to be slow because its job is to
// make runs 2..N skip perception entirely: the agent stores the fingerprints
// in TypeBuild site memory (remember_site) and, on the next visit, acts from
// memory — re-perceiving only on error/drift. This verb emits everything that
// capture pass needs in one invocation, keyed by ONE set of refs:
//   1. the normal `fields` listing (stdout — same renderer, same refs),
//   2. a fingerprints JSON file (structure-only signals per ref: id/test-id/
//      href/name-source/nearest-heading/landmark/bbox + collision counts —
//      the durable identity a future field-interact resolves against),
//   3. a ref-badged screenshot (downscaled to ~768px — the empirical floor
//      below which vision models hallucinate text instead of admitting
//      illegibility) so the agent can SEE what each ref is. Badges carry the
//      REAL refs, so text, JSON, and image share one keyspace.
//
// WHY COMPOSITE OFF-DOM. Drawing badges by injecting overlay DOM mutates the
// page — perception that perturbs what it measures. Instead we screenshot the
// CLEAN page, then composite boxes+badges onto the PNG inside the page's JS
// context via OffscreenCanvas (pure computation, no DOM, no CSP-visible
// network, no native image dependency). Badges are drawn AFTER downscaling at
// a fixed font size, so their legibility is resolution-independent.
//
// TEMPORAL CONSISTENCY. Coordinates sampled at T0 and pixels captured at T1
// can disagree (carousels, animations). We bracket: sample bboxes → screenshot
// → re-sample; refs that moved are flagged `unstable` in the JSON and listed
// on stdout — annotate everything stable, confess the movers.
//
// NON-PHI. The JSON file persists to disk, so it carries STRUCTURE ONLY:
// refs, labels, attribute names/ids, geometry. Never a field VALUE (values
// appear only in the stdout listing, same as `fields`). Safe for remember_site.

import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { collectFields, renderFieldsText } from './field-verbs.mjs';

/** Signal harvest for one element — the durable identity bundle a memory-based
 *  resolver can match against later. One evaluate per element, own-frame safe. */
async function signalsFor(locator) {
  return locator.evaluate((el) => {
    const g = (a) => el.getAttribute(a);
    // Which rung of the accname ladder produced the accessible name — this
    // decides HOW a resolver should query later (attribute match vs text match).
    let nameSource = 'none';
    if (g('aria-label')) nameSource = 'aria-label';
    else if (g('aria-labelledby')) nameSource = 'aria-labelledby';
    else if (el.labels && el.labels.length) nameSource = 'label';
    else if (g('alt')) nameSource = 'alt';
    else if (g('title')) nameSource = 'title';
    else if ((el.innerText || '').trim()) nameSource = 'innerText';

    const nearestHeading = (() => {
      let n = el.parentElement;
      while (n && n !== el.ownerDocument.body) {
        const h = n.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"]');
        if (h && h.innerText && h.innerText.trim()) {
          return h.innerText.trim().replace(/\s+/g, ' ').slice(0, 60);
        }
        n = n.parentElement;
      }
      return null;
    })();

    const lm = el.closest(
      'main,nav,header,footer,aside,form,[role="main"],[role="navigation"],' +
        '[role="banner"],[role="search"],[role="region"],[role="form"]',
    );
    const landmark = lm
      ? (lm.getAttribute('role') || lm.tagName.toLowerCase()) +
        (lm.getAttribute('aria-label') ? ` "${lm.getAttribute('aria-label')}"` : '')
      : null;

    let hrefPath = null;
    if (el.href) {
      try {
        hrefPath = new URL(el.href).pathname;
      } catch {
        hrefPath = g('href');
      }
    }

    const out = {
      nameSource,
      domId: el.id || null,
      testId: g('data-testid') || g('data-test-id') || g('data-qa') || g('data-id') || null,
      nameAttr: g('name') || null,
      placeholder: g('placeholder') || null,
      autocomplete: g('autocomplete') || null,
      hrefPath,
      classes: (typeof el.className === 'string' ? el.className : '')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 4),
      nearestHeading,
      landmark,
    };
    // prune empties so the persisted JSON stays readable
    for (const k of Object.keys(out)) {
      const v = out[k];
      if (v === null || (Array.isArray(v) && v.length === 0)) delete out[k];
    }
    return out;
  });
}

const FORM_COLOR = '#e11d48'; // red — true form fields
const TOP_COLOR = '#2563eb'; // blue — top-document buttons/links
const FRAME_COLOR = '#059669'; // green — iframe buttons/links
const NAV_KINDS = new Set(['button', 'link']);

/**
 * The capture pass. Emits stdout text and writes two (or three) files into
 * `outDir` (the caller's cwd — the agent's session dir, Read-able):
 *   perceive-annotated.png   ref-badged screenshot at `width`px
 *   perceive.json            fingerprints (structure only)
 *   perceive-crop-<ref>.png  native-res cutout when `crop` is given
 *
 * @param page  resolved Playwright Page
 * @param opts.width   annotated image width in px (default 768 — the floor)
 * @param opts.crop    a ref to also emit as a native-resolution crop
 * @param opts.outDir  where files land (default process.cwd())
 * @returns {Promise<{ text: string }>}
 */
export async function perceiveVisual(page, { width = 768, crop, outDir } = {}) {
  const dir = outDir || process.cwd();
  const { classified } = await collectFields(page);
  const fieldsText = await renderFieldsText(classified);

  // Page identity (structure only) + real CSS viewport for coordinate mapping.
  const identity = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    headings: Array.from(document.querySelectorAll('h1,h2'))
      .map((h) => h.innerText.trim().replace(/\s+/g, ' ').slice(0, 60))
      .filter(Boolean)
      .slice(0, 12),
    vw: window.innerWidth,
    vh: window.innerHeight,
  }));

  // Signals + first bbox sample per ref (best-effort — a vanished element gets
  // a fingerprint without geometry rather than aborting the pass).
  const records = [];
  for (const c of classified) {
    let signals = null;
    let bbox = null;
    try {
      signals = await signalsFor(c.loc);
    } catch {
      /* element gone / cross-origin — fingerprint without signals */
    }
    try {
      bbox = await c.loc.boundingBox(); // main-viewport CSS px, iframes composited
    } catch {
      /* no geometry */
    }
    records.push({ c, signals, bbox, unstable: false });
  }

  // Uniqueness at capture time: how many refs share this (kind, name)? A
  // collision count > 1 means name-alone can NEVER resolve this ref — the
  // stored discriminator (nearestHeading / testId / hrefPath) is load-bearing.
  const keyOf = (c) => `${c.kind}|${c.node.name ?? ''}`;
  const counts = new Map();
  for (const { c } of records) counts.set(keyOf(c), (counts.get(keyOf(c)) || 0) + 1);

  // Clean screenshot (no overlay, page untouched) …
  const png = await page.screenshot();

  // … then bracket: re-sample bboxes. Movers get flagged, not trusted.
  for (const r of records) {
    if (!r.bbox) continue;
    try {
      const b2 = await r.c.loc.boundingBox();
      r.unstable =
        !b2 || Math.abs(b2.x - r.bbox.x) > 2 || Math.abs(b2.y - r.bbox.y) > 2;
    } catch {
      r.unstable = true;
    }
  }

  // Composite boxes + badges onto the PNG via OffscreenCanvas in the page's JS
  // context — pure computation, no DOM mutation, no extra dependency.
  const boxes = records
    .filter((r) => r.bbox && !r.unstable)
    .map((r) => ({
      ref: r.c.node.ref,
      x: r.bbox.x,
      y: r.bbox.y,
      w: r.bbox.width,
      h: r.bbox.height,
      color: !NAV_KINDS.has(r.c.kind)
        ? FORM_COLOR
        : r.c.node.framePath
          ? FRAME_COLOR
          : TOP_COLOR,
    }));

  let annotatedB64 = null;
  let annotateErr = null;
  try {
    annotatedB64 = await page.evaluate(
      async ({ b64, boxes, targetWidth, vw }) => {
        const blob = await (await fetch('data:image/png;base64,' + b64)).blob();
        const img = await createImageBitmap(blob);
        const scale = targetWidth / img.width;
        const cssScale = targetWidth / vw; // CSS px → target px (DPR-safe)
        const canvas = new OffscreenCanvas(targetWidth, Math.round(img.height * scale));
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        ctx.font = 'bold 10px monospace';
        for (const b of boxes) {
          const x = b.x * cssScale;
          const y = b.y * cssScale;
          const w = b.w * cssScale;
          const h = b.h * cssScale;
          if (y > canvas.height || x > canvas.width || y + h < 0 || x + w < 0) continue;
          ctx.strokeStyle = b.color;
          ctx.lineWidth = 1.5;
          if (w * h > canvas.width * canvas.height * 0.15) {
            // Oversized container (carousel, hero card): corner ticks, don't
            // occlude the content with a giant rectangle.
            ctx.beginPath();
            ctx.moveTo(x, y + 12);
            ctx.lineTo(x, y);
            ctx.lineTo(x + 12, y);
            ctx.moveTo(x + w - 12, y);
            ctx.lineTo(x + w, y);
            ctx.lineTo(x + w, y + 12);
            ctx.stroke();
          } else {
            ctx.strokeRect(x, y, w, h);
          }
          const label = b.ref;
          const tw = Math.ceil(ctx.measureText(label).width) + 4;
          // Badge INSIDE the box's top-left (post-downscale, fixed font) —
          // above it only when the box is too short to hold one.
          const bx = Math.max(0, Math.min(x, canvas.width - tw));
          const by = h >= 14 ? y : Math.max(0, y - 12);
          ctx.fillStyle = b.color;
          ctx.fillRect(bx, by, tw, 12);
          ctx.fillStyle = '#fff';
          ctx.fillText(label, bx + 2, by + 9);
        }
        const out = await canvas.convertToBlob({ type: 'image/png' });
        const buf = new Uint8Array(await out.arrayBuffer());
        let s = '';
        for (let i = 0; i < buf.length; i += 0x8000) {
          s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
        }
        return btoa(s);
      },
      { b64: png.toString('base64'), boxes, targetWidth: width, vw: identity.vw },
    );
  } catch (e) {
    annotateErr = e?.message || String(e);
  }

  const pngPath = path.join(dir, 'perceive-annotated.png');
  if (annotatedB64) {
    writeFileSync(pngPath, Buffer.from(annotatedB64, 'base64'));
  } else {
    // Annotation engine unavailable (exotic CSP / no OffscreenCanvas): still
    // deliver the clean shot rather than nothing — the JSON carries the bboxes.
    writeFileSync(pngPath, png);
  }

  // Fingerprints file — STRUCTURE ONLY (no values), safe to persist and to
  // store via remember_site. Bboxes rounded; collisions only when > 1.
  const fingerprints = {
    capturedAt: new Date().toISOString(),
    page: { url: identity.url, title: identity.title, headings: identity.headings },
    note: 'structure only (no field values) — store via remember_site keyed by origin+route; refs die, signals persist',
    refs: records.map((r) => {
      const entry = {
        ref: r.c.node.ref,
        kind: r.c.kind,
        frame: r.c.node.framePath || 'top',
        name: r.c.node.name ?? '',
      };
      const n = counts.get(keyOf(r.c));
      if (n > 1) entry.collisions = n;
      if (r.signals) entry.signals = r.signals;
      if (r.c.d?.required) entry.required = true;
      if (r.c.d?.disabled) entry.disabled = true;
      if (r.bbox) {
        entry.bbox = {
          x: Math.round(r.bbox.x),
          y: Math.round(r.bbox.y),
          w: Math.round(r.bbox.width),
          h: Math.round(r.bbox.height),
        };
      }
      if (r.unstable) entry.unstable = true;
      return entry;
    }),
  };
  const jsonPath = path.join(dir, 'perceive.json');
  writeFileSync(jsonPath, JSON.stringify(fingerprints, null, 1) + '\n');

  // Optional native-resolution crop of one ref — the foveal glance for
  // pixel-borne content (image-only banners, icons). Tens of tokens.
  let cropLine = null;
  if (crop) {
    const r = records.find((x) => x.c.node.ref === crop);
    if (!r) {
      cropLine = `[crop] unknown ref "${crop}" — not emitted`;
    } else if (!r.bbox) {
      cropLine = `[crop] ref "${crop}" has no geometry (hidden?) — not emitted`;
    } else {
      const cropPath = path.join(dir, `perceive-crop-${crop}.png`);
      const pad = 8;
      await page.screenshot({
        path: cropPath,
        clip: {
          x: Math.max(0, r.bbox.x - pad),
          y: Math.max(0, r.bbox.y - pad),
          width: r.bbox.width + pad * 2,
          height: r.bbox.height + pad * 2,
        },
      });
      cropLine = `[crop] ${cropPath} (native res)`;
    }
  }

  // stdout: the familiar fields listing first, then the visual/fingerprint
  // pointers and the capture-time uniqueness verdict.
  const collisionRefs = records.filter((r) => counts.get(keyOf(r.c)) > 1);
  const unstableRefs = records.filter((r) => r.unstable).map((r) => r.c.node.ref);
  const unique = records.length - collisionRefs.length;

  const lines = [fieldsText];
  lines.push(
    annotatedB64
      ? `[visual] ${pngPath} (${width}px; badges = refs; red=field, blue=top nav, green=iframe nav) — READ this PNG to ground the refs before acting`
      : `[visual] ${pngPath} (UNANNOTATED — in-page compositing failed: ${annotateErr}; bboxes are in the JSON)`,
  );
  lines.push(
    `[fingerprints] ${jsonPath} — durable signals per ref (structure only). ` +
      'This file is a per-run working artifact: READ it to decide what matters, then remember_site a CURATED distillation — ' +
      'only the fields this task used or recurring tasks here will plausibly need (+ their recipes/receipts). Never store the raw dump.',
  );
  lines.push(
    `[uniqueness] ${unique}/${records.length} refs unique by (kind, label) at capture` +
      (collisionRefs.length
        ? `; ${collisionRefs.length} need a discriminator (see "collisions" + nearestHeading/testId in the JSON)`
        : ''),
  );
  if (unstableRefs.length) {
    lines.push(
      `[unstable] moved during capture (animated — badges omitted, do not trust their geometry): ${unstableRefs.join(', ')}`,
    );
  }
  if (cropLine) lines.push(cropLine);
  lines.push(
    '→ act: field-fill/field-select <ref> · remember: store fingerprints via remember_site · next visit: recall_site FIRST, act from memory, re-perceive only on error',
  );
  return { text: lines.join('\n') };
}
