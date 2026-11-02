// The rows of what o11.xif lets pass (F4 of PLANO-11H): the Node agent (tests/xif.test.mjs, prepareXifRequest) and the
// native core (check-xif-request, tests/native/xif.test.mjs) answer the same table: 'ok' or the refusal code.
export const OP = '0123456789abcdef';
const at = rel => 'agent:o11/xif/' + OP + '/' + rel;
const SPEC = { name: 'ZZHybridXifLab', actions: [{ name: 'Add', inputs: [], outputs: [] }] };
const model = (over = {}) => ({ command: 'model', operationId: OP, output: at('out/ZZHybridXifLab.xif'), spec: SPEC, references: [at('in/0/Vendor.dll')], ...over });
const final = (over = {}) => ({ command: 'final', operationId: OP, output: at('out/ZZHybridXifLab.xif'), name: 'ZZHybridXifLab', model: at('in/0/ZZHybridXifLab.xif'),
  dll: at('in/1/OutSystems.NssZZHybridXifLab.dll'), sources: [{ path: 'Source\\NET\\ZZHybridXifLab.cs', file: at('in/2/ZZHybridXifLab.cs') }], ...over });
export const xifRows = () => [
  { label: 'a model stage', params: model(), expected: 'ok' },
  { label: 'a model stage over the current extension, with a resource file', params: model({ base: at('in/1/ZZHybridXifLab.xif'), spec: { ...SPEC, resources: [{ path: 'Data\\a.txt', file: at('in/2/a.txt'), deploy: 'Ignore' }] } }), expected: 'ok' },
  { label: 'a final stage', params: final(), expected: 'ok' },
  { label: 'a probe is not a stage', params: { command: 'probe', operationId: OP }, expected: 'PARAMS_INVALID' },
  { label: 'an unknown field', params: model({ exe: 'C:\\Windows\\System32\\cmd.exe' }), expected: 'PARAMS_INVALID' },
  { label: 'no operation id', params: model({ operationId: 'x' }), expected: 'PARAMS_INVALID' },
  { label: 'an invalid extension name', params: model({ spec: { ...SPEC, name: '..\\x' }, output: at('out/..\\x.xif') }), expected: 'PARAMS_INVALID' },
  { label: 'an output elsewhere', params: model({ output: at('out/Other.xif') }), expected: 'PATH_FORBIDDEN' },
  { label: 'an absolute path of this machine', params: model({ references: ['C:\\Windows\\System32\\kernel32.dll'] }), expected: 'PATH_FORBIDDEN' },
  { label: 'a file of another operation', params: model({ references: ['agent:o11/xif/fedcba9876543210/in/0/Vendor.dll'] }), expected: 'PATH_FORBIDDEN' },
  { label: 'a dot segment that leaves the operation', params: model({ references: [at('../fedcba9876543210/in/0/Vendor.dll')] }), expected: 'PATH_FORBIDDEN' },
  { label: 'a dot segment inside the folder', params: model({ references: [at('in/../../../private/credential')] }), expected: 'PATH_FORBIDDEN' },
  { label: 'a source path that leaves the extension', params: final({ sources: [{ path: '..\\..\\x.cs', file: at('in/2/x.cs') }] }), expected: 'PARAMS_INVALID' },
  { label: 'a source path with a drive', params: final({ sources: [{ path: 'C:\\x.cs', file: at('in/2/x.cs') }] }), expected: 'PARAMS_INVALID' },
  { label: 'the spec carries references', params: model({ spec: { ...SPEC, references: ['C:\\a.dll'] } }), expected: 'PARAMS_INVALID' },
];
