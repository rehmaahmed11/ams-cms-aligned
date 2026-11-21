/**
 * Reading and validating a plugin package (.zip).
 *
 * A plugin package is the smallest thing the CMS can carry: a manifest
 * (plugin.json) plus one code file. The code is raw HTML/JS injected into its
 * hook on every public page — exactly like a snippet — so it is capped and
 * validated the same way and kept strict: anything inside the zip that is not
 * the manifest and the one declared code file is rejected, because a plugin
 * never smuggles assets in and the panel only runs code its owner trusts.
 */
import { unzip } from './zip';
import { slugify } from './security';
import { isHookPoint } from './plugins';

export class PluginPackageError extends Error {}

const MAX_ZIP_BYTES = 2 * 1024 * 1024;
const MAX_CODE_CHARS = 20_000;
const MAX_DESCRIPTION = 300;
const MAX_NAME = 120;
const VERSION = /^v?[0-9][0-9A-Za-z.+-]{0,29}$/;
const SLUG = /^[a-z][a-z0-9-]{1,40}$/;

export type PluginUpload = {
  name: string;
  slug: string;
  version: string;
  description: string;
  hook: 'head' | 'footer';
  code: string;
};

/** Reads a raw upload into a validated plugin package. */
export async function readPluginUpload(buf: ArrayBuffer): Promise<PluginUpload> {
  if (buf.byteLength > MAX_ZIP_BYTES) {
    throw new PluginPackageError(`The file is too large (limit ${Math.round(MAX_ZIP_BYTES / 1048576)} MB).`);
  }
  const head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
  if (!(head.length === 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04)) {
    throw new PluginPackageError('A plugin is a .zip file containing plugin.json and one code file — not a plain file.');
  }
  let files: Map<string, Uint8Array>;
  try {
    files = await unzip(buf, {
      maxEntries: 16,
      maxTotalBytes: 512 * 1024,
      maxCompressedBytes: MAX_ZIP_BYTES,
      maxCompressionRatio: 200,
    });
  } catch (err) {
    throw new PluginPackageError(err instanceof Error ? err.message : 'Could not read the zip file.');
  }

  // The manifest sits at the zip root or any one level down, like a theme.
  const manifestPath = [...files.keys()]
    .filter((p) => p === 'plugin.json' || p.endsWith('/plugin.json'))
    .sort((a, b) => a.length - b.length)[0];
  if (!manifestPath) throw new PluginPackageError('The zip file does not contain a plugin.json.');
  const dir = manifestPath.slice(0, manifestPath.length - 'plugin.json'.length);

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(new TextDecoder().decode(files.get(manifestPath)!).replace(/^\uFEFF/, '')) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
  } catch {
    throw new PluginPackageError('plugin.json is not valid JSON.');
  }

  const name = String(raw.name ?? '').trim();
  if (name.length < 4 || name.length > MAX_NAME) {
    throw new PluginPackageError('plugin.json needs a "name" of 4–120 characters.');
  }

  const hook = String(raw.hook ?? '').trim().toLowerCase();
  if (!isHookPoint(hook)) {
    throw new PluginPackageError('plugin.json needs a "hook" of "head" or "footer".');
  }

  // Slug: explicit (and safe), or derived from the name.
  let slug = String(raw.slug ?? '').trim().toLowerCase();
  if (slug && !SLUG.test(slug)) {
    throw new PluginPackageError('"slug" must be 2–40 lowercase letters, digits or dashes (e.g. "my-analytics").');
  }
  if (!slug) slug = slugify(name);
  if (!slug) throw new PluginPackageError('Could not derive a slug from the name. Give the plugin an explicit "slug".');

  const versionRaw = String(raw.version ?? '').trim();
  const version = versionRaw || '1.0.0';
  if (!VERSION.test(version)) {
    throw new PluginPackageError('"version" must look like 1.2.3 or v1.2.3 (digits, letters, dots, dashes, plus).');
  }

  const description = String(raw.description ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_DESCRIPTION);

  // The one code file: a strict, safe relative path, resolved against the manifest folder.
  const fileRef = String(raw.file ?? 'plugin.html').trim().replace(/\\/g, '/');
  if (!fileRef || fileRef.length > 120 || fileRef.startsWith('/') || /^[a-z]:/i.test(fileRef) || fileRef.split('/').some((p) => !p || p === '.' || p === '..')) {
    throw new PluginPackageError('"file" must be a safe relative path (no absolute paths, no "..").');
  }
  const filePath = dir + fileRef;
  const codeData = files.get(filePath);
  if (!codeData) throw new PluginPackageError(`plugin.json names "${fileRef}" but that file is not in the zip.`);

  let code: string;
  try {
    code = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(codeData);
  } catch {
    throw new PluginPackageError(`"${fileRef}" is not valid UTF-8 text.`);
  }
  code = code.trim();
  if (!code) throw new PluginPackageError(`"${fileRef}" is empty.`);
  if (code.length > MAX_CODE_CHARS) {
    throw new PluginPackageError(`"${fileRef}" is too large (limit ${MAX_CODE_CHARS.toLocaleString()} characters).`);
  }

  // Everything in the zip must be the manifest or the one code file. No assets, no extras.
  const allowed = new Set([manifestPath.toLowerCase(), filePath.toLowerCase()]);
  const extra = [...files.keys()].filter((p) => !allowed.has(p.toLowerCase()));
  if (extra.length) {
    throw new PluginPackageError(`The zip contains unexpected file${extra.length === 1 ? '' : 's'} (${extra.join(', ')}). A plugin may only carry plugin.json and one code file.`);
  }

  return { name, slug, version, description, hook, code };
}
