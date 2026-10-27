// Compile against the installed Studios without loading anything into them.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyPack } from '../src/main/core/pack-sync.mjs';
import { STUDIO_WINDOW, studioBuildPlan, coverageMatrix } from './studio-build-plan.mjs';

const app = fileURLToPath(new URL('../', import.meta.url));
export function selectStudio(report, lane) {
  const found = report.processes?.filter(p => p.lane === lane && p.diagnostics?.ok === true) ?? [];
  if (found.length !== 1) throw new Error('Open exactly one ' + lane + ' Studio and run the report again.');
  const selected = found[0];
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(selected.version ?? '')) throw new Error('Missing Studio build version: ' + lane);
  const root = report.studios?.[lane]?.installed?.dir;
  if (!root || !selected.path?.startsWith(root + path.sep)) throw new Error('Studio executable is outside its installed bundle: ' + lane);
  return { lane, version: selected.version, root, dir: path.dirname(selected.path) };
}

async function main() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Run on the target Apple Silicon Mac.');
  const reportFile = path.join(app, 'mac-bridge-build.json');
  const logFile = path.join(app, 'mac-bridge-build.log');
  fs.writeFileSync(logFile, '');
  const report = { schema: 'ssam-mac-bridge-build/2', ok: false, attached: false, productionReady: false,
    window: STUDIO_WINDOW, coverage: coverageMatrix(), steps: [] };
  function run(command, args) {
    console.log('Running: ' + path.basename(command) + ' ' + args.join(' '));
    const result = spawnSync(command, args, { cwd: app, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    fs.appendFileSync(logFile, '\n' + command + ' ' + args.join(' ') + '\n' + (result.stdout ?? '') + (result.stderr ?? ''));
    if (result.error || result.status !== 0) throw new Error('Build step failed: ' + path.basename(command) + ' (see mac-bridge-build.log)');
    return result.stdout;
  }
  try {
    const native = path.join(app, 'native/Ssam.Agent/bin/Release/net10.0/osx-arm64/publish/ssam-agent');
    if (!fs.existsSync(native)) run(process.execPath, ['scripts/build-native.mjs', 'osx-arm64']);
    const readiness = JSON.parse(run(native, ['mac-inspect']));
    fs.writeFileSync(path.join(app, 'mac-report.json'), JSON.stringify(readiness, null, 2) + '\n');
    const source = path.join(app, 'runtime-source');
    const checked = verifyPack(source);
    if (!checked.ok) throw new Error('Source pack failed integrity verification: ' + checked.detail);
    const base = path.join(app, '.local'); fs.mkdirSync(base, { recursive: true });
    const work = fs.mkdtempSync(path.join(base, 'mac-bridges-'));
    const version = checked.pack.odcBridge;
    if (!/^v\d+$/.test(version)) throw new Error('Invalid ODC bridge version.');
    const studios = [], projects = [];
    let buildFailed = false;
    for (const lane of ['odc', 'o11']) {
      try {
        const studio = selectStudio(readiness, lane);
        const actual = fs.realpathSync(studio.dir), root = fs.realpathSync(studio.root);
        if (!actual.startsWith(root + path.sep)) throw new Error('Studio references leave the installed bundle.');
        const plan = studioBuildPlan(studio, app, version);
        studios.push({ ...studio, targetFramework: plan.targetFramework });
        projects.push(...plan.projects);
      } catch (error) {
        buildFailed = true;
        report.steps.push({ name: lane, ok: false, stage: 'preflight', error: error.message });
        console.log(error.message);
      }
    }
    report.studios = studios;
    const files = [];
    const runtime = path.join(work, 'runtime'); fs.mkdirSync(runtime);
    report.work = work;
    for (const project of projects) {
      try {
      const output = path.join(work, project.name);
      // Rebuild prevents a previous Studio's assemblies from being accepted by
      // incremental compilation after switching versions in the same kit.
      run('dotnet', ['build', project.project, '-restore', '-t:Rebuild', '-c', 'Release', '-p:TargetFramework=' + project.targetFramework, ...project.properties, '-o', output, '--nologo']);
      for (const extension of ['.dll', '.deps.json']) {
        const filename = project.assembly + extension;
        const bytes = fs.readFileSync(path.join(output, filename));
        const relative = project.destination + '/' + filename;
        const destination = path.join(runtime, relative); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, bytes);
        files.push({ path: relative, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
      }
      report.steps.push({ name: project.name, lane: project.lane, version: project.version, targetFramework: project.targetFramework, ok: true });
      } catch (error) {
        buildFailed = true;
        report.steps.push({ name: project.name, lane: project.lane, version: project.version, targetFramework: project.targetFramework, ok: false, error: error.message });
      }
    }
    for (const studio of studios) {
      const row = report.coverage.find(r => r.lane === studio.lane && r.version === studio.version.split('.').slice(0, 3).join('.'));
      const steps = report.steps.filter(s => s.lane === studio.lane);
      row.build = steps.length && steps.every(s => s.ok) ? 'passed' : 'failed';
      row.testedBuild = studio.version; row.targetFramework = studio.targetFramework;
    }
    if (buildFailed) throw new Error('One or more Studios could not be built. Other eligible builds were still attempted; see steps and mac-bridge-build.log. No runtime pack was produced.');
    const pack = { id: 'mac-studios-' + Date.now(), platform: 'darwin', lanes: ['odc', 'o11'], odcBridge: version,
      studioBuilds: Object.fromEntries(studios.map(s => [s.lane, { version: s.version, targetFramework: s.targetFramework }])),
      o11BuiltFor: studios[1].version.split('.').slice(0, 3).join('.'), odcBuiltFor: studios[0].version, o11Hook: 'dev', files };
    fs.writeFileSync(path.join(runtime, 'pack.json'), JSON.stringify(pack, null, 2) + '\n');
    const verified = verifyPack(runtime); if (!verified.ok) throw new Error(verified.detail);
    report.ok = true; report.runtime = runtime; report.files = files;
  } catch (error) { report.error = error.message; process.exitCode = 1; }
  finally {
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
    console.log(report.ok ? 'Bridge builds completed. No Studio was modified.' : report.error);
    console.log('Report: ' + reportFile + '\nLog: ' + logFile);
    spawnSync('/usr/bin/open', ['-R', reportFile]);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
