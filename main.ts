import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type RGB = readonly [number, number, number];

const W = 1024;
const H = 1024;

const FONT_SOURCE: Record<string, string> = {
  " ": "0000000000", "!": "00005F0000", '"': "0000070007", "#": "147F147F14",
  $: "242A7F2A12", "%": "2313086462", "&": "3649552250", "'": "0005030000",
  "(": "001C224100", ")": "0041221C00", "*": "14083E0814", "+": "08083E0808",
  ",": "0050300000", "-": "0808080808", ".": "0060600000", "/": "2010080402",
  "0": "3E5149453E", "1": "00427F4000", "2": "4261514946", "3": "2141454B31",
  "4": "1814127F10", "5": "2745454539", "6": "3C4A494930", "7": "0171090503",
  "8": "3649494936", "9": "064949291E", ":": "0036360000", ";": "0056360000",
  "<": "0814224100", "=": "1414141414", ">": "0041221408", "?": "0201510906",
  "@": "327941413E", A: "7E1111117E", B: "7F49494936", C: "3E41414122",
  D: "7F4141221C", E: "7F49494941", F: "7F09090901", G: "3E4149497A",
  H: "7F0808087F", I: "00417F4100", J: "2040413F01", K: "7F08142241",
  L: "7F40404040", M: "7F020C027F", N: "7F0408107F", O: "3E4141413E",
  P: "7F09090906", Q: "3E4151215E", R: "7F09192946", S: "4649494931",
  T: "01017F0101", U: "3F4040403F", V: "1F2040201F", W: "3F4038403F",
  X: "6314081463", Y: "0708700807", Z: "6151494543", "[": "007F414100",
  "\\": "0204081020", "]": "0041417F00", "^": "0402010204", _: "4040404040",
  "`": "0001020400", a: "2054545478", b: "7F48444438", c: "3844444420",
  d: "384444487F", e: "3854545418", f: "087E090102", g: "0C5252523E",
  h: "7F08040478", i: "00447D4000", j: "2040443D00", k: "7F10284400",
  l: "00417F4000", m: "7C04180478", n: "7C08040478", o: "3844444438",
  p: "7C14141408", q: "081414187C", r: "7C08040408", s: "4854545420",
  t: "043F444020", u: "3C4040207C", v: "1C2040201C", w: "3C4030403C",
  x: "4428102844", y: "0C5050503C", z: "4464544C44", "{": "0008364100",
  "|": "00007F0000", "}": "0041360800", "~": "08082A1C08",
};

const FONT: Map<string, number[]> = new Map();
for (const [ch, hex] of Object.entries(FONT_SOURCE)) {
  FONT.set(ch, [0, 2, 4, 6, 8].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)));
}

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const tag = Buffer.from(type, "ascii");
  const body = Buffer.from(data);
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  tag.copy(out, 4);
  body.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([tag, body])), 8 + body.length);
  return out;
}

function encodePNG(pixels: Uint8Array, width: number, height: number): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 3;
      const dst = row + 1 + x * 3;
      raw[dst] = pixels[src];
      raw[dst + 1] = pixels[src + 1];
      raw[dst + 2] = pixels[src + 2];
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}

function hex(value: string): RGB {
  return [
    parseInt(value.slice(1, 3), 16),
    parseInt(value.slice(3, 5), 16),
    parseInt(value.slice(5, 7), 16),
  ];
}

class Canvas {
  pixels = new Uint8Array(W * H * 3);

  pixel(x: number, y: number, color: RGB): void {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const at = (y * W + x) * 3;
    this.pixels[at] = color[0];
    this.pixels[at + 1] = color[1];
    this.pixels[at + 2] = color[2];
  }

  rect(x: number, y: number, w: number, h: number, color: RGB): void {
    for (let row = y; row < y + h; row++) {
      for (let col = x; col < x + w; col++) this.pixel(col, row, color);
    }
  }

  measure(text: string, scale: number): number {
    return text.length === 0 ? 0 : (text.length * 6 - 1) * scale;
  }

