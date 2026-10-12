// Bounded public text from an authorized native invocation failure. This helper
// neither opens private evidence nor changes authentication/execution behavior.
const PRIVATE = '[private]';
const DOTNET_EXCEPTIONS = new Set([
  'System.Exception', 'System.SystemException', 'System.NullReferenceException',
  'System.InvalidOperationException', 'System.ArgumentException', 'System.ArgumentNullException',
  'System.ArgumentOutOfRangeException', 'System.IndexOutOfRangeException', 'System.FormatException',
  'System.InvalidCastException', 'System.OverflowException', 'System.DivideByZeroException',
  'System.NotSupportedException', 'System.NotImplementedException', 'System.ObjectDisposedException',
  'System.UnauthorizedAccessException', 'System.TimeoutException', 'System.OperationCanceledException',
  'System.Threading.Tasks.TaskCanceledException', 'System.Collections.Generic.KeyNotFoundException',
  'System.IO.IOException', 'System.IO.FileNotFoundException', 'System.IO.DirectoryNotFoundException',
  'System.IO.EndOfStreamException', 'System.Net.Http.HttpRequestException', 'System.Security.SecurityException',
  'System.TypeLoadException', 'System.MissingMethodException', 'System.Reflection.TargetInvocationException',
]);

export function nativeDotNetExceptionCategory(specificType) {
  return DOTNET_EXCEPTIONS.has(specificType) ? specificType : 'unknown';
}

export function sanitizeNativeErrorMessage(value, { privateValues = [], userKey, specificType } = {}) {
  let message = typeof value === 'string' ? value : '';
  // Replace complete secrets first, longest first, before any clipping. Include
  // common textual encodings; a secret crossing the 600-character boundary must
  // not leave its prefix in the public result.
  const secrets = new Set();
  for (const secret of [...privateValues, userKey]) {
    if (typeof secret !== 'string' || !secret) continue;
    secrets.add(secret);
    secrets.add(JSON.stringify(secret).slice(1, -1));
    try { secrets.add(encodeURIComponent(secret)); } catch { /* malformed UTF-16: literal still covered */ }
  }
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) message = message.split(secret).join(PRIVATE);

  message = message
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ' + PRIVATE)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, PRIVATE)
    .replace(/\b(?:https?|outsystems):\/\/[^\s<>"']+/gi, raw => {
      // Keep the technical origin/path, but no userinfo, query or fragment.
      const query = raw.search(/[?#]/), clean = (query < 0 ? raw : raw.slice(0, query))
        .replace(/^(\w+:\/\/)[^/]*@/, '$1' + PRIVATE + '@');
      return clean + (query < 0 ? '' : '?' + PRIVATE);
    })
    .replace(/\b(?:cookie|set-cookie|authorization|proxy-authorization)\s*:\s*[^\r\n]*/gi, match => match.slice(0, match.indexOf(':') + 1) + ' ' + PRIVATE)
    .replace(/\b(password|passwd|pwd|access[_-]?token|id[_-]?token|refresh[_-]?token|token|client[_-]?secret|secret|api[_-]?key|x-api-key|authorization|cookie|username|email)\b(["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&<>\r\n]+)/gi,
      (_, key, separator) => key + separator + PRIVATE)
    .replace(/\b[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}\b/g, PRIVATE)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, PRIVATE)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  const characters = Array.from(message);
  return { message: characters.slice(0, 600).join(''), truncated: characters.length > 600,
    exceptionCategory: nativeDotNetExceptionCategory(specificType) };
}
