// B15 (the proto line's C-10, 968d5605; F-FigmaMobile-09, F-FitBody-09/17/32/47/56, F-FigmaReactive-01, F-AiChatbot-01,
// F-Jesse-07, F-FT-01: no way to bring an image file into the module; ~90 agent-minutes, 4 subagents and 394 calls choosing
// stock photos, while the kernel's create IImage takes the bytes as base64 since 2026-09, tests/jobs-odc/image-create.json).
// An image file among the files of ssam_code write (and check) is a module image: `create IImage {name, args: {binary,
// originalPath}}`, named after the file; an image of that name the module already has takes the new content (the kernel's
// create of an IImage is SetImageContent then, never a second image, and only for the grant of this file: image-fill-grants.mjs).
// <img src="logo.png"> of a screen then names it.
//
// Where the bytes come from: only a file ssam_code reads anyway. On the person's machine, their own file. On a hosted server the
// gate confines every path of files to the customer's workspace before the handler runs (hosted/tools.json ssam_code paths.in
// "/files/*", hosted/policy.mjs): an image there is the bytes the person uploaded or the agent brought; a path of the server or
// of another customer is PATH_OUTSIDE_WORKSPACE and is never read. No other argument of any tool names an image file, so no
// other path can reach the server's filesystem (the proto's images {Name: path} of o11_deliver/studio_deliver is not ported).
import fs from 'node:fs';
import path from 'node:path';
import { sha256Of } from './image-fill-grants.mjs';

export const IMAGE_EXTENSIONS = Object.freeze(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico']);
// The job a delivery carries is at most 8 MB (CODE_FILE_MAX_BYTES of ssam-code.mjs); the images go in it as base64 (4/3 of the
// bytes), so their files are at most 6 MB together, each at most that.
export const IMAGES_MAX_BYTES = 6 * 1024 * 1024;
export const isImageFile = file => IMAGE_EXTENSIONS.includes(path.extname(String(file ?? '')).toLowerCase());
// The name of the module image a file becomes: its base name, with what an OutSystems name does not take written as _, and _
// first when it does not start with a letter or _ (the kernel's ScreenHtmlNative.ImageNameOf, the same rule).
export const imageNameOf = file => {
  const stem = path.basename(String(file), path.extname(String(file))).replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z_]/.test(stem) ? stem : '_' + stem;
};

// One image file -> {op, image: {name, file, bytes}} or {problem}. The file is read only when it is an absolute path of an
// image file of at most IMAGES_MAX_BYTES.
export function imageOp(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return { problem: 'the image file must be an absolute path' };
  if (!isImageFile(file)) return { problem: path.basename(file) + ' is not an image file (' + IMAGE_EXTENSIONS.join(', ') + '): convert it to PNG or JPG' };
  let stat;
  try { stat = fs.statSync(file); } catch { return { problem: 'no file at ' + file }; }
  if (!stat.isFile()) return { problem: 'path is not a file' };
  if (stat.size > IMAGES_MAX_BYTES) return { problem: path.basename(file) + ' has ' + stat.size + ' bytes; an image goes in the job as base64 and the job is at most 8 MB: '
    + IMAGES_MAX_BYTES + ' bytes of images per write; reduce it (resize or compress it, e.g. to JPG under 1 MB)' };
  let bytes;
  try { bytes = fs.readFileSync(file); } catch (error) { return { problem: 'cannot read file: ' + (error.code ?? error.message) }; }
  const name = imageNameOf(file);
  // The grant to fill an image of that name travels outside the job (image-fill-grants.mjs): sha256 of these bytes.
  return { op: { op: 'create', parent: '@espace', type: 'IImage', name, args: { binary: bytes.toString('base64'), originalPath: path.basename(file) } },
    image: { name, file, bytes: bytes.length, sha256: sha256Of(bytes) } };
}
