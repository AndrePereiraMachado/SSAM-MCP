export const planIndex = {
  contracts: { spec: { ddl: { format: 'ssam-ddl/1' } }, logic: { flow: { format: 'ssam-flow/1' } }, html: { document: { format: 'ssam-html/1' } } },
  capabilities: [{ id: 'logic.flow', contract: ['logic.flow'], limits: ['A branch retains both paths.'], guidance: 'Preserve existing keys.' }],
};
