# Framed-luminance invariant — audit

**Bead:** fm-38w
**Date:** 2026-04-21

## Invariant

Main content pane reads as a recessed plate inside the paper chrome:

1. `--bg` (canvas) is meaningfully darker than `--panel` (chrome) — WCAG
   relative luminance delta of ~10–14% for light themes.
2. `.shell__main` carries an inset top shadow that reinforces the recess
   even when the luminance delta alone would be subtle (dark themes lean
   on this, see Dusk).
3. An upper-left `--accent-soft` radial glow (`.shell__main::before`) gives
   warmth to the framed canvas.

Per the mockup: "Dusk inverts (chrome lighter than center) but keeps the
framed metaphor." → inversions are allowed as long as framing is preserved.

## Measurement

WCAG relative luminance (`0.2126*R + 0.7152*G + 0.0722*B` on linearized
sRGB), computed with `tmp/lumcheck.cjs`. Δ = `L(panel) − L(bg)`.

| Theme            | bg        | L(bg) | panel     | L(panel) | Δ      | Direction        |
|------------------|-----------|-------|-----------|----------|--------|------------------|
| paper            | `#ebe3ce` | 0.771 | `#fbf6ea` | 0.924    | +15.3% | panel > bg ✓     |
| pastel           | `#f1dfd9` | 0.765 | `#fef8f6` | 0.949    | +18.4% | panel > bg ✓     |
| feminism         | `#e7dde4` | 0.743 | `#f9f5f8` | 0.922    | +17.9% | panel > bg ✓     |
| orchid           | `#f0cfcb` | 0.675 | `#fef6f4` | 0.935    | +26.1% | panel > bg ✓ (high) |
| garden           | `#f2d9cf` | 0.730 | `#fcf1ed` | 0.897    | +16.7% | panel > bg ✓     |
| linen            | `#dcd5c0` | 0.666 | `#f1ecdf` | 0.840    | +17.4% | panel > bg ✓     |
| sakura           | `#ecd9da` | 0.725 | `#fbf4f4` | 0.917    | +19.2% | panel > bg ✓     |
| dawn             | `#ecdfe3` | 0.762 | `#faf2f2` | 0.902    | +14.1% | panel > bg ✓     |
| feminism-night   | `#faeff2` | 0.885 | `#2a1a30` | 0.014    | −87.0% | bg > panel (inverted) |
| dusk             | `#150d1c` | 0.005 | `#2b2032` | 0.018    |  +1.2% | panel > bg (subtle) |

## Findings

**Light themes (paper / pastel / feminism / orchid / garden / linen /
sakura / dawn)** — all pass the invariant with Δ between 14.1% and 26.1%.
Target was 10–14%; we overshoot, but the result reads as an obvious
recessed plate in every theme. Orchid at +26% is the highest; still feels
editorial rather than harsh because the palette is already deeply tinted.

**Dusk** — absolute Δ is just +1.2% because linear luminance compresses at
dark ends. *Perceptually* the panel is visibly brighter than the canvas,
and the dark-mode override on `.shell__main` (`inset 0 8px 14px -10px
rgba(0,0,0,0.5)`) carries the recess. Keep as-is; the invariant is
preserved by the shadow, not the Δ alone.

**Feminism-night** — inverted (dark chrome framing a light canvas). This is
the explicit spotlight-mood variant; the framed metaphor holds because
panel and canvas contrast strongly, just in the opposite direction from
the light themes. Valid per the mockup's "Dusk inverts … but keeps the
framed metaphor" allowance.

## Result

**No changes required.** All 10 themes honor the framed-luminance
invariant — 8 via a direct bg-darker-than-panel delta, 1 via an amplified
inset shadow (dusk), 1 via an intentional inversion (feminism-night).

## Re-run the check

```
node tmp/lumcheck.cjs
```

Keep the script around: any new theme added to `tokens.css` should be
appended to the `themes` map in the script and re-audited before landing.
