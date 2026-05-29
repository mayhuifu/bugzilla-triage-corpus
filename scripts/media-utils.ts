// ─────────────────────────────────────────────────────────────────
// media-utils.ts — figure-image extraction support for Phase 1.
//
// 3GPP DOCX files embed figures as inline WMF/EMF (vector) or
// PNG/JPEG (raster) in `word/media/`. The v2 pipeline dropped them
// entirely — only the "Figure N: caption" paragraph survived. Phase 1
// captures them: WMF/EMF get converted to SVG via libreoffice (sharp
// at any zoom, ~12 KB each), PNG/JPEG pass through.
//
// Outputs live under `dist/media/<spec>/<mediaId>.<ext>` and get
// blob-ingested into the `figure_images` table by 03-index.ts.
// ─────────────────────────────────────────────────────────────────

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";

/** MIME content-type → file extension. Mammoth's `image.contentType`
 *  uses the formal x-vendor prefix for legacy formats; we want the
 *  bare extension for the on-disk filename. Unknown types fall back
 *  to `.bin` and skip the converter. */
export function mimeToExt(contentType: string): string {
  const ct = contentType.toLowerCase().trim();
  if (ct === "image/png") return "png";
  if (ct === "image/jpeg" || ct === "image/jpg") return "jpeg";
  if (ct === "image/gif") return "gif";
  if (ct === "image/webp") return "webp";
  if (ct === "image/svg+xml") return "svg";
  if (ct === "image/x-wmf" || ct === "image/wmf") return "wmf";
  if (ct === "image/x-emf" || ct === "image/emf") return "emf";
  return "bin";
}

/** Reverse — file extension to canonical MIME stored in the `figure_images`
 *  table. SVG is what WMF/EMF become post-conversion; the desktop only
 *  ever sees SVG (not WMF/EMF directly), so the table never carries
 *  the vendor-prefix forms. */
export function extToMime(ext: string): string {
  switch (ext.toLowerCase()) {
    case "png": return "image/png";
    case "jpeg": case "jpg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "svg": return "image/svg+xml";
    default: return "application/octet-stream";
  }
}

/** Run `soffice --headless --convert-to svg` on every WMF/EMF in `dir`,
 *  writing SVGs into the same dir. The original WMF/EMF files are
 *  removed after a successful conversion to keep `dist/media/` tidy
 *  and reflect the fact that the desktop only consumes the SVGs.
 *
 *  Batches all inputs into a single `soffice` invocation so the JVM
 *  startup cost is paid once per spec, not once per figure (a 627-
 *  figure spec drops from minutes to ~30 seconds).
 *
 *  Returns `{ converted, failed }` counts so the parse report can
 *  surface conversion warnings without aborting the whole build. */
export async function convertVectorMedia(
  dir: string,
  options: { sofficeBin?: string } = {},
): Promise<{ converted: number; failed: number; errors: string[] }> {
  const soffice = options.sofficeBin ?? "soffice";
  const entries = await fs.readdir(dir);
  const vectors = entries.filter(f => /\.(wmf|emf)$/i.test(f));
  if (vectors.length === 0) return { converted: 0, failed: 0, errors: [] };

  const absPaths = vectors.map(f => path.join(dir, f));
  const errors: string[] = [];

  // Hand the batch to libreoffice. The CLI accepts multiple input
  // paths and writes one .svg per input into --outdir. We pipe stderr
  // straight through so any conversion warning lands in the parse
  // log; stdout is silent on success.
  const result = await new Promise<number>((resolve) => {
    const child = spawn(
      soffice,
      ["--headless", "--convert-to", "svg", "--outdir", dir, ...absPaths],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const stderrBuf: Buffer[] = [];
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", c => stderrBuf.push(c));
    child.on("error", () => resolve(-1));
    child.on("close", code => {
      const err = Buffer.concat(stderrBuf).toString("utf8").trim();
      if (err) errors.push(err);
      resolve(code ?? -1);
    });
  });

  if (result !== 0) {
    return {
      converted: 0,
      failed: vectors.length,
      errors: [`soffice exited ${result}`, ...errors],
    };
  }

  // Count successes: an SVG with the same stem as the input is the
  // success signal. If libreoffice couldn't handle a file it skips
  // it silently — these become `failed` entries.
  let converted = 0;
  let failed = 0;
  for (const vec of vectors) {
    const stem = path.basename(vec, path.extname(vec));
    const svgPath = path.join(dir, `${stem}.svg`);
    try {
      await fs.stat(svgPath);
      converted++;
      // Remove the source vector — desktop only ships the SVG.
      await fs.unlink(path.join(dir, vec));
    } catch {
      failed++;
    }
  }
  return { converted, failed, errors };
}

/** Strip src/href references that pdfjs / mammoth sometimes serializes
 *  with embedded font URLs pointing at local libreoffice paths. The
 *  desktop renders these SVGs in-browser, so any `file://` reference
 *  would fail silently and break the figure. Most 3GPP figures don't
 *  hit this — but the few that embed bold callouts via system fonts
 *  do, and the cleanup is cheap. */
export async function sanitizeSvg(svgPath: string): Promise<void> {
  try {
    let xml = await fs.readFile(svgPath, "utf8");
    const original = xml;
    // Remove `file://` or absolute path URL references inside style/href.
    xml = xml.replace(/url\(['"]?file:\/\/[^'"\)]+['"]?\)/g, "url(#none)");
    xml = xml.replace(/href=['"]file:\/\/[^'"]+['"]/g, 'href=""');
    if (xml !== original) {
      await fs.writeFile(svgPath, xml, "utf8");
    }
  } catch {
    // best-effort — leave the SVG untouched if anything goes wrong
  }
}
