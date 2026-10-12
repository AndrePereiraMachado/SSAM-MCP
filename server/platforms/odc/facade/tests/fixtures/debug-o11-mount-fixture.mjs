// Offline O11 Reactive published-asset fixture shaped after a real index.html,
// bootstrap (<Module>.index.js) and appDefinition of a personal-environment app.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const o11FixtureModule = 'Fixture_UI';
export const o11FixtureOrigin = 'https://fixture-o11.example.com';
export const o11FixtureUrl = o11FixtureOrigin + '/' + o11FixtureModule + '/';
const sha = text => createHash('sha256').update(text).digest('hex');

export const o11FixtureBootstrap = (m = o11FixtureModule) => `require(["es6-promise", "tslib"], function (es6promise, tslib) {
require(["OutSystems/ClientRuntime/Main", "${m}.appDefinition", "OutSystems/ClientRuntime/Debugger"], function (OutSystems, ${m}AppDefinition, Debugger) {
var OS = OutSystems.Internal;
OS.Settings.setPlatformSettings({
IndexedDBOffline: false,
UseNewWebSQLImpl: false,
SendEnvParamOnManifestRequest: true,
AllowIndexedDBInWebKitIframes: true
});
if(OS.Navigation.ensureRequestSecurity()) {
return;
}

OutSystemsDebugger.initialize().then(function () {
return OS.Application.default.initialize(${m}AppDefinition, OS.Interfaces.Application.InitializationType.Full, new OS.Format.DateTimeFormatInfo("yyyy-MM-dd", "HH:mm:ss"), new OS.Format.NumberFormatInfo(".", "")).then(function (success) {
function initViewPromise() {
return OS.Flow.promise(function (resolve, reject) {
require(["OutSystems/ReactView/Main"], function (OSView) {
try {OSView.Router.load(OS.Application.default);
resolve();
} catch (error) {
reject(error);
}

});
});
};
if(success) {
return initViewPromise();
}


});
}).catch(function (error) {
OS.ErrorHandling.handleError(error);
});
});
});
`;

export const o11FixtureAppDefinition = ({ m = o11FixtureModule, environmentName = 'Development', debugEnabled = true } = {}) => `define("${m}.appDefinition", ["OutSystems/ClientRuntime/Main"], function (OutSystems) {
var OS = OutSystems.Internal;
return {
environmentKey: "46a23fc0-e85a-4bfa-a83f-db86fc0324dc",
environmentName: "${environmentName}",
applicationKey: "beb8d480-bdfb-4cdf-a33d-293d6376b052",
applicationName: "Fixture",
userProviderName: "Users",
debugEnabled: ${debugEnabled},
homeModuleName: "${m}",
homeModuleKey: "d8f42732-5cfc-421f-bb2a-20011074f032",
homeModuleControllerName: "${m}.controller",
homeModuleLanguageResourcesName: "${m}.languageResources",
defaultTransition: "Fade",
errorPageConfig: {
showExceptionStack: false
},
isWeb: true,
personalArea: null,
showWatermark: false
};
});
`;

// Writes the pinned files and returns the runtime record acquireO11BrowserAssets would return.
export function writeO11MountFixture(directory, { m = o11FixtureModule, bootstrap, appDefinition, indexHtml, extraScripts = {}, versionId = 4870,
  versionToken = 'JiJG+RhMVA8EWH4jngemOA', indexToken = 'lMo2PVvJ4vvkAwjP5zW2Nw' } = {}) {
  fs.mkdirSync(directory, { recursive: true });
  const scripts = { 'OutSystemsManifestLoader.js': 'var OSManifestLoader={indexVersionToken:null};',
    'OutSystems.js': '/* runtime */', 'OutSystemsSettings.js': '/* settings */', 'Debugger.js': '/* debugger */',
    [m + '.appDefinition.js']: appDefinition ?? o11FixtureAppDefinition({ m }), [m + '.controller.js']: 'define("' + m + '.controller",[],function(){return {};});',
    [m + '.MainFlow.Home.mvc.js']: 'define("' + m + '.MainFlow.Home.mvc$controller",[],function(){return {};});',
    [m + '.index.js']: bootstrap ?? o11FixtureBootstrap(m), ...extraScripts };
  const css = { '_Basic.css': 'body{margin:0}', [m + '.' + m + '.css']: '.x{}' };
  const query = name => '?' + sha(name).slice(0, 22).replace(/[0-9]/g, 'A');
  const urlVersions = { ['/' + m + '/index.html']: '?' + indexToken };
  const pins = {};
  const pin = (relative, text, urlPath) => {
    const file = path.join(directory, relative.replace('/', '__')); fs.writeFileSync(file, text);
    pins[relative] = { path: file, sha256: sha(text), ...(urlPath ? { urlPath, query: query(relative) } : {}) };
    if (urlPath) urlVersions[urlPath] = query(relative);
  };
  for (const [name, text] of Object.entries(scripts)) pin('scripts/' + name, text, '/' + m + '/scripts/' + name);
  for (const [name, text] of Object.entries(css)) pin('css/' + name, text, '/' + m + '/css/' + name);
  const q = name => pins['scripts/' + name].query;
  const html = indexHtml ?? `<!DOCTYPE html>
<html>
    <head>
        <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
        <script type='text/javascript'>window.OutSystemsApp = { basePath: '/${m}/' };</script>
        <meta name="viewport" content="viewport-fit=cover, width=device-width, initial-scale=1" />
<script type="text/javascript">
(function () { if (navigator && /OutSystemsApp/i.test(navigator.userAgent)) { document.title = 'native'; } })();</script>
        <script type="text/javascript" src="scripts/OutSystemsManifestLoader.js${q('OutSystemsManifestLoader.js')}"></script>
<script type="text/javascript" src="scripts/OutSystems.js${q('OutSystems.js')}"></script>
<script type="text/javascript" src="scripts/OutSystemsSettings.js${q('OutSystemsSettings.js')}"></script>
<script type="text/javascript" src="scripts/Debugger.js${q('Debugger.js')}"></script>
<script type="text/javascript" src="scripts/${m}.appDefinition.js${q(m + '.appDefinition.js')}"></script>
<link type="text/css" rel="stylesheet" href="css/_Basic.css${pins['css/_Basic.css'].query}"></link>
        <script type="text/javascript">OSManifestLoader.indexVersionToken = "${indexToken}";
</script>
    </head>
    <body>
        <div id="reactContainer"></div>
        <noscript><span>JavaScript is required</span></noscript>
        <script type="text/javascript" src="scripts/${m}.index.js${q(m + '.index.js')}"></script>
    </body>
</html>`;
  pin('index.html', html);
  pin('moduleinfo.json', JSON.stringify({ manifest: { versionToken, versionSequence: versionId, urlVersions }, data: { modules: {} } }));
  return { runtimeUrl: o11FixtureOrigin + '/' + m + '/', module: m, moduleVersion: versionToken, versionId, pins };
}
