import './styles.css';
import logo from '../../../build/icon.png';
const api = window.ssamPrivate;
const node = (tag, text, className) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; if (className) value.className = className; return value; };
const root = document.querySelector('#root');
let fields = [], busy = false, armed = false;
function clearSecrets() { for (const field of fields) if (field.type === 'password') field.value = ''; }
window.addEventListener('pagehide', clearSecrets);
async function start() {
  const model = await api.bootstrap();
  if (!model) return;
  const service = { users: 'Users', 'service-center': 'Service Center', 'odc-portal': 'ODC Portal' }[model.service];
  const client = model.auth === 'api-client';
  const title = { login: client ? 'Connect an API client' : `Sign in to ${service}`, password: 'Set a user password', approve: 'Confirm this change', profile: 'Choose a saved profile', forget: 'Remove saved credential?' }[model.form];
  const descriptions = { login: client ? 'Use an API client for this ODC environment.' : 'Connect your account to continue the requested task.', password: 'Enter and confirm the new password here, never in chat.', approve: 'Review the exact change before approving it.', profile: 'Choose the account for this request.', forget: 'Remove the selected credential from this device.' };
  const shell = node('section', undefined, `shell ${model.form}`); root.append(shell);
  const brand = node('div', undefined, 'brand'); const image = node('img'); image.src = logo; image.alt = ''; brand.append(image, node('strong', 'SSAM Agent')); shell.append(brand);
  const heading = node('h1', undefined, 'heading'); heading.append(node('span', undefined, 'dot'), node('span', title)); shell.append(heading, node('p', descriptions[model.form], 'description'));
  const host = node('div', undefined, 'host'); host.append(node('div', service, 'service'), node('div', model.host, 'hostname')); shell.append(host);
  const field = (label, secret = false) => { const wrap = node('div', undefined, 'field'); const id = `field-${fields.length}`; const caption = node('label', label); caption.htmlFor = id; const input = node('input'); input.type = secret ? 'password' : 'text'; input.id = id; input.autocomplete = 'off'; input.spellcheck = false; input.maxLength = 5120; wrap.append(caption, input); fields.push(input); shell.append(wrap); return input; };
  let username, password, confirmation, remember, selected;
  if (model.form === 'login') { username = field(client ? 'Client ID' : model.auth === 'service-token' ? 'Account label' : model.service === 'users' ? 'Username' : 'Email or username'); username.maxLength = 1024; password = field(client ? 'Client secret' : model.auth === 'service-token' ? 'Service token' : 'Password', true); const label = node('label', undefined, 'remember'); remember = node('input'); remember.type = 'checkbox'; remember.checked = false; label.append(remember, node('span', 'Remember on this device')); shell.append(label); }
  if (model.form === 'password') { password = field('New password', true); confirmation = field('Confirm password', true); }
  if (model.rows?.length) { const rows = node('dl', undefined, 'rows'); for (const row of model.rows) { const wrap = node('div', undefined, 'row'); wrap.append(node('dt', row.label + (row.data ? ' (from the page, not verified)' : '')), node('dd', row.value)); rows.append(wrap); } shell.append(rows); }
  if (model.form === 'profile') for (const profile of model.profiles) { const label = node('label', undefined, 'profile'); const input = node('input'); input.type = 'radio'; input.name = 'profile'; input.value = profile.profile; input.addEventListener('change', () => { selected = profile.profile; update(); }); label.append(input, node('span', profile.principal)); shell.append(label); }
  const error = node('div', '', 'error'); error.setAttribute('role', 'alert'); shell.append(error);
  const actions = node('div', undefined, 'actions'); const cancel = node('button', model.form === 'approve' ? 'Decline' : 'Cancel'); const submit = node('button', { login: client ? 'Connect' : 'Sign in', password: 'Save securely', approve: 'Approve change', profile: 'Use profile', forget: 'Remove credential' }[model.form], 'primary'); cancel.type = submit.type = 'button'; actions.append(cancel, submit); shell.append(actions, node('p', model.form === 'approve' ? 'Only this exact change will be approved.' : 'Your credentials stay on this device.', 'privacy'));
  const footer = node('footer'); footer.append(node('span', 'Private window'), node('span', 'ssam.pro')); shell.append(footer);
  function update() { submit.disabled = busy || !armed || model.form === 'profile' && !selected; cancel.disabled = busy; shell.classList.toggle('busy', busy); for (const input of shell.querySelectorAll('input')) input.disabled = busy; }
  armed = model.form !== 'approve'; update();
  if (!armed) setTimeout(() => { armed = true; update(); }, model.approveDelayMs);
  const cancelAction = () => { if (!busy) { clearSecrets(); void api.cancel(); } };
  cancel.addEventListener('click', cancelAction);
  submit.addEventListener('click', async () => {
    if (submit.disabled) return;
    const values = model.form === 'login' ? { username: username.value, password: password.value, remember: remember.checked } : model.form === 'password' ? { password: password.value, confirmation: confirmation.value } : model.form === 'profile' ? { profile: selected } : { approved: true };
    busy = true; error.textContent = ''; update();
    try { const result = await api.submit(values); if (!result?.ok) { busy = false; error.textContent = result?.error || 'The private request could not be completed.'; update(); } }
    catch { busy = false; error.textContent = 'The private request could not be completed.'; update(); }
  });
  api.onState(state => { busy = state.busy === true; error.textContent = state.error || ''; update(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); cancelAction(); } else if (event.key === 'Enter') { event.preventDefault(); if (document.activeElement === cancel) cancel.click(); else if (model.form === 'approve' || model.form === 'forget') { if (document.activeElement === submit) submit.click(); else cancel.click(); } else submit.click(); } });
  new ResizeObserver(() => { void api.resize(shell.scrollHeight).catch(() => {}); }).observe(shell);
  if (model.form === 'approve' || model.form === 'forget') cancel.focus(); else fields[0]?.focus();
}
start().catch(() => { clearSecrets(); root.replaceChildren(node('p', 'The private window could not be opened.', 'description')); });
