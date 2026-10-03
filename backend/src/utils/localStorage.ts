// Local filesystem storage for uploaded images/videos, replacing Cloudflare R2.
// Files are never trusted by client-supplied name or path: every saved filename is server-generated,
// and every path derived from a stored key is re-validated to resolve inside UPLOAD_ROOT before any
// filesystem operation, so a crafted key (e.g. containing "..") can never escape the uploads directory.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { Request } from 'express';
import config from '../config';

export const UPLOAD_ROOT = path.resolve(__dirname, '..', '..', 'uploads');

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};

/** Extension derived only from the validated MIME type — never from the client-supplied original filename. */
export function extFromMime(mimetype: string): string {
  return EXT_BY_MIME[mimetype] || 'bin';
}

/** Keeps only characters safe inside a path segment (used for subdirectory names derived from request data). */
export function safeSegment(value: unknown, fallback = 'misc'): string {
  const cleaned = String(value ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  return cleaned || fallback;
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Resolves a relative upload path and throws if it would escape UPLOAD_ROOT (defence in depth). */
function resolveWithinRoot(relPath: string): string {
  const full = path.resolve(UPLOAD_ROOT, relPath);
  if (full !== UPLOAD_ROOT && !full.startsWith(UPLOAD_ROOT + path.sep)) {
    throw new Error('Resolved path escapes the uploads directory');
  }
  return full;
}

/**
 * Saves a buffer under uploads/<...subdirParts>/<generated-name>.<ext-from-mime> and returns the
 * relative path (DB/URL-safe, forward-slash separated) plus the generated filename.
 */
export function saveBuffer(
  buffer: Buffer,
  mimetype: string,
  subdirParts: string[]
): { relPath: string; fileName: string } {
  const subdir = subdirParts.map((p) => safeSegment(p)).join('/');
  const dirFull = resolveWithinRoot(subdir);
  ensureDir(dirFull);

  const fileName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${extFromMime(mimetype)}`;
  const relPath = subdir ? `${subdir}/${fileName}` : fileName;
  const fullPath = resolveWithinRoot(relPath);

  fs.writeFileSync(fullPath, buffer);
  return { relPath, fileName };
}

/** Builds the absolute public URL for a stored relative path. */
export function publicUrlFor(req: Request, relPath: string): string {
  const base = config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
  return `${base}/uploads/${relPath}`;
}

/** Deletes a file by its relative path. Silently no-ops if it doesn't exist. Never throws on a missing file. */
export function deleteFile(relPath: string): void {
  const fullPath = resolveWithinRoot(relPath);
  try {
    fs.unlinkSync(fullPath);
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

/** Lists files under an optional relative prefix, mirroring the old R2 list-files response shape. */
export function listFiles(req: Request, prefix = ''): Array<{ key: string; size: number; lastModified: Date; url: string }> {
  const startDir = resolveWithinRoot(prefix || '.');
  const results: Array<{ key: string; size: number; lastModified: Date; url: string }> = [];

  function walk(dir: string): void {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else {
        const relPath = path.relative(UPLOAD_ROOT, fullPath).split(path.sep).join('/');
        const stat = fs.statSync(fullPath);
        results.push({ key: relPath, size: stat.size, lastModified: stat.mtime, url: publicUrlFor(req, relPath) });
      }
    }
  }
  walk(startDir);
  return results.slice(0, 500);
}

/** Extracts the relative uploads path from a previously-issued public URL, or null if it isn't one of ours. */
export function relPathFromUrl(url: string): string | null {
  const marker = '/uploads/';
  const idx = url.indexOf(marker);
  if (idx === -1) return null;
  return url.slice(idx + marker.length).split(/[?#]/)[0];
}