  wrap(text: string, maxChars: number): string[] {
    const lines: string[] = [];
    let line = "";
    for (const word of this.sanitize(text).split(/\s+/).filter(Boolean)) {
      if (word.length > maxChars) {
        if (line) lines.push(line);
        line = "";
        for (let i = 0; i < word.length; i += maxChars) lines.push(word.slice(i, i + maxChars));
        continue;
      }
      if (line.length === 0) line = word;
      else if (line.length + 1 + word.length <= maxChars) line += " " + word;
      else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  sanitize(text: string): string {
    return text
      .replace(/[\u2014\u2013]/g, "-")
      .replace(/[\u00b7\u2022]/g, "-")
      .replace(/[^\x20-\x7e]/g, "?");
  }

  text(text: string, x: number, y: number, scale: number, color: RGB): number {
    const clean = this.sanitize(text);
    let cursor = x;
    for (const ch of clean) {
      const glyph = FONT.get(ch) ?? FONT.get("?");
      if (glyph) {
        for (let col = 0; col < 5; col++) {
          for (let row = 0; row < 7; row++) {
            if ((glyph[col] >> row) & 1) {
              this.rect(cursor + col * scale, y + row * scale, scale, scale, color);
            }
          }
        }
      }
      cursor += 6 * scale;
    }
    return clean.length === 0 ? 0 : cursor - x - scale;
  }
}

const canvas = new Canvas();
const BG = hex("#0B1026");
const GRID = hex("#141A38");
const RED = hex("#C0392B");
const WHITE = hex("#FFFFFF");
const GREY = hex("#9AA3C0");
const CARD = hex("#101736");
const BORDER = hex("#1D2647");

canvas.rect(0, 0, W, H, BG);
for (let p = 0; p < W; p += 64) canvas.rect(p, 0, 1, H, GRID);
for (let p = 0; p < H; p += 64) canvas.rect(0, p, W, 1, GRID);

canvas.rect(0, 0, W, 90, RED);
const title = "WORLD NEWS - 23 NOV 2026";
canvas.text(title, Math.round((W - canvas.measure(title, 7)) / 2), 6, 7, WHITE);
const sources = "sources: reuters/guardian/anadolu";
canvas.text(sources, W - 24 - canvas.measure(sources, 2), 68, 2, WHITE);

const stories: { bar: string; headline: string; summary: string }[] = [
  {
    bar: "#2ECC71",
    headline: "COP31 COLLAPSES WITH NO DEAL",
    summary: "First UN climate talks to fail since 2009. Fossil-fuel phase-out cut from text; Pacific nations despair.",
  },
  {
    bar: "#E67E22",
    headline: "UKRAINIAN SEA DRONES SINK RUSSIAN CORVETTE",
    summary: "The Merkury went down at Benghazi, Libya. Kyiv: seven naval drones used; UN calls for inquiry.",
  },
  {
    bar: "#E74C3C",
    headline: "24 KILLED IN INDONESIA FACTORY FIRE",
    summary: "Candy factory blaze in Banten; about 30 missing as rescuers search the wreckage.",
  },
  {
    bar: "#3498DB",
    headline: "DEMOCRATS WIN 258 HOUSE SEATS",
    summary: "Largest US House majority since 1992 after midterms.",
  },
];

const cardX = 40;
const cardW = 944;
const cardH = 190;
const cardGap = 20;
const textX = cardX + 28;
const textW = cardW - 28 - 18;

stories.forEach((story, i) => {
  const y = 140 + i * (cardH + cardGap);
  canvas.rect(cardX, y, cardW, cardH, CARD);
  canvas.rect(cardX, y, cardW, 1, BORDER);
  canvas.rect(cardX, y + cardH - 1, cardW, 1, BORDER);
  canvas.rect(cardX, y, 10, cardH, hex(story.bar));

  const headlineScale = 4;
  const summaryScale = 3;
  const headlineLines = canvas.wrap(story.headline, Math.floor(textW / (6 * headlineScale)));
  const summaryLines = canvas.wrap(story.summary, Math.floor(textW / (6 * summaryScale)));

  headlineLines.forEach((line, row) => {
    canvas.text(line, textX, y + 14 + row * (7 * headlineScale + 6), headlineScale, WHITE);
  });
  const summaryY = y + 14 + headlineLines.length * (7 * headlineScale + 6) + 8;
  summaryLines.forEach((line, row) => {
    canvas.text(line, textX, summaryY + row * (7 * summaryScale + 5), summaryScale, GREY);
  });
});

canvas.rect(40, 972, 944, 1, BORDER);
const footer = "#WORLDNEWS - MADE BY AN AI AGENT - 23 NOV 2026";
canvas.text(footer, Math.round((W - canvas.measure(footer, 2)) / 2), 988, 2, GREY);

const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "entry.png"), encodePNG(canvas.pixels, W, H));
