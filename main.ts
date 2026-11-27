// png-squeeze: a lossless PNG re-encoder written from scratch.
// Reads stored RGBA screenshots, picks the smallest lossless representation
// (palette / grey / grey+alpha / RGB / RGBA), filters each row by a
// minimum-entropy heuristic, and compresses with a from-scratch DEFLATE
// encoder (lazy LZ77 + dynamic Huffman), falling back to Node's zlib
// level 9 when that is smaller. Fully deterministic: fixed work budgets,
// no clock, no randomness.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';

const W = 1280;
const H = 720;
const IDS = ['i001', 'i002', 'i003', 'i004', 'i005', 'i006', 'i007', 'i008'];

// ---------- CRC-32 (PNG) ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(bytes, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) { a += bytes[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// ---------- PNG decoding (own code) ----------
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}
const CHANS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function decodePng(buf) {
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let width = 0, height = 0, colourType = 0;
  let palette = null, trns = null;
  const idat = [];
  while (at < bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      width = dv.getUint32(0); height = dv.getUint32(4); colourType = data[9];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  const bpp = CHANS[colourType];
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat.map((d) => Buffer.from(d))));
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride, p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    }
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) rgba.set(samples);
  else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s]; rgba[d + 1] = samples[s + 1]; rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      rgba[d] = palette[e * 3]; rgba[d + 1] = palette[e * 3 + 1]; rgba[d + 2] = palette[e * 3 + 2];
      rgba[d + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
  }
  return { width, height, rgba };
}

// ---------- PNG encoding (own code) ----------
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  out[4] = type.charCodeAt(0); out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2); out[7] = type.charCodeAt(3);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}
function encodePng(width, height, colourType, palette, trns, idat) {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width); v.setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = colourType;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr)];
  if (palette) parts.push(chunk('PLTE', palette));
  if (trns) parts.push(chunk('tRNS', trns));
  parts.push(chunk('IDAT', idat));
  parts.push(chunk('IEND', new Uint8Array(0)));
  let size = 0;
  for (const p of parts) size += p.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
function zlibWrap(deflateBytes, raw) {
  const out = new Uint8Array(2 + deflateBytes.length + 4);
  out[0] = 0x78; out[1] = 0xda;
  out.set(deflateBytes, 2);
  new DataView(out.buffer).setUint32(2 + deflateBytes.length, adler32(raw));
  return out;
}

