// Restore an ODC setting to its inherited value by name: {Name: null} becomes
// {key, value:null}. Scalars keep String(); secrets stay refused by name. The
// access layer verifies the reset by origin (*Default), never by value.
import * as z from 'zod/v4';

export const INHERITED_SETTING_ORIGINS = Object.freeze(['EnvironmentLevelDefault', 'ApplicationLevelDefault', 'LibraryLevelDefault']);
// The odc_configurations `settings` argument with reset by null.
export const settingsArgument = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));
export const settingPatchValue = value => value === null ? null : String(value);
export const settingResetObserved = observed => !!observed && INHERITED_SETTING_ORIGINS.includes(observed.valueOrigin);

// Over the current OdcAccess: a null by name is sent as a raw patch entry, whose
// read-back the access layer already accepts only by inherited origin.
export async function configurationsWithReset(access, input) {
  const entries = Object.entries(input?.settings ?? {}), resets = entries.filter(([, value]) => value === null);
  if (input?.action !== 'set' || !resets.length) return access.configurations(input);
  const { tenant, auth, scope, environmentKey, assetKey } = input;
  const current = await access.configurations({ tenant, auth, action: 'get', scope, environmentKey, assetKey });
  if (!current?.ok) return { ...current, ok: false, sent: false };
  const known = Array.isArray(current.data?.settings) ? current.data.settings : [];
  const patch = { ...(input.patch ?? {}), settings: [...(input.patch?.settings ?? [])] };
  for (const [name] of resets) {
    const setting = known.find(s => s.name === name || s.key === name);
    if (!setting) return { ok: false, sent: false, error: { code: 'SETTING_NOT_FOUND', message: 'No setting named ' + name + ' in the current configuration.' } };
    if (setting.isSecret) return { ok: false, sent: false, error: { code: 'SECRET_IN_ARGUMENTS', setting: name,
      message: 'A secret setting is never a settings argument: change it only through vaultSettings or the authorized secret flow.' } };
    patch.settings.push({ key: setting.key, value: null });
  }
  const settings = Object.fromEntries(entries.filter(([, value]) => value !== null));
  return access.configurations({ ...input, settings: Object.keys(settings).length ? settings : undefined, patch });
}
