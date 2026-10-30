// The tray: which icon, which tooltip and which menu for a view (agent-state.mjs summarize) and an update state
// (update-model.mjs). Pure: the Electron tray (src/electron/tray.mjs) renders what this says.
import { updateText } from './update-model.mjs';

// The icon colour of each status: grey (nothing runs), amber (on its way), green (connected), red (needs the person).
export const ICON_OF = Object.freeze({ 'not-set-up': 'red', attention: 'red', stopped: 'grey', external: 'grey', starting: 'amber', connecting: 'amber',
  reconnecting: 'amber', connected: 'green' });

export const iconFor = view => ICON_OF[view.status] ?? 'grey';

export function tooltipFor(view, update, appVersion) {
  const lines = [`SSAM Agent ${appVersion}: ${view.text}`];
  if (update.status === 'ready') lines.push(`Update ${update.version ?? ''} ready: restart to install`);
  return lines.join('\n');
}

// The menu as data: [{id, label, enabled?, type?, checked?}]; type 'separator' between groups.
export function menuFor({ view, update, appVersion, settings, busy = false }) {
  const running = ['starting', 'connecting', 'connected', 'reconnecting'].includes(view.status);
  const items = [
    { id: 'status', label: `${view.text}`, enabled: false },
    { id: 'panel', label: 'Open panel...' },
    { type: 'separator' },
  ];
  if (running) items.push({ id: 'stop', label: 'Disconnect', enabled: !busy });
  else items.push({ id: 'start', label: view.status === 'not-set-up' ? 'Activate...' : 'Connect', enabled: !busy && view.status !== 'external' });
  items.push({ type: 'separator' }, { id: 'quit', label: 'Quit SSAM Agent' });
  return items;
}
