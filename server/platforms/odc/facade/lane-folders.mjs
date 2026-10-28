// The folders of each O11 lane (lanes.py `Lane`), ONE table for who writes there and who reads what was written:
// o11-lane.mjs gives the kernel of a lane its folders (--work <local>/work, where DeliveryTask keeps
// work/deliver/<taskId>/task.json and result.json), and the friction store reads the delivery receipts of the KPI from the
// same folders (fase4-28 R1, review item F5: the hosted KPI looked in <ws>/kernel/.local/work/deliver while the kernel of a
// customer writes in <ws>/o11/work/deliver). Only node:path: the friction store of the root launcher imports it.
import path from 'node:path';

export const O11_LANE_FOLDERS = Object.freeze({ ss4: '.local', ss5: path.join('.local', 'lane-ss5') });

// The lane's own folder: <kernel>/<lane folder>, or <ws>/o11 of a hosted customer (one O11 lane per workspace).
export function laneLocalDir(lane, { kernel, workspace = null }) {
  if (workspace) return path.join(workspace, 'o11');
  if (!Object.hasOwn(O11_LANE_FOLDERS, lane)) throw new Error(`Unknown O11 lane '${lane}'; lanes: ${Object.keys(O11_LANE_FOLDERS).join(', ')}`);
  return path.join(kernel, O11_LANE_FOLDERS[lane]);
}
export const laneWorkDir = local => path.join(local, 'work');
export const odcDeliveryReceiptDir = ({ workspace = null, odc = null }) => workspace ? path.join(workspace, 'odc', 'lab') : odc ? path.join(odc, 'lab') : null;

// The folders of the kernel's delivery receipts (<work>/deliver/<taskId>/result.json): of a hosted customer's workspace, or
// of every O11 lane of a kernel root.
export function deliverReceiptDirs({ kernel = null, workspace = null, odc = null } = {}) {
  const locals = workspace ? [laneLocalDir(null, { workspace })] : kernel ? Object.keys(O11_LANE_FOLDERS).map(lane => laneLocalDir(lane, { kernel })) : [];
  return [...locals.map(local => path.join(laneWorkDir(local), 'deliver')), odcDeliveryReceiptDir({ workspace, odc })].filter(Boolean);
}
