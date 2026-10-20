// The agent as a utility process of Electron: the same Node the app runs on (Electron 44 carries Node 24, with
// --use-env-proxy and --use-system-ca), started with the agent's own command line and ended by the supervisor. The
// shape is the one src/supervisor.mjs expects from any fork: {ready, on, kill, stdout, stderr}.
import { utilityProcess } from 'electron';

export const forkWithUtilityProcess = () => (script, args, { cwd, env, execArgv = [], stdio = 'ignore' } = {}) => {
  const child = utilityProcess.fork(script, args, { cwd, env, execArgv, stdio, serviceName: 'ssam-agent' });
  const ready = new Promise((resolve, reject) => {
    child.once('spawn', () => resolve(child.pid));
    child.once('exit', code => reject(new Error(`the agent process ended before it started (code ${code})`)));
  });
  ready.catch(() => {});
  return { ready, on: (event, fn) => child.on(event, fn), kill: () => child.kill(), stdout: child.stdout, stderr: child.stderr };
};
