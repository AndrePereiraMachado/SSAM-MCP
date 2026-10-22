// The tray icon: what src/tray-model.mjs says, rendered with Electron (icon by colour, tooltip, context menu). A click
// on the icon opens the panel on Windows and Linux; on macOS a click shows the menu, as every menu bar item does.
import path from 'node:path';
import { Tray, Menu, nativeImage } from 'electron';
import { menuFor, iconFor, tooltipFor } from '../core/tray-model.mjs';

export function createTray({ iconsDir, platform = process.platform, onAction }) {
  const images = new Map();
  const imageOf = colour => {
    if (!images.has(colour)) {
      const image = nativeImage.createFromPath(path.join(iconsDir, `tray-${colour}-16.png`));
      try { image.addRepresentation({ scaleFactor: 2, buffer: nativeImage.createFromPath(path.join(iconsDir, `tray-${colour}-32.png`)).toPNG() }); } catch { /* one size */ }
      images.set(colour, image);
    }
    return images.get(colour);
  };
  const tray = new Tray(imageOf('grey'));
  if (platform !== 'darwin') tray.on('click', () => onAction('panel'));

  function update({ view, update, appVersion, settings, busy }) {
    tray.setImage(imageOf(iconFor(view)));
    tray.setToolTip(tooltipFor(view, update, appVersion));
    const template = menuFor({ view, update, appVersion, settings, busy }).map(item => (item.type === 'separator' ? { type: 'separator' }
      : { label: item.label, enabled: item.enabled !== false, type: item.type ?? 'normal', checked: item.checked === true, click: () => onAction(item.id) }));
    tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  return { update, destroy: () => tray.destroy() };
}
