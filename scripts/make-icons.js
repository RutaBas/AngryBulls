"use strict";

/* BULLPEN — icon generator.  node scripts/make-icons.js

   Writes real PNGs into icons/, so the app icon is reproducible from source and
   never a checked-in binary nobody can regenerate. No dependencies: the PNG is
   encoded here with node's own zlib.

   The mark is the app-mark from the design screens — a bull head, drawn in the
   rose pen's pastel and the deep-wine rule, on a rounded pastel tile. Every
   shape is rendered 3x and box-downsampled, which is the whole anti-aliasing
   strategy and is plenty at icon sizes. */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// ------------------------------------------------------------- PNG encoding
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// -------------------------------------------------------------- tiny raster
function hex(h) {
  return [parseInt(h.substr(1, 2), 16), parseInt(h.substr(3, 2), 16), parseInt(h.substr(5, 2), 16)];
}
function surface(w, h) {
  const buf = Buffer.alloc(w * h * 4);
  const S = {
    w, h, buf,
    set(x, y, c) {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const i = (y * w + x) * 4;
      buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = 255;
    },
    roundRect(x0, y0, x1, y1, r, c) {
      for (let y = Math.round(y0); y < Math.round(y1); y++) {
        for (let x = Math.round(x0); x < Math.round(x1); x++) {
          const dx = Math.max(x0 + r - x, 0, x - (x1 - r - 1));
          const dy = Math.max(y0 + r - y, 0, y - (y1 - r - 1));
          if (dx * dx + dy * dy <= r * r) S.set(x, y, c);
        }
      }
    },
    ellipse(cx, cy, rx, ry, c) {
      for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
        for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
          const dx = (x - cx) / rx, dy = (y - cy) / ry;
          if (dx * dx + dy * dy <= 1) S.set(x, y, c);
        }
      }
    },
    disk(cx, cy, r, c) { S.ellipse(cx, cy, r, r, c); },
    /* A stroked arc: stamp a disk along the path. Crude and completely
       adequate once the whole thing is downsampled 3x. */
    arc(cx, cy, r, a0, a1, width, c) {
      const steps = Math.max(24, Math.round(r * 3));
      for (let i = 0; i <= steps; i++) {
        const a = a0 + ((a1 - a0) * i) / steps;
        S.disk(cx + Math.cos(a) * r, cy + Math.sin(a) * r, width / 2, c);
      }
    },
  };
  return S;
}

const TILE = hex("#F7CBC7");   // pen 1, rose
const HORN = hex("#CF6A62");   // pen 1's dot & horn colour
const RULE = hex("#6E2639");   // the deep-wine rule
const FACE = hex("#FBF5E8");   // card cream

/* size = final pixels; bleed keeps the mark inside the maskable safe zone and
   fills the tile edge to edge. */
function drawIcon(size, opts) {
  const o = opts || {};
  const SS = 3;
  const S = size * SS;
  const s = surface(S, S);
  const pad = o.bleed ? 0 : Math.round(S * 0.055);
  const r = o.bleed ? 0 : Math.round(S * 0.22);

  s.roundRect(pad, pad, S - pad, S - pad, r, TILE);

  // the mark, in a unit box that shrinks for the maskable safe zone
  const scale = o.bleed ? 0.68 : 0.82;
  const u = (v) => S / 2 + (v - 0.5) * S * scale;
  const L = (v) => v * S * scale;

  const rule = Math.max(2, L(0.055));

  // horns — a crescent each side, rising from the head and curling up and out
  s.arc(u(0.33), u(0.30), L(0.17), 0.80 * Math.PI, 1.55 * Math.PI, rule, HORN);
  s.arc(u(0.67), u(0.30), L(0.17), -0.55 * Math.PI, 0.20 * Math.PI, rule, HORN);

  // head: wine outline, cream face
  s.ellipse(u(0.5), u(0.545), L(0.29), L(0.325), RULE);
  s.ellipse(u(0.5), u(0.545), L(0.29) - rule, L(0.325) - rule, FACE);

  // muzzle
  s.ellipse(u(0.5), u(0.705), L(0.165), L(0.115), RULE);
  s.ellipse(u(0.5), u(0.705), L(0.165) - rule * 0.7, L(0.115) - rule * 0.7, HORN);

  // eyes and nostrils
  s.disk(u(0.395), u(0.5), L(0.043), RULE);
  s.disk(u(0.605), u(0.5), L(0.043), RULE);
  s.disk(u(0.455), u(0.712), L(0.028), RULE);
  s.disk(u(0.545), u(0.712), L(0.028), RULE);

  // box downsample SS x SS -> 1
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let a = 0, b = 0, c = 0, d = 0;
      for (let j = 0; j < SS; j++) {
        for (let i = 0; i < SS; i++) {
          const k = ((y * SS + j) * S + (x * SS + i)) * 4;
          a += s.buf[k]; b += s.buf[k + 1]; c += s.buf[k + 2]; d += s.buf[k + 3];
        }
      }
      const n = SS * SS, k = (y * size + x) * 4;
      out[k] = Math.round(a / n); out[k + 1] = Math.round(b / n);
      out[k + 2] = Math.round(c / n); out[k + 3] = Math.round(d / n);
    }
  }
  return encodePNG(size, size, out);
}

const dir = path.join(__dirname, "..", "icons");
fs.mkdirSync(dir, { recursive: true });

[
  ["icon-192.png", 192, {}],
  ["icon-512.png", 512, {}],
  ["icon-512-maskable.png", 512, { bleed: true }],
  ["apple-touch-icon.png", 180, { bleed: true }],  // iOS masks it itself
  ["favicon-32.png", 32, {}],
].forEach(([name, size, opts]) => {
  const png = drawIcon(size, opts);
  fs.writeFileSync(path.join(dir, name), png);
  console.log("wrote icons/" + name + "  " + size + "x" + size + "  " + png.length + " bytes");
});
