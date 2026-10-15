// Source: sintese/s3-odc-forma.mjs; sha256: 93851c391ed3cf925c346983e90f2ceed3189af7ae7871542781a0f2f73ad5f1.
// Port changes: parameterized input, pure functions, English filenames; drivers and output removed.
export const shape = s => { const codes = [...new Set((s.match(/"(code|outcome|status|state|result|mode|phase)"\s*:\s*"[A-Za-z_]{2,40}"/g) || []))].slice(0, 6); return codes.join(' | ') || s.slice(0, 120).replace(/[^\x20-\x7e]/g, ''); };
