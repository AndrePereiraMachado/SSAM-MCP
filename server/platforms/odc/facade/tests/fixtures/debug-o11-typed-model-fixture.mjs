// Synthetic O11 published model assets for typed inputs. Names are invented; the shapes follow the compiler output
// observed in public assets: record classes (<M>.model$XRec, attributesToDeclare/this.attr), record lists
// (<M>.model$XList, itemType = <M>Model.XRec), the basic Text List in the anonymous "<M>.model$" define
// (itemType = OS.DataTypes.DataTypes.Text), runtime basic lists (OS.DataTypes.IntegerList) and a module whose
// "model$TextList" is a list of a Text STRUCTURE (Extension Text), which must never be taken for a basic list.

const attr = (name, attrName, type, extra = '') => `this.attr("${name}", "${attrName}", "${name}", false, false, OS.DataTypes.DataTypes.${type}, function () {
return null;
}, true${extra})`;
const record = (define, alias, deps, params, cls, attributes) => `define("${define}", ["exports", "OutSystems/ClientRuntime/Main"${deps}], function (exports, OutSystems${params}) {
var OS = OutSystems.Internal;
var ${cls} = (function (_super) {
__extends(${cls}, _super);
function ${cls}(defaults) {
_super.apply(this, arguments);
}
${cls}.attributesToDeclare = function () {
return [
${attributes.join(', \n')}
].concat(_super.attributesToDeclare.call(this));
};
${cls}.init();
return ${cls};
})(OS.DataTypes.GenericRecord);
${alias}.${cls} = ${cls};

});
`;
const list = (define, alias, deps, params, cls, item) => `define("${define}", ["exports", "OutSystems/ClientRuntime/Main"${deps}], function (exports, OutSystems${params}) {
var OS = OutSystems.Internal;
var ${cls} = (function (_super) {
__extends(${cls}, _super);
function ${cls}(defaults) {
_super.apply(this, arguments);
}
${cls}.itemType = ${item};
return ${cls};
})(OS.DataTypes.GenericRecordList);
${alias}.${cls} = ${cls};

});
`;

export function typedModelAssets() {
  const shop = ', "ShopUI.model"', shopP = ', ShopUIModel';
  const model = [
    list('ShopUI.model$', 'ShopUIModel', shop, shopP, 'TextList', 'OS.DataTypes.DataTypes.Text'),
    record('ShopUI.model$LineRec', 'ShopUIModel', shop, shopP, 'LineRec', [attr('Sku', 'skuAttr', 'Text'), attr('Qty', 'qtyAttr', 'Integer'),
      attr('Ref', 'refAttr', 'LongInteger'), attr('Price', 'priceAttr', 'Decimal'), attr('At', 'atAttr', 'DateTime'), attr('Blob', 'blobAttr', 'BinaryData'),
      attr('Tags', 'tagsAttr', 'RecordList', ', OS.DataTypes.TextList')]),
    list('ShopUI.model$LineList', 'ShopUIModel', shop + ', "ShopUI.model$LineRec"', shopP, 'LineList', 'ShopUIModel.LineRec'),
    record('ShopUI.model$OrderRec', 'ShopUIModel', shop + ', "ShopUI.model$LineRec", "ShopUI.model$LineList"', shopP, 'OrderRec', [attr('Id', 'idAttr', 'LongInteger'),
      attr('Note', 'noteAttr', 'Text'), attr('Main', 'mainAttr', 'Record', ', ShopUIModel.LineRec'), attr('Lines', 'linesAttr', 'RecordList', ', ShopUIModel.LineList'),
      attr('Payload', 'payloadAttr', 'Object')]),
    `define("ShopUI.model", ["exports", "OutSystems/ClientRuntime/Main"], function (exports, OutSystems) {\n});\n`,
  ].join('');
  const controller = `define("ShopUI.controller$AddLines", ["exports", "OutSystems/ClientRuntime/Main", "ShopUI.model", "ShopUI.controller", "ShopUI.model$LineList"], function (exports, OutSystems, ShopUIModel, ShopUIController) {
var OS = OutSystems.Internal;
ShopUIController.default.addLines$Action = function (linesIn, callContext) {
var varBag = {};
var vars = new OS.DataTypes.VariableHolder(new (controller.constructor.getVariableGroupType("ShopUI.AddLines$vars"))());
vars.value.linesInLocal = linesIn;
try {OutSystemsDebugger.push("SHOPSHOPSHOPSHOPSHOPSH:ADDLINESADDLINESADDLIN:/ClientActionFlows.x:zz", "ShopUI", "AddLines", "NRFlows.ClientActionFlow", callContext.id, varBag);
return;
} finally {
OutSystemsDebugger.pop("SHOPSHOPSHOPSHOPSHOPSH:ADDLINESADDLINESADDLIN", callContext.id);
}
};
var controller = ShopUIController.default;
ShopUIController.default.constructor.registerVariableGroupType("ShopUI.AddLines$vars", [{
name: "Lines",
attrName: "linesInLocal",
mandatory: true,
dataType: OS.DataTypes.DataTypes.RecordList,
defaultValue: function () {
return new ShopUIModel.LineList();
},
complexType: ShopUIModel.LineList
}]);
});
define("ShopUI.controller", ["exports", "OutSystems/ClientRuntime/Main", "ShopUI.model"], function (exports, OutSystems, ShopUIModel) {
});
`;
  const trap = [
    record('Ext.model$TextRec', 'ExtModel', ', "Ext.model"', ', ExtModel', 'TextRec', [attr('Text', 'textAttr', 'Text')]),
    `define("Ext.model", ["exports", "OutSystems/ClientRuntime/Main"], function (exports, OutSystems) {\n});\n`,
    list('Trap.model$TextList', 'TrapModel', ', "Ext.model", "Trap.model", "Ext.model$TextRec"', ', ExtModel, TrapModel', 'TextList', 'ExtModel.TextRec'),
    `define("Trap.model", ["exports", "OutSystems/ClientRuntime/Main"], function (exports, OutSystems) {\n});\n`,
  ].join('');
  return [{ name: 'ShopUI.model.js', text: model }, { name: 'ShopUI.controller.js', text: controller }, { name: 'Trap.model.js', text: trap }];
}