// ---------- Image analysis: pick the smallest lossless representation ----------
// Returns { colourType, bpp, samples, palette, trns }.
function analyse(rgba, width, height) {
  const n = width * height;
  let allOpaque = true;
  let allGrey = true;
  let alphaOther = false; // an alpha value other than 0 or 255
  const transparentRgb = new Set(); // RGB triples seen with alpha 0 (cap: >1 matters)
  const colors = new Map(); // rgba32 -> palette index (first occurrence order)
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    const r = rgba[d], g = rgba[d + 1], b = rgba[d + 2], a = rgba[d + 3];
    if (a !== 255) {
      allOpaque = false;
      if (a !== 0) alphaOther = true;
      else if (transparentRgb.size <= 1) transparentRgb.add((r << 16) | (g << 8) | b);
    }
    if (r !== g || g !== b) allGrey = false;
    if (colors.size <= 256) {
      const key = ((r * 256 + g) * 256 + b) * 256 + a;
      if (!colors.has(key)) colors.set(key, colors.size);
    }
  }
  const usePalette = colors.size <= 256;
  if (allGrey) {
    if (allOpaque) {
      const samples = new Uint8Array(n);
      for (let i = 0, d = 0; i < n; i++, d += 4) samples[i] = rgba[d];
      return { colourType: 0, bpp: 1, samples, palette: null, trns: null };
    }
    if (!alphaOther && transparentRgb.size === 1) {
      // One grey value is transparent: type 0 + tRNS.
      const key = [...transparentRgb][0];
      const grey = (key >> 16) & 0xff;
      const samples = new Uint8Array(n);
      for (let i = 0, d = 0; i < n; i++, d += 4) samples[i] = rgba[d];
      const trns = new Uint8Array([0, grey]);
      return { colourType: 0, bpp: 1, samples, palette: null, trns };
    }
    const samples = new Uint8Array(n * 2);
    for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += 2) {
      samples[s] = rgba[d]; samples[s + 1] = rgba[d + 3];
    }
    return { colourType: 4, bpp: 2, samples, palette: null, trns: null };
  }
  if (usePalette) {
    // Palette entries stay in first-occurrence order.
    const entries = [...colors.keys()].map((key) => ({
      key,
      r: (key >>> 24) & 0xff, g: (key >>> 16) & 0xff, b: (key >>> 8) & 0xff, a: key & 0xff,
    }));
    const remap = new Map();
    entries.forEach((e, idx) => remap.set(e.key, idx));
    const count = entries.length;
    const palette = new Uint8Array(count * 3);
    const alphas = new Uint8Array(count);
    entries.forEach((e, idx) => {
      palette[idx * 3] = e.r; palette[idx * 3 + 1] = e.g; palette[idx * 3 + 2] = e.b;
      alphas[idx] = e.a;
    });
    const samples = new Uint8Array(n);
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const key = ((rgba[d] * 256 + rgba[d + 1]) * 256 + rgba[d + 2]) * 256 + rgba[d + 3];
      samples[i] = remap.get(key);
    }
    let trns = null;
    if (!allOpaque) {
      let last = count - 1;
      while (last > 0 && alphas[last] === 255) last--;
      trns = alphas.subarray(0, last + 1);
    }
    return { colourType: 3, bpp: 1, samples, palette, trns };
  }
  if (allOpaque) {
    const samples = new Uint8Array(n * 3);
    for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += 3) {
      samples[s] = rgba[d]; samples[s + 1] = rgba[d + 1]; samples[s + 2] = rgba[d + 2];
    }
    return { colourType: 2, bpp: 3, samples, palette: null, trns: null };
  }
  if (!alphaOther && transparentRgb.size === 1) {
    // One RGB triple is transparent: type 2 + tRNS.
    const key = [...transparentRgb][0];
    const samples = new Uint8Array(n * 3);
    for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += 3) {
      samples[s] = rgba[d]; samples[s + 1] = rgba[d + 1]; samples[s + 2] = rgba[d + 2];
    }
    const trns = new Uint8Array([0, (key >> 16) & 0xff, 0, (key >> 8) & 0xff, 0, key & 0xff]);
    return { colourType: 2, bpp: 3, samples, palette: null, trns };
  }
  return { colourType: 6, bpp: 4, samples: rgba, palette: null, trns: null };
}

// ---------- Row filtering: minimum-entropy filter per row ----------
// LOG2K[k] = k * log2(k); row entropy cost is maximised sum of LOG2K[count].
const LOG2K = (() => {
  const t = new Float64Array(W * 4 + 1);
  for (let k = 1; k < t.length; k++) t[k] = k * Math.log2(k);
  return t;
})();

const STRATEGIES = ['entropy', 'minsum', 'none', 'sub', 'paeth', 'up'];

