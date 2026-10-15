// Source: sintese/s1-pedidos.mjs; sha256: 530d46dff2f6b1257761247171066f65755dda9afa0ecf23e4905dee7e1e6de7.
// Port changes: parameterized input, pure functions, English filenames; drivers and output removed.
export const lane = n => /^(studio_|odc_|hybrid_)/.test(n) ? 'odc' : /^(o11_|context$|propose$|continue$|status$)/.test(n) ? 'o11' : 'both';
