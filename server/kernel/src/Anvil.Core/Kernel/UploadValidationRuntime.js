function ssamValidateUpload(content, filename, maxBytes, extensions) {
  let error = '';
  try {
    const size = atob(content || '').length;
    const allowed = (extensions || '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
    const extension = (filename || '').toLowerCase().match(/\.[^.]+$/);
    if (maxBytes > 0 && size > maxBytes) error = 'File exceeds the size limit';
    else if (size > 0 && allowed.length && (!extension || !allowed.includes(extension[0]))) error = 'File type is not allowed';
  } catch (_) { error = 'Invalid file content'; }
  return { valid: !error, error };
}
