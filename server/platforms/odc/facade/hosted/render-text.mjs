// ssam_render (fase4-28 r2-preview): the scrubber of the words of the kernel, the agent or a capture that ssam_render keeps for
// diagnosis in the account's own evidence (ws:<lane>/render/errors/<sha256>.json). Review round 3: these words NEVER reach an
// answer (screen-render.mjs answers a fixed sentence by code); this only keeps the evidence free of stack frames and paths.
// It keeps the first line, cuts it at a stack frame anywhere in the line, drops an exception type prefix, replaces absolute
// paths of any system with <path>, collapses white space and keeps at most `limit` characters.
const FRAME = /\s+at\s+[\w$.<>[\]]+\s*\(|\s+at\s+(?:node:|file:|[A-Za-z]:[\\/]|\/)\S*|\s*\bin\s+\S+\.(?:cs|mjs|cjs|js|ts):line\s+\d+/;
const EXCEPTION = /^(?:System\.(?:[A-Za-z]+\.)*[A-Za-z]*Exception|[A-Z][A-Za-z]*(?:Error|Exception)|Error)\s*:\s*/;
const PATHS = [
  // C:\... or C:/... (segments may hold spaces; the last one runs to its extension)
  /(?<![A-Za-z0-9])[A-Za-z]:[\\/](?:[^\\/\n'"<>|*?]+[\\/])*(?:[^\\/\n'"<>|*?]*\.[A-Za-z0-9]{1,8}\b|[^\\/\s'"<>|*?]*)/g,
  /\\\\[^\s'"<>|]+/g,                                // \\server\share\...
  /file:\/\/\/?[^\s'"<>]*/g,                         // file:///...
  /~[\\/][^\s'"<>]*/g,                               // ~/...
  /(?<![\w:./-])\/[\w.@-]+(?:\/[^\s'"<>()]*)+/g,     // /srv/..., /src/..., /home/..., /Users/..., /tmp/...
];

export function answerText(text, limit = 300) {
  let line = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')[0];
  const frame = FRAME.exec(line);
  if (frame) line = line.slice(0, frame.index);
  line = line.replace(EXCEPTION, '');
  for (const re of PATHS) line = line.replace(re, '<path>');
  line = line.replace(/\s+/g, ' ').replace(/[\s:;,(]+$/, '').trim();
  return line.length > limit ? line.slice(0, limit - 3) + '...' : line;
}
