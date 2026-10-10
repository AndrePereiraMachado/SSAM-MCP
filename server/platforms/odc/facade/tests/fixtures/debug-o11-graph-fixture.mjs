// Synthetic O11 published model (ssam-reading/1 trees) and published Reactive assets (compiled AMD shapes) for the
// graph-driven native-entry tests. Explicitly synthetic: names/keys are invented; shapes follow the O11 compiler output
// observed in public assets (callServerAction/callDataAction/OutSystemsDebugger.push/registerVariableGroupType).

export const UI = { module: 'ShopUI', moduleKey: 'UIUIUIUIUIUIUIUIUIUIUI' };
export const CS = { module: 'ShopCS', moduleKey: 'CSCSCSCSCSCSCSCSCSCSCS' };
const k = (prefix, n) => (prefix + String(n)).padEnd(22, 'x').slice(0, 22);

function param(kind, name, key, dataType, extra = {}) {
  return { kind, name, key, path: null, properties: { ObjectKey: key, Name: name, DataType: dataType, IsMandatory: 'True', ...extra }, propertyReferences: {}, children: [] };
}
function exec(nodeKey, actionRef, args) {
  return { kind: 'ExecuteServerActionNode', name: 'Call' + actionRef.name, key: nodeKey, properties: { ObjectKey: nodeKey, Action: actionRef.kind + ':' + actionRef.name },
    propertyReferences: { Action: actionRef }, children: args.map(([parameter, value], i) => ({ kind: 'Argument', name: '', key: nodeKey.slice(0, 20) + 'a' + i,
      properties: { Value: value, Parameter: 'InputParameter:' + parameter }, propertyReferences: { Parameter: { kind: 'InputParameter', name: parameter, key: k('P' + parameter, 0) } }, children: [] })) };
}
function action(kind, module, name, key, { path, inputs = [], outputs = [], nodes = [], isPublic = false } = {}) {
  return { kind, name, key, path: path ?? kind + ':' + name,
    properties: { ObjectKey: key, GlobalKey: module.moduleKey + '*' + key, Name: name, Public: isPublic ? 'True' : 'False' }, propertyReferences: {},
    children: [...inputs, ...outputs, { kind: 'StartNode', name: '', key: k('S' + key.slice(0, 6), 1), properties: {}, propertyReferences: {}, children: [] }, ...nodes] };
}

