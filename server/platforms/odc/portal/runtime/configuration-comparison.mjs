// Compares one sanitized deployed-configuration response. This is an observation,
// never authorization to ApplyConfigs or a concurrency/transaction guarantee.
const origins = new Set(['EnvironmentLevelOverride', 'EnvironmentLevelDefault',
  'ApplicationLevelOverride', 'ApplicationLevelDefault', 'LibraryLevelOverride', 'LibraryLevelDefault']);
const types = new Set(['Text', 'Integer', 'LongInteger', 'Decimal', 'Boolean', 'DateTime',
  'Date', 'Time', 'PhoneNumber', 'Email', 'Currency', 'EntityIdentifierType']);
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const visible = x => typeof x === 'string' && !x.includes('[REDACTED]');
const key = x => visible(x) && x.trim().length > 0;

export function compareApplicationConfigurations(data) {
  const issues = [], counts = { equal: 0, different: 0, unknown: 0 };
  const report = (path, state, reason) => {
    counts[state]++;
    // Values, names, secret hashes and URLs must never enter the diagnostics.
    if (state !== 'equal' && issues.length < 200) issues.push({ path, state, reason });
  };
  const fields = (item, path, allowed) => {
    if (Object.keys(item).some(name => !allowed.includes(name))) report(path, 'unknown', 'unrecognized-fields');
  };
  const members = (items, path, visit) => {
    if (!Array.isArray(items)) { report(path, 'unknown', 'collection-not-readable'); return; }
    const keys = new Set();
    items.forEach((item, index) => {
      const at = `${path}/${index}`;
      if (!object(item) || !key(item.key)) { report(at, 'unknown', 'identity-not-readable'); return; }
      const id = item.key.toLowerCase();
      if (keys.has(id)) report(at, 'unknown', 'duplicate-identity');
      keys.add(id);
      visit(item, at);
    });
  };
  const configs = (items, path) => members(items, path, (item, at) => {
    fields(item, at, ['key', 'name', 'description', 'dataType', 'defaultValue', 'deployedValue', 'value',
      'valueOrigin', 'deployedValueOrigin', 'isSecret', 'valueSetAfterDeploy', 'updatedAt', 'filename']);
    if (!origins.has(item.valueOrigin) || !origins.has(item.deployedValueOrigin)) {
      report(at, 'unknown', 'origin-not-readable'); return;
    }
    if (item.valueOrigin !== item.deployedValueOrigin) report(at, 'different', 'origin-changed');
    if (item.isSecret === true) {
      if (item.valueSetAfterDeploy === true) report(at, 'different', 'secret-set-after-deploy');
      // Equal masks or a negative flag alone are not proof of secret equality.
      report(at, 'unknown', 'secret-values-not-compared'); return;
    }
    if (item.isSecret !== false || !types.has(item.dataType)
        || !visible(item.value) || !visible(item.deployedValue)) {
      report(at, 'unknown', 'values-not-comparable'); return;
    }
    if (item.value !== item.deployedValue) report(at, 'different', 'value-changed');
    else if (item.valueOrigin === item.deployedValueOrigin) report(at, 'equal');
  });
  const groups = (items, path) => members(items, path, (item, at) => {
    fields(item, at, ['key', 'name', 'description', 'pluginType', 'configs']);
    configs(item.configs, `${at}/configs`);
  });
  if (!object(data)) report('/', 'unknown', 'response-not-readable');
  else {
    fields(data, '/', ['key', 'name', 'revisionBaseline', 'revisionDeployed', 'settings', 'timers',
      'integrations', 'libraries', 'deployedAt', 'systemConfigurations']);
    if (!Number.isInteger(data.revisionBaseline) || data.revisionBaseline <= 0
        || !Number.isInteger(data.revisionDeployed) || data.revisionDeployed <= 0)
      report('/revision', 'unknown', 'revision-not-readable');
    else if (data.revisionBaseline !== data.revisionDeployed) report('/revision', 'different', 'revision-changed');
    configs(data.settings, '/settings');
    configs(data.systemConfigurations, '/systemConfigurations');
    groups(data.timers, '/timers');
    groups(data.integrations, '/integrations');
    members(data.libraries, '/libraries', (library, at) => {
      fields(library, at, ['key', 'name', 'revision', 'revisionBaseline', 'systemConfigurations', 'settings', 'integrations']);
      // These are library revision/baseline fields, not a deployed revision pair.
      // Their equivalence to deployed library identity has not been proved.
      report(at, 'unknown', 'library-deployed-revision-unproven');
      configs(library.settings, `${at}/settings`);
      configs(library.systemConfigurations, `${at}/systemConfigurations`);
      groups(library.integrations, `${at}/integrations`);
    });
  }
  return { state: counts.different ? 'differences-observed' : counts.unknown ? 'unproven' : 'equal-observed-values',
    scope: 'single-response', applySafetyProven: false, counts, issues,
    issuesTruncated: counts.different + counts.unknown > issues.length };
}
