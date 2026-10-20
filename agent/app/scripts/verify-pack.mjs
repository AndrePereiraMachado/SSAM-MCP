// The pack folder checked against its pack.json (every file present with its sha256), as the app does at start and
// the agent's doctor does in the root. Exit 0 when whole, 1 otherwise.
//   node scripts/verify-pack.mjs <folder> [--platform windows|mac]
import { verifyPack } from '../src/pack-sync.mjs';

const [folder = 'pack', ...rest] = process.argv.slice(2);
const platform = rest.includes('--platform') ? rest[rest.indexOf('--platform') + 1] : null;
const result = verifyPack(folder);
const packPlatform = result.pack?.platform === 'darwin' ? 'mac' : 'windows';
if (result.ok && platform && platform !== packPlatform) { console.error(`The pack in ${folder} is for ${packPlatform}, not ${platform}.`); process.exit(1); }
console.log(`${result.ok ? 'OK' : 'DAMAGED'}: ${result.detail}${result.pack ? ` [${packPlatform}, lanes ${(result.pack.lanes ?? []).join(',')}, ODC bridge ${result.pack.odcBridge ?? '-'}, Service Studio ${result.pack.o11BuiltFor ?? '-'}]` : ''}`);
process.exit(result.ok ? 0 : 1);
