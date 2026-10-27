function ssamFormatTemporal(value, semantics, zone, format) {
  if (value === null || value === undefined || value === '') return '';
  const text = String(value);
  let parts;
  if (semantics === 'instant') {
    if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(text)) throw new Error('TEMPORAL_INSTANT_INVALID');
    // Date.parse normalizes impossible dates such as February 30; reject them before interpreting the offset.
    const local = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/.exec(text);
    if (!local) throw new Error('TEMPORAL_INSTANT_INVALID');
    ssamFormatTemporal(local[1] + 'T' + local[2], 'client-local', '', 'yyyy-MM-dd HH:mm:ss');
    if (!zone) throw new Error('TEMPORAL_ZONE_REQUIRED');
    const date = new Date(text);
    if (!Number.isFinite(date.getTime())) throw new Error('TEMPORAL_INSTANT_INVALID');
    parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date).map(p=>[p.type,p.value]));
  } else {
    if (!['date','client-local'].includes(semantics)) throw new Error('TEMPORAL_SEMANTICS_REQUIRED');
    const match = (semantics === 'date' ? /^(\d{4})-(\d{2})-(\d{2})$/ : /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,7})?Z?$/).exec(text);
    if (!match) throw new Error('TEMPORAL_LOCAL_INVALID');
    const date = new Date(0); date.setUTCFullYear(+match[1],+match[2]-1,+match[3]); date.setUTCHours(+(match[4]||0),+(match[5]||0),+(match[6]||0),0);
    if (date.getUTCFullYear()!==+match[1] || date.getUTCMonth()!==+match[2]-1 || date.getUTCDate()!==+match[3] || date.getUTCHours()!==+(match[4]||0) || date.getUTCMinutes()!==+(match[5]||0) || date.getUTCSeconds()!==+(match[6]||0)) throw new Error('TEMPORAL_CALENDAR_INVALID');
    parts={year:match[1],month:match[2],day:match[3],hour:match[4]||'00',minute:match[5]||'00',second:match[6]||'00'};
  }
  if (!/^(?:yyyy|MM|dd|HH|mm|ss|[-/: .])+$/.test(format)) throw new Error('TEMPORAL_FORMAT_INVALID');
  const names={yyyy:'year',MM:'month',dd:'day',HH:'hour',mm:'minute',ss:'second'};
  return format.replace(/yyyy|MM|dd|HH|mm|ss/g,t=>parts[names[t]]);
}