function filterRowInto(type, cur, prev, bpp, out) {
  const stride = cur.length;
  if (type === 0) out.set(cur);
  else if (type === 1) {
    for (let i = 0; i < stride; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    if (prev === null) out.set(cur);
    else for (let i = 0; i < stride; i++) out[i] = cur[i] - prev[i];
  } else if (type === 3) {
    for (let i = 0; i < stride; i++) {
      out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
    }
  } else {
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

function filterImage(samples, width, height, bpp, strategy) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial = new Uint8Array(stride);
  const best = new Uint8Array(stride);
  const hist = new Uint16Array(256);
  const fixed = { none: 0, sub: 1, up: 2, avg: 3, paeth: 4 }[strategy];
  const useMinsum = strategy === 'minsum';
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    let bestType = 0;
    let bestScore = -Infinity;
    for (let type = 0; type < 5; type++) {
      if (fixed !== undefined && type !== fixed) continue;
      filterRowInto(type, cur, prev, bpp, trial);
      hist.fill(0);
      for (let i = 0; i < stride; i++) hist[trial[i]]++;
      let score = 0;
      if (useMinsum) {
        for (let i = 0; i < stride; i++) { const v = trial[i]; score += v < 128 ? v : 256 - v; }
        score = -score; // higher is better, like entropy score
      } else {
        for (let v = 0; v < 256; v++) {
          const c = hist[v];
          if (c > 1) score += LOG2K[c];
        }
      }
      if (score > bestScore) { bestScore = score; bestType = type; best.set(trial); }
    }
    raw[y * (stride + 1)] = bestType;
    raw.set(best, y * (stride + 1) + 1);
  }
  return raw;
}

// ---------- DEFLATE encoder (own code, RFC 1951) ----------
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
const CHAIN_LIMIT = 8192;
const BLOCK_BYTES = 262144;

class BitWriter {
  constructor() { this.bytes = []; this.acc = 0; this.nbits = 0; }
  write(value, count) {
    this.acc |= value << this.nbits;
    this.nbits += count;
    while (this.nbits >= 8) {
      this.bytes.push(this.acc & 0xff);
      this.acc >>>= 8;
      this.nbits -= 8;
    }
  }
  finish() {
    if (this.nbits > 0) this.bytes.push(this.acc & 0xff);
    return new Uint8Array(this.bytes);
  }
}

// Huffman code lengths for `freq` (Uint32Array), each 1..maxBits, Kraft sum = 1.
// Optimal tree, then collapse-and-split length limiting when the tree runs
// deeper than maxBits. Deterministic throughout.
function buildLengths(freq, maxBits) {
  const n = freq.length;
  const len = new Uint8Array(n);
  const syms = [];
  for (let i = 0; i < n; i++) if (freq[i] > 0) syms.push(i);
  if (syms.length === 0) { len[0] = 1; len[1] = 1; return len; }
  if (syms.length === 1) {
    const only = syms[0];
    len[only] = 1;
    len[only === 0 ? 1 : 0] = 1;
    return len;
  }
  const f = new Float64Array(n * 2);
  for (const s of syms) f[s] = freq[s];
  const parent = new Int32Array(n * 2).fill(-1);
  const left = new Int32Array(n * 2).fill(-1);
  let heap = syms.slice();
  heap.sort((a, b) => f[a] - f[b] || a - b);
  let next = n;
  while (heap.length > 1) {
    const a = heap.shift();
    const b = heap.shift();
    f[next] = f[a] + f[b];
    left[next] = a;
    parent[a] = next; parent[b] = next;
    let pos = 0;
    while (pos < heap.length && (f[heap[pos]] < f[next] || (f[heap[pos]] === f[next] && heap[pos] < next))) pos++;
    heap.splice(pos, 0, next);
    next++;
  }
  const root = heap[0];
  const depth = new Int32Array(n * 2);
  for (const s of syms) {
    let d = 0, p = s;
    while (parent[p] !== -1) { p = parent[p]; d++; }
    depth[s] = d;
    len[s] = d;
  }
  let maxDepth = 0;
  for (const s of syms) if (depth[s] > maxDepth) maxDepth = depth[s];
  if (maxDepth <= maxBits) return len;
  // Length-limit the tree (collapse-and-split, Kraft-preserving):
  // collapse each sibling pair deeper than maxBits into its parent, then
  // split shallow leaves until the symbol count is restored. The result is
  // a complete prefix code with every length in [1, maxBits].
  const blCount = new Int32Array(maxDepth + 2);
  for (const s of syms) blCount[depth[s]]++;
  let pairs = 0;
  for (let m = maxDepth; m > maxBits; m--) {
    const p = blCount[m] / 2;
    blCount[m] = 0;
    blCount[m - 1] += p;
    pairs += p;
  }
  for (let k = 0; k < pairs; k++) {
    let d = 1;
    while (d < maxBits && blCount[d] === 0) d++;
    if (d >= maxBits) break; // unreachable while count < 2^maxBits
    blCount[d]--;
    blCount[d + 1] += 2;
  }
  // Assign the shortest lengths to the most frequent symbols.
  const byFreq = syms.slice().sort((a, b) => freq[b] - freq[a] || a - b);
  len.fill(0);
  let idx = 0;
  for (let d = 1; d <= maxBits; d++) {
    for (let c = 0; c < blCount[d]; c++) len[byFreq[idx++]] = d;
  }
  return len;
}

function canonicalCodes(len) {
  const n = len.length;
  const blCount = new Int32Array(16);
  for (let i = 0; i < n; i++) if (len[i] > 0) blCount[len[i]]++;
  const nextCode = new Int32Array(16);
  let code = 0;
  for (let bits = 1; bits < 16; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }
  const codes = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (len[i] > 0) codes[i] = nextCode[len[i]]++;
  }
  return codes;
}
function reverseBits(code, len) {
  let r = 0;
  for (let i = 0; i < len; i++) { r = (r << 1) | (code & 1); code >>>= 1; }
  return r;
}