// ShopCS: public service action Quote_Compute(Zip:Text, Amount:Decimal) -> private server action Rate_Lookup(Zip, Factor:Integer, Owner:Identifier)
export const KEYS = {
  rateLookup: k('RateLookup', 0), quoteCompute: k('QuoteCompute', 0), orphan: k('Orphan', 0), timerJob: k('TimerJob', 0), timerOnly: k('TimerOnly', 0),
  placeOrder: k('PlaceOrder', 0), uiPrivate: k('UiPrivate', 0), quoteSig: k('QuoteSig', 0), loadQuotes: k('LoadQuotes', 0), buyClick: k('BuyClick', 0),
  slug: k('Slugify', 0), login: k('DoLogin', 0),
};
export function csReadings() {
  const rate = action('ServerAction', CS, 'Rate_Lookup', KEYS.rateLookup, { inputs: [
    param('InputParameter', 'Zip', k('PZip', 1), 'BasicType:Text'), param('InputParameter', 'Factor', k('PFactor', 1), 'BasicType:Integer'),
    param('InputParameter', 'Owner', k('POwner', 1), 'IdentifierType:User Identifier', { Type: 'EntityReferenceInteger' })],
    outputs: [param('OutputParameter', 'Rate', k('ORate', 1), 'BasicType:Decimal')] });
  const quote = action('ServiceAction', CS, 'Quote_Compute', KEYS.quoteCompute, { isPublic: true, inputs: [
    param('InputParameter', 'Zip', k('PZip', 2), 'BasicType:Text'), param('InputParameter', 'Amount', k('PAmount', 2), 'BasicType:Decimal')],
    outputs: [param('OutputParameter', 'Total', k('OTotal', 2), 'BasicType:Decimal')],
    nodes: [exec(k('NRate', 2), { kind: 'ServerAction', name: 'Rate_Lookup', key: KEYS.rateLookup, path: 'ServerAction:Rate_Lookup' },
      [['Zip', 'Zip'], ['Factor', '3'], ['Owner', 'GetUserId()']])] });
  const orphan = action('ServerAction', CS, 'Orphan_Private', KEYS.orphan);
  const timerOnly = action('ServerAction', CS, 'Nightly_Recalc', KEYS.timerOnly);
  const timer = { kind: 'Timer', name: 'NightlyTimer', key: KEYS.timerJob, path: 'Timer:NightlyTimer', properties: { ObjectKey: KEYS.timerJob, GlobalKey: CS.moduleKey + '*' + KEYS.timerJob },
    propertyReferences: { Action: { kind: 'ServerAction', name: 'Nightly_Recalc', key: KEYS.timerOnly, path: 'ServerAction:Nightly_Recalc' } }, children: [] };
  return [rate, quote, orphan, timerOnly, timer].map(tree => ({ schema: 'ssam-reading/1', tree }));
}
// ShopUI: reference signature of ShopCS.Quote_Compute; private server action Place_Order(Zip, Amount, Note) calls it with
// Zip pass-through, Amount pass-through; screen MainFlow.Shop: data action LoadQuotes calls Quote_Compute; client action
// BuyClick calls Place_Order via the screen stub with (model.variables.zipVar, AmountIn, "fixed note").
export function uiReadings() {
  const sig = { kind: 'ServiceActionSignature', name: 'Quote_Compute', key: KEYS.quoteSig, path: 'Reference:ShopCS/ServiceActionSignature:Quote_Compute',
    properties: { ObjectKey: KEYS.quoteSig, GlobalKey: CS.moduleKey + '*' + KEYS.quoteCompute, Name: 'Quote_Compute' }, propertyReferences: {},
    children: [param('InputParameterSignature', 'Zip', k('SZip', 3), 'BasicType:Text'), param('InputParameterSignature', 'Amount', k('SAmount', 3), 'BasicType:Decimal')] };
  const sigRef = { kind: 'ServiceActionSignature', name: 'Quote_Compute', key: KEYS.quoteSig, path: 'Reference:ShopCS/ServiceActionSignature:Quote_Compute' };
  const place = action('ServerAction', UI, 'Place_Order', KEYS.placeOrder, { inputs: [
    param('InputParameter', 'Zip', k('PZip', 4), 'BasicType:Text'), param('InputParameter', 'Amount', k('PAmount', 4), 'BasicType:Decimal'),
    param('InputParameter', 'Note', k('PNote', 4), 'BasicType:Text')],
    outputs: [param('OutputParameter', 'OrderId', k('OOrder', 4), 'BasicType:Long Integer')],
    nodes: [exec(k('NQuote', 4), sigRef, [['Zip', 'Zip'], ['Amount', 'Amount']])] });
  const data = action('DataAction', UI, 'LoadQuotes', KEYS.loadQuotes, { path: 'MobileFlow:MainFlow/MobileScreen:Shop/DataAction:LoadQuotes',
    nodes: [exec(k('NLoad', 5), sigRef, [['Zip', '"33101"'], ['Amount', 'Price']])] });
  const uiPrivate = action('ServerAction', UI, 'Ui_Unused', KEYS.uiPrivate);
  return [sig, place, data, uiPrivate].map(tree => ({ schema: 'ssam-reading/1', tree }));
}

