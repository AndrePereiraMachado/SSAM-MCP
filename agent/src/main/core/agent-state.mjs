// What the app shows about the agent, from the files the agent itself writes: private/agent.json (the state the agent
// refreshes at least every 30 s: starting, connecting, connected, reconnecting, stopped with its exit code) and the
// setup files (config.json and the credential). The words of the exit codes are the agent's own (ssam-agent.mjs,
// EXIT_TEXT); the app adds only what to do next in the app.
import fs from 'node:fs';

export const EXIT_TEXT = Object.freeze({
  0: 'the agent was stopped',
  2: 'credential refused, revoked, expired or replaced by the server owner: ask for a new credential and set the agent up again',
  3: 'another agent with the same credential took over this account; this one stopped so as not to compete with it',
  4: 'the server does not accept this version of the agent: install the current version of this app',
});
// Exit codes the agent decided for good: the app does not start it again until the person acts.
export const FINAL_EXIT_CODES = Object.freeze([2, 3, 4]);
// A state file refreshed less than this long ago, with a living pid, is an agent that runs (the agent's own rule).
export const STALE_MS = 90000;

export function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; }
}

// The state file of a root: {pid, state, at, server, exitCode, reason, delayMs} or null.
export function readState(stateFile) {
  const state = readJson(stateFile);
  if (!state || typeof state.state !== 'string') return null;
  return { pid: Number.isInteger(state.pid) ? state.pid : null, state: state.state, at: typeof state.at === 'string' ? state.at : null,
    server: typeof state.server === 'string' ? state.server : null, exitCode: Number.isInteger(state.exitCode) ? state.exitCode : null,
    reason: typeof state.reason === 'string' ? state.reason : null, delayMs: Number.isInteger(state.delayMs) ? state.delayMs : null };
}

export const isSetUp = files => fs.existsSync(files.config) && fs.existsSync(files.credential);

// What the app does when the agent process ends with `code`: 'final' (2, 3, 4: show why, wait for the person),
// 'stopped' (0: the person asked) or 'restart' (anything else: a crash, restarted with a growing delay).
export function exitPolicy(code) {
  if (code === 0) return 'stopped';
  if (FINAL_EXIT_CODES.includes(code)) return 'final';
  return 'restart';
}
// The delay before the n-th restart after a crash: 5, 10, 20, 40, 60, 60 ... s.
export const restartDelayMs = attempt => Math.min(60000, 5000 * 2 ** Math.max(0, attempt));

// The view the tray and the panel show: {status, text, detail, attention}. status is one of
// not-set-up | stopped | starting | connecting | connected | reconnecting | attention | external.
//   setUp: config and credential exist; running: the app's own child runs (pid); state: readState(); external: an agent
//   of this root the app did not start (its pid lives and the state file is fresh); lastExit: the code of the last end
//   of the app's child, or null; packProblem: text when the bundled pack is broken.
export function summarize({ setUp, running, state, external = false, lastExit = null, packProblem = null }) {
  if (packProblem) return { status: 'attention', text: 'App needs attention', detail: packProblem, attention: true };
  if (!setUp) return { status: 'not-set-up', text: 'Not set up', detail: 'Open the panel and enter the server address and the agent credential.', attention: true };
  if (external) return { status: 'external', text: 'Running outside the app', detail: `An agent started by hand runs for this folder (pid ${state?.pid ?? '?'}). Stop it to let the app take over.`, attention: false };
  if (running) {
    const since = state?.at ? ` since ${state.at}` : '';
    if (state?.state === 'connected') return { status: 'connected', text: 'Connected', detail: `Connected to ${state.server ?? 'the server'}${since}.`, attention: false };
    if (state?.state === 'reconnecting') return { status: 'reconnecting', text: 'Reconnecting', detail: `Lost the server; trying again${state.delayMs ? ` in ${Math.round(state.delayMs / 1000)} s` : ''}.`, attention: false };
    if (state?.state === 'connecting') return { status: 'connecting', text: 'Connecting', detail: 'Talking to the server.', attention: false };
    return { status: 'starting', text: 'Starting', detail: 'The agent is starting.', attention: false };
  }
  if (lastExit !== null && FINAL_EXIT_CODES.includes(lastExit)) return { status: 'attention', text: 'Agent stopped', detail: `Stopped (code ${lastExit}): ${EXIT_TEXT[lastExit]}`, attention: true };
  if (lastExit !== null && lastExit !== 0) return { status: 'stopped', text: 'Agent stopped', detail: `The agent ended unexpectedly (code ${lastExit}); the app starts it again.`, attention: false };
  return { status: 'stopped', text: 'Stopped', detail: 'The agent is not running.', attention: false };
}