function lenSymbol(length) {
  if (length === 258) return 285;
  let lo = 0, hi = 28;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (LEN_BASE[mid] <= length) lo = mid; else hi = mid - 1;
  }
  return 257 + lo;
}
function distSymbol(dist) {
  let lo = 0, hi = 29;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (DIST_BASE[mid] <= dist) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// LZ77 parse with lazy matching. Tokens: parallel arrays kind (0 lit, 1 match),
// value (literal byte, or length), dist. Also tokStart[i] = input offset.
// With `costs` ({lit, len, dist} bit-cost tables from a first pass), matches
// are picked by bit cost instead of length, and the lazy step compares the
// cost per covered byte.
function lz77Parse(data, costs) {
  const n = data.length;
  const kind = [];
  const value = [];
  const dist = [];
  const tokStart = [];
  const HASH_BITS = 15;
  const HASH_SIZE = 1 << HASH_BITS;
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  const hashAt = (i) => (((data[i] * 256 + data[i + 1]) * 256 + data[i + 2]) * 2654435761 >>> 0) >>> (32 - HASH_BITS);
  const insert = (i) => {
    if (i + 2 >= n) return;
    const h = hashAt(i);
    if (head[h] === i) return; // already inserted (lazy step may have done it)
    prev[i] = head[h];
    head[h] = i;
  };
  const matchCost = (l, d) => costs.len[l] + costs.dist[d];
  const findMatch = (i) => {
    let bestLen = 2, bestDist = 0, bestCost = Infinity;
    if (i + 2 >= n) return [bestLen, bestDist, bestCost];
    let cand = prev[i]; // never the position itself (it was just inserted)
    let chain = CHAIN_LIMIT;
    const maxLen = Math.min(258, n - i);
    const minDist = i - 32768;
    while (cand !== -1 && chain-- > 0) {
      if (cand < minDist) break;
      if (data[cand + bestLen] === data[i + bestLen] && data[cand] === data[i]) {
        let l = 0;
        while (l < maxLen && data[cand + l] === data[i + l]) l++;
        if (l > bestLen) {
          const d = i - cand;
          if (costs) {
            // Pick by cost per covered byte (cross-multiplied, exact).
            const c = matchCost(l, d);
            if (c * bestLen < bestCost * l || (c * bestLen === bestCost * l && l > bestLen)) {
              bestLen = l; bestDist = d; bestCost = c;
            }
          } else {
            bestLen = l; bestDist = d;
          }
          if (l >= 32) chain = Math.min(chain, CHAIN_LIMIT >> 2);
          if (l === maxLen) break;
        }
      }
      cand = prev[cand];
    }
    return [bestLen, bestDist, bestCost];
  };
  let i = 0;
  insert(0);
  while (i < n) {
    if (i + 2 >= n) {
      tokStart.push(i); kind.push(0); value.push(data[i]); dist.push(0);
      i++;
      continue;
    }
    const [len1, d1, cost1] = findMatch(i);
    if (len1 < 3 || (!costs && len1 === 3 && d1 > 4096)) {
      tokStart.push(i); kind.push(0); value.push(data[i]); dist.push(0);
      i++;
      insert(i);
      continue;
    }
    // Lazy: is the match at i+1 better?
    insert(i + 1);
    const [len2, , cost2] = findMatch(i + 1);
    let takeMatch = true;
    if (costs) {
      // Compare cost per covered byte: match at i vs literal + best at i+1.
      const altLen = 1 + (len2 >= 3 ? len2 : 1);
      const altCost = costs.lit[data[i]] + (len2 >= 3 ? cost2 : costs.lit[data[i + 1]]);
      if (cost1 * altLen > altCost * len1) takeMatch = false;
    } else if (len2 > len1) {
      takeMatch = false;
    }
    if (!takeMatch) {
      tokStart.push(i); kind.push(0); value.push(data[i]); dist.push(0);
      i++;
      continue;
    }
    tokStart.push(i); kind.push(1); value.push(len1); dist.push(d1);
    const end = i + len1;
    for (let j = i + 1; j < end; j++) insert(j);
    i = end;
    insert(i);
  }
  return { kind, value, dist, tokStart };
}

// Token frequencies of a parse, for Huffman cost tables.
function tokenFreqs(toks) {
  const litFreq = new Uint32Array(288);
  const distFreq = new Uint32Array(30);
  for (let t = 0; t < toks.kind.length; t++) {
    if (toks.kind[t] === 0) litFreq[toks.value[t]]++;
    else {
      litFreq[lenSymbol(toks.value[t])]++;
      distFreq[distSymbol(toks.dist[t])]++;
    }
  }
  litFreq[256]++;
  return { litFreq, distFreq };
}

function emitDynamicBlock(bw, isLast, toks, startIdx, endIdx, startByte, endByte) {
  const litFreq = new Uint32Array(288);
  const distFreq = new Uint32Array(30);
  for (let t = startIdx; t < endIdx; t++) {
    if (toks.kind[t] === 0) litFreq[toks.value[t]]++;
    else {
      litFreq[lenSymbol(toks.value[t])]++;
      distFreq[distSymbol(toks.dist[t])]++;
    }
  }
  litFreq[256]++;
  let hlit = 286;
  while (hlit > 257 && litFreq[hlit] === 0) hlit--;
  let hdist = 29;
  while (hdist > 0 && distFreq[hdist] === 0) hdist--;
  const litLen = buildLengths(litFreq, 15);
  const distLen = buildLengths(distFreq, 15);
  // RLE-encode the combined code lengths.
  const all = [];
  for (let i = 0; i <= hlit; i++) all.push(litLen[i]);
  for (let i = 0; i <= hdist; i++) all.push(distLen[i]);
  const clItems = []; // [symbol, extraValue, extraBits]
  let k = 0;
  while (k < all.length) {
    const v = all[k];
    let run = 1;
    while (k + run < all.length && all[k + run] === v) run++;
    if (v === 0) {
      let r = run;
      while (r >= 11) { const take = Math.min(r, 138); clItems.push([18, take - 11, 7]); r -= take; }
      while (r >= 3) { const take = Math.min(r, 10); clItems.push([17, take - 3, 3]); r -= take; }
      while (r > 0) { clItems.push([0, 0, 0]); r--; }
    } else {
      clItems.push([v, 0, 0]);
      let r = run - 1;
      while (r >= 3) { const take = Math.min(r, 6); clItems.push([16, take - 3, 2]); r -= take; }
      while (r > 0) { clItems.push([v, 0, 0]); r--; }
    }
    k += run;
  }
  const clFreq = new Uint32Array(19);
  for (const [s] of clItems) clFreq[s]++;
  const clLen = buildLengths(clFreq, 7);
  let hclen = 18;
  while (hclen > 3 && clLen[CL_ORDER[hclen]] === 0) hclen--;
  const clCode = canonicalCodes(clLen);
  const litCode = canonicalCodes(litLen);
  const distCode = canonicalCodes(distLen);
  bw.write(isLast ? 1 : 0, 1);
  bw.write(2, 2); // dynamic Huffman
  bw.write(hlit - 256, 5); // HLIT = codes - 257, codes = hlit + 1
  bw.write(hdist, 5); // HDIST = codes - 1, codes = hdist + 1
  bw.write(hclen - 3, 4); // HCLEN = codes - 4, codes = hclen + 1
  for (let i = 0; i <= hclen; i++) bw.write(clLen[CL_ORDER[i]], 3);
  for (const [s, ev, eb] of clItems) {
    bw.write(reverseBits(clCode[s], clLen[s]), clLen[s]);
    if (eb > 0) bw.write(ev, eb);
  }
  for (let t = startIdx; t < endIdx; t++) {
    if (toks.kind[t] === 0) {
      const s = toks.value[t];
      bw.write(reverseBits(litCode[s], litLen[s]), litLen[s]);
    } else {
      const length = toks.value[t];
      const ls = lenSymbol(length);
      bw.write(reverseBits(litCode[ls], litLen[ls]), litLen[ls]);
      const le = LEN_EXT[ls - 257];
      if (le > 0) bw.write(length - LEN_BASE[ls - 257], le);
      const ds = distSymbol(toks.dist[t]);
      bw.write(reverseBits(distCode[ds], distLen[ds]), distLen[ds]);
      const de = DIST_EXT[ds];
      if (de > 0) bw.write(toks.dist[t] - DIST_BASE[ds], de);
    }
  }
  bw.write(reverseBits(litCode[256], litLen[256]), litLen[256]);
}

function myDeflate(raw) {
  // Pass 1: length-based lazy parse, to build Huffman cost tables.
  // Pass 2: one cost-based lazy parse with those tables.
  let toks = lz77Parse(raw, null);
  {
    const { litFreq, distFreq } = tokenFreqs(toks);
    const litLen = buildLengths(litFreq, 15);
    const distLen = buildLengths(distFreq, 15);
    const costs = { lit: litLen, len: new Int32Array(259), dist: new Int32Array(32769) };
    for (let l = 3; l <= 258; l++) {
      const s = lenSymbol(l);
      costs.len[l] = litLen[s] + LEN_EXT[s - 257];
    }
    for (let d = 1; d <= 32768; d++) {
      const s = distSymbol(d);
      costs.dist[d] = distLen[s] + DIST_EXT[s];
    }
    toks = lz77Parse(raw, costs);
  }
  const bw = new BitWriter();
  const total = toks.kind.length;
  let startIdx = 0;
  let startByte = 0;
  while (startIdx < total) {
    // Find the token index where consumed input reaches startByte + BLOCK_BYTES.
    let endIdx = startIdx;
    while (endIdx < total && toks.tokStart[endIdx] < startByte + BLOCK_BYTES) endIdx++;
    if (endIdx === startIdx) endIdx = Math.min(total, startIdx + 1);
    const isLast = endIdx >= total;
    const endByte = isLast ? raw.length : toks.tokStart[endIdx];
    emitDynamicBlock(bw, isLast, toks, startIdx, endIdx, startByte, endByte);
    startByte = endByte;
    startIdx = endIdx;
  }
  if (total === 0) {
    // Empty input: a single final empty dynamic block.
    const bw2 = new BitWriter();
    bw2.write(1, 1); bw2.write(2, 2);
    bw2.write(0, 5); bw2.write(0, 5); bw2.write(0, 4);
    for (let i = 0; i < 4; i++) bw2.write(0, 3);
    // one code-length code of length 1 for symbol 0... simplified: emit fixed empty block instead
    const bw3 = new BitWriter();
    bw3.write(1, 1); bw3.write(1, 2); // BFINAL=1, BTYPE=01 fixed
    bw3.write(0, 7); // end-of-block 256 in fixed Huffman = 0000000 (7 bits, value 0)
    return bw3.finish();
  }
  return bw.finish();
}

// ---------- Per-image pipeline ----------
function compressImage(rgba, width, height, id) {
  const rep = analyse(rgba, width, height);
  // Try several whole-image filter strategies: per-row adaptive filtering
  // can break the cross-row matches LZ77 relies on, so a fixed filter (or
  // none) often wins. Rank candidates with zlib level 6, then pick the best
  // strategy per horizontal band (different regions prefer different
  // filters), and compress the winner with the from-scratch DEFLATE encoder
  // and zlib level 9.
  const raws = [];
  for (const strategy of STRATEGIES) {
    raws.push(filterImage(rep.samples, width, height, rep.bpp, strategy));
  }
  const stride = width * rep.bpp;
  const rowBytes = stride + 1;
  const BAND_ROWS = 90;
  const raw = new Uint8Array(height * rowBytes);
  for (let b0 = 0; b0 < height; b0 += BAND_ROWS) {
    const b1 = Math.min(height, b0 + BAND_ROWS);
    let bestIdx = 0;
    let bestSize = Infinity;
    for (let s = 0; s < raws.length; s++) {
      const seg = raws[s].subarray(b0 * rowBytes, b1 * rowBytes);
      const size = deflateSync(seg, { level: 6 }).length;
      if (size < bestSize) { bestSize = size; bestIdx = s; }
    }
    raw.set(raws[bestIdx].subarray(b0 * rowBytes, b1 * rowBytes), b0 * rowBytes);
  }
  const mine = zlibWrap(myDeflate(raw), raw);
  const z9 = deflateSync(raw, { level: 9 });
  const z9f = deflateSync(raw, { level: 9, strategy: 1 }); // Z_FILTERED
  const z9m = deflateSync(raw, { level: 9, memLevel: 9 });
  let idat = mine;
  if (z9.length < idat.length) idat = z9;
  if (z9f.length < idat.length) idat = z9f;
  if (z9m.length < idat.length) idat = z9m;
  return encodePng(width, height, rep.colourType, rep.palette, rep.trns, idat);
}

function main() {
  const inputDir = process.env.MAKEFUN_INPUT_DIR || '/input';
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';
  for (const id of IDS) {
    const buf = readFileSync(`${inputDir}/${id}/image.png`);
    const { width, height, rgba } = decodePng(buf);
    const png = compressImage(rgba, width, height, id);
    mkdirSync(`${outputDir}/${id}`, { recursive: true });
    writeFileSync(`${outputDir}/${id}/image.png`, png);
  }
}

main();