export function uiAssets() {
  const M = UI.module, mk = UI.moduleKey;
  const mvc = `define("${M}.MainFlow.Shop.mvc$model", ["OutSystems/ClientRuntime/Main", "${M}.model"], function (OutSystems, ${M}Model) {
var OS = OutSystems.Internal;
var VariablesRecord = (function (_super) {
VariablesRecord.attributesToDeclare = function () {
return [
this.attr("Zip", "zipVar", "Zip", true, false, OS.DataTypes.DataTypes.Text, function () {
return "";
}, false)
].concat(_super.attributesToDeclare.call(this));
};
})(OS.DataTypes.GenericRecord);
return new OS.Model.ModelFactory(Model, "MainFlow.Shop");
});
define("${M}.MainFlow.Shop.mvc$view", ["OutSystems/ClientRuntime/Main", "${M}.MainFlow.Shop.mvc$model", "${M}.MainFlow.Shop.mvc$controller"], function (OutSystems, Model, Controller) {
        Object.defineProperty(View.prototype, "title", {
            get: function () {
                return "Shop";
            },
            enumerable: true,
            configurable: true
        });
});
define("${M}.MainFlow.Shop.mvc$controller", ["OutSystems/ClientRuntime/Main", "${M}.model", "${M}.controller"], function (OutSystems, ${M}Model, ${M}Controller) {
var OS = OutSystems.Internal;
var Controller = (function (_super) {
// Server Actions
Controller.prototype.place_Order$ServerAction = function (zipIn, amountIn, noteIn, callContext) {
var controller = this.controller;
var inputs = {
Zip: OS.DataConversion.ServerDataConverter.to(zipIn, OS.DataTypes.DataTypes.Text),
Amount: OS.DataConversion.ServerDataConverter.to(amountIn, OS.DataTypes.DataTypes.Decimal),
Note: OS.DataConversion.ServerDataConverter.to(noteIn, OS.DataTypes.DataTypes.Text)
};
return controller.callServerAction("Place_Order", "screenservices/${M}/MainFlow/Shop/ActionPlace_Order", "PLACEORDERAPIVERSION000", inputs, controller.callContext(callContext), OutSystemsDebugger.getRequestHeaders(callContext.id), function (json, headers) {
}, false).then(function (outputs) {
var executeServerActionResult = new (controller.constructor.getVariableGroupType("${M}.MainFlow.Shop$ActionPlace_Order"))();
executeServerActionResult.orderIdOut = OS.DataConversion.ServerDataConverter.from(outputs.OrderId, OS.DataTypes.DataTypes.LongInteger);
return executeServerActionResult;
});
};
Controller.registerVariableGroupType("${M}.MainFlow.Shop$ActionPlace_Order", [{
name: "OrderId",
attrName: "orderIdOut",
mandatory: false,
dataType: OS.DataTypes.DataTypes.LongInteger,
defaultValue: function () {
return OS.DataTypes.LongInteger.defaultValue;
}
}]);
// Aggregates and Data Actions
Controller.prototype.loadQuotes$DataActRefresh = function (callContext) {
var model = this.model;
return OS.Flow.tryFinally(function () {
OutSystemsDebugger.push("${mk}:${KEYS.loadQuotes}:/X/DataActions.${KEYS.loadQuotes}:zz", "${M}", "LoadQuotes", "NRFlows.DataScreenActionFlow", callContext.id, varBag);
return controller.callDataAction("DataActionLoadQuotes", "screenservices/${M}/MainFlow/Shop/DataActionLoadQuotes", "LOADQUOTESAPIVERSION000", function (b) {
}, function (json) {
model.variables.loadQuotesDataAct.replaceWith(OS.DataConversion.ServerDataConverter.from(json, model.variables.loadQuotesDataAct.constructor));
}, undefined, OutSystemsDebugger.getRequestHeaders(callContext.id), function (json, headers) {
}, callContext, undefined, false);
}, function () {
});
};
// Client Actions
Controller.prototype._buyClick$Action = function (amountIn, callContext) {
var varBag = {};
var vars = new OS.DataTypes.VariableHolder(new (controller.constructor.getVariableGroupType("${M}.MainFlow.Shop.BuyClick$vars"))());
vars.value.amountInLocal = amountIn;
OutSystemsDebugger.push("${mk}:${KEYS.buyClick}:/X/ClientActions.${KEYS.buyClick}:zz", "${M}", "BuyClick", "NRFlows.ClientScreenActionFlow", callContext.id, varBag);
OutSystemsDebugger.handleBreakpoint("${mk}:BUYSTARTNODEKEY0000000", callContext.id);
return OS.Flow.executeAsyncFlow(function () {
OutSystemsDebugger.handleBreakpoint("${mk}:BUYCALLNODEKEY00000000", callContext.id);
return controller.place_Order$ServerAction(model.variables.zipVar, vars.value.amountInLocal, "fixed note", callContext).then(function (value) {
});
});
};
Controller.registerVariableGroupType("${M}.MainFlow.Shop.BuyClick$vars", [{
name: "Amount",
attrName: "amountInLocal",
mandatory: true,
dataType: OS.DataTypes.DataTypes.Decimal,
defaultValue: function () {
return OS.DataTypes.Decimal.defaultValue;
}
}]);
Controller.prototype.buyClick$Action = function (amountIn, callContext) {
var controller = this.controller;
return controller.safeExecuteClientAction(controller._buyClick$Action, amountIn, callContext);
};
// Login stub of the app's own Login screen
})(OS.Controller.BaseViewController);
});
`;
  const login = `define("${M}.Common.Login.mvc$model", ["OutSystems/ClientRuntime/Main"], function (OutSystems) {
return new OS.Model.ModelFactory(Model, "Common.Login");
});
define("${M}.Common.Login.mvc$view", ["OutSystems/ClientRuntime/Main"], function (OutSystems) {
        Object.defineProperty(View.prototype, "title", {
            get: function () {
                return "Login";
            },
            enumerable: true,
            configurable: true
        });
});
define("${M}.Common.Login.mvc$controller", ["OutSystems/ClientRuntime/Main", "${M}.controller"], function (OutSystems, ${M}Controller) {
Controller.prototype.doLogin$ServerAction = function (usernameIn, passwordIn, rememberLoginIn, callContext) {
var inputs = {
Username: OS.DataConversion.ServerDataConverter.to(usernameIn, OS.DataTypes.DataTypes.Text),
Password: OS.DataConversion.ServerDataConverter.to(passwordIn, OS.DataTypes.DataTypes.Text),
RememberLogin: OS.DataConversion.ServerDataConverter.to(rememberLoginIn, OS.DataTypes.DataTypes.Boolean)
};
return controller.callServerAction("DoLogin", "screenservices/${M}/Common/Login/ActionDoLogin", "DOLOGINAPIVERSION00000", inputs, controller.callContext(callContext), OutSystemsDebugger.getRequestHeaders(callContext.id), function (json, headers) {
}, false).then(function (outputs) {
});
};
});
`;
  const moduleController = `define("${M}.controller$Slugify", ["exports", "OutSystems/ClientRuntime/Main", "${M}.model", "${M}.controller"], function (exports, OutSystems, ${M}Model, ${M}Controller) {
var OS = OutSystems.Internal;
${M}Controller.default.slugify$Action = function (textIn, callContext) {
var varBag = {};
var vars = new OS.DataTypes.VariableHolder(new (controller.constructor.getVariableGroupType("${M}.Slugify$vars"))());
vars.value.textInLocal = textIn;
var outVars = new OS.DataTypes.VariableHolder(new (controller.constructor.getVariableGroupType("${M}.Slugify$outVars"))());
try {OutSystemsDebugger.push("${mk}:${KEYS.slug}:/ClientActionFlows.${KEYS.slug}:zz", "${M}", "Slugify", "NRFlows.ClientActionFlow", callContext.id, varBag);
OutSystemsDebugger.handleBreakpoint("${mk}:SLUGSTARTNODEKEY000000", callContext.id);
outVars.value.slugOut = vars.value.textInLocal;
return outVars.value;
} finally {
OutSystemsDebugger.pop("${mk}:${KEYS.slug}", callContext.id);
}
};
var controller = ${M}Controller.default;
${M}Controller.default.constructor.registerVariableGroupType("${M}.Slugify$vars", [{
name: "Text",
attrName: "textInLocal",
mandatory: true,
dataType: OS.DataTypes.DataTypes.Text,
defaultValue: function () {
return "";
}
}]);
${M}Controller.default.constructor.registerVariableGroupType("${M}.Slugify$outVars", [{
name: "Slug",
attrName: "slugOut",
mandatory: false,
dataType: OS.DataTypes.DataTypes.Text,
defaultValue: function () {
return "";
}
}]);
});
define("${M}.controller", ["exports", "OutSystems/ClientRuntime/Main", "${M}.model"], function (exports, OutSystems, ${M}Model) {
});
`;
  return [
    { name: `${M}.MainFlow.Shop.mvc.js`, text: mvc },
    { name: `${M}.Common.Login.mvc.js`, text: login },
    { name: `${M}.controller.js`, text: moduleController },
    { name: `${M}.model.js`, text: `define("${M}.model", ["OutSystems/ClientRuntime/Main"], function (OutSystems) {\n});\n` },
    { name: `${M}.appDefinition.js`, text: `define("${M}.appDefinition", ["OutSystems/ClientRuntime/Main"], function (OutSystems) {\nreturn {\napplicationKey: "11111111-2222-4333-8444-555555555555",\nuserProviderName: "Users",\n};\n});\n` },
    { name: 'OutSystems.js', text: 'define("OutSystems/ClientRuntime/Main",["require","exports","./Logger"],function(e,t,n){}),define("OutSystems/ClientRuntime/Logger",["require","exports"],function(e,t){});\n' },
    { name: 'Debugger.js', text: "define('OutSystems/ClientRuntime/Debugger',[\"require\", \"exports\", \"./Logger\"], function (require, exports) {\n});\n" },
  ];
}
