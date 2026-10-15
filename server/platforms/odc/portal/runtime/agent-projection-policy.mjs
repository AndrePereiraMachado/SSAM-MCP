// These tools return local contracts or pure plans, never tenant response data.
export const AGENT_PROJECTION_EXCLUSIONS = Object.freeze([
  'odc_status', 'odc_portal_capabilities', 'odc_describe_capability',
  'odc_list_apis', 'odc_search_operations', 'odc_describe_operation',
  'odc_a2a_connection_plan',
]);
