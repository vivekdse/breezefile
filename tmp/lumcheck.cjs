function hex(h) {
  h = h.replace('#','');
  const r = parseInt(h.slice(0,2),16);
  const g = parseInt(h.slice(2,4),16);
  const b = parseInt(h.slice(4,6),16);
  return [r,g,b];
}
function lum([r,g,b]) {
  const srgb = [r,g,b].map(v => {
    v /= 255;
    return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4);
  });
  return 0.2126*srgb[0] + 0.7152*srgb[1] + 0.0722*srgb[2];
}
const themes = {
  paper:           ['#ebe3ce','#fbf6ea'],
  pastel:          ['#f1dfd9','#fef8f6'],
  feminism:        ['#e7dde4','#f9f5f8'],
  orchid:          ['#f0cfcb','#fef6f4'],
  garden:          ['#f2d9cf','#fcf1ed'],
  linen:           ['#dcd5c0','#f1ecdf'],
  sakura:          ['#ecd9da','#fbf4f4'],
  dawn:            ['#ecdfe3','#faf2f2'],
  'feminism-night':['#faeff2','#2a1a30'],
  dusk:            ['#150d1c','#2b2032'],
};
for (const [name,[bg,panel]] of Object.entries(themes)) {
  const lbg = lum(hex(bg));
  const lp  = lum(hex(panel));
  const delta = lp - lbg;
  const pct = (delta * 100).toFixed(1);
  const dir = delta > 0 ? 'panel > bg' : delta < 0 ? 'bg > panel' : '==';
  console.log(`${name.padEnd(18)} bg=${bg} L=${lbg.toFixed(3)}  panel=${panel} L=${lp.toFixed(3)}  Δ=${pct.padStart(5)}% (${dir})`);
}
