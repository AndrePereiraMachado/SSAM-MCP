// Read the generated Data Action record contract. Values remain owned by the SDK.
export function nativeDataActionOutputs(plan, model) {
  if (plan.member.call?.kind !== 'data-action') return plan.outputs;
  const record = model?.variables?.[plan.member.dataActVar];
  const attributes = record?.getAttributes?.();
  if (!Array.isArray(attributes) || !attributes.length || attributes.length > 500)
    throw new Error('debug_odc_native_data_output_contract_unavailable');
  const outputs = attributes.filter(a => a.nameForJson && !a.ignoreForServer);
  if (!outputs.length || outputs.some(a => typeof a.nameForJson !== 'string' || typeof a.attrName !== 'string' ||
      !a.attrName || !(a.attrName in record)) || new Set(outputs.map(a => a.nameForJson)).size !== outputs.length)
    throw new Error('debug_odc_native_data_output_contract_unavailable');
  return outputs.map(a => ({ wire: a.nameForJson, attrName: a.attrName, dataType: a.dataType }));
}
