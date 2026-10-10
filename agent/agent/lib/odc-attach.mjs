// odc.attach (docs/FASE2-AGENTE.md 4.4): the ODC bridge of the agent pack is loaded into the customer's ODC Studio by
// the pack's own .NET client, `dotnet ODC3.Bridge.Client.dll <pid> attach <bridge dll>`. No path comes from the server.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentError } from './errors.mjs';

const exec = promisify(execFile);
const parse = text => { try { const value = JSON.parse(String(text ?? '').trim()); return value && typeof value === 'object' ? value : null; } catch { return null; } };

// The client prints one JSON line ({ok, attached, note}) or fails; a failure after the process started is an unknown
// outcome (the startup hook may have been applied), never repeated here.
export async function attachOdc({ pid, client, bridge }, { run = exec } = {}) {
  try {
    const { stdout } = await run('dotnet', [client, String(pid), 'attach', bridge], { windowsHide: true, timeout: 90000, maxBuffer: 1024 * 1024 });
    const result = parse(stdout);
    if (!result) throw new AgentError('ATTACH_FAILED', 'The ODC bridge client answered no JSON', { executed: null });
    return result;
  } catch (error) {
    if (error instanceof AgentError) throw error;
    const result = parse(error.stdout);
    if (result) return result;
    const text = [error.stderr, error.stdout, error.message].filter(Boolean).join('\n');
    const message = /0x800711c7|0xc0e90002/i.test(text)
      ? 'odc_application_control_blocked: Windows blocked the ODC runtime of the agent pack (Smart App Control / application control). The attach is not confirmed.'
      : text.trim().split(/\r?\n/).find(Boolean) ?? 'The ODC bridge client failed';
    throw new AgentError('ATTACH_FAILED', message, { executed: null });
  }
}
