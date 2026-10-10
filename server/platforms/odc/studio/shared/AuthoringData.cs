using OutSystems.Model;
using OutSystems.Model.Data;
using OutSystems.Model.Enumerations;
using OutSystems.Model.Logic;
using OutSystems.Model.Logic.Aggregates;
using OutSystems.Model.Logic.Aggregates.Full;
using OutSystems.Model.Logic.Nodes;
using OutSystems.Model.Types;
using OutSystems.Model.UI.Mobile;

// Data primitives: entities, static entities, structures, list types and aggregates. Every call operates on the
// native Model API inside a caller-owned transaction. Patterns come from the deliveries of 14 to 16/09 (carrier
// tables, question defaults, backoffice) and from the reflection index in docs\model-api.
internal static partial class Authoring {
    // ---- Entities
    // A server entity with a LongInteger auto-number identifier named Id, private to the module.
    public static IServerEntity Entity(IESpace space, string name, string description, bool exposeReadOnly = false) {
        Require(!Walk(space).OfType<IEntity>().Any(e => e.Name == name), "Entity already exists: " + name);
        var entity = space.CreateServerEntity(name);
        entity.Description = description; entity.Public = false; entity.ExposeReadOnly = exposeReadOnly;
        var id = entity.CreateAttribute("Id"); id.DataType = space.LongIntegerType; id.IsMandatory = true; id.IsAutoNumber = AutoNumber.Yes;
        entity.IdentifierAttribute = id;
        return entity;
    }
    public static IEntityAttribute Attribute(IEntity entity, string name, IBasicType type, int? length = null, bool mandatory = false, int? decimals = null, string? defaultValue = null, string? description = null) {
        var attribute = entity.CreateAttribute(name);
        attribute.DataType = type; attribute.IsMandatory = mandatory;
        if (length != null) attribute.Length = length;
        if (decimals != null) attribute.Decimals = decimals;
        if (defaultValue != null) attribute.SetDefaultValue(E(defaultValue));
        if (description != null) attribute.Description = description;
        return attribute;
    }
    // A reference attribute typed with the target entity's identifier; Protect keeps referenced rows from deletion.
    public static IEntityAttribute ForeignKey(IEntity entity, string name, IEntity target, bool mandatory = false, DeleteRule rule = DeleteRule.Protect) {
        var attribute = entity.CreateAttribute(name);
        attribute.DataType = target.IdentifierType; attribute.IsMandatory = mandatory; attribute.IsAutoNumber = AutoNumber.No; attribute.DeleteRule = rule;
        return attribute;
    }
    // A static entity with the conventional Id (Text), Label, Order and Is_Active attributes and its records.
    public static IStaticEntity StaticEntity(IESpace space, string name, string description, params (string Id, string Label)[] records) {
        Require(!Walk(space).OfType<IEntity>().Any(e => e.Name == name), "Entity already exists: " + name);
        var entity = space.CreateStaticEntity(name);
        entity.Description = description; entity.Public = false;
        var id = entity.CreateAttribute("Id"); id.DataType = space.TextType; id.Length = 50; id.IsMandatory = true; entity.IdentifierAttribute = id;
        var label = entity.CreateAttribute("Label"); label.DataType = space.TextType; label.Length = 100; label.IsMandatory = true; entity.LabelAttribute = label;
        var order = entity.CreateAttribute("Order"); order.DataType = space.IntegerType; order.IsMandatory = true; entity.OrderByAttribute = order;
        var active = entity.CreateAttribute("Is_Active"); active.DataType = space.BooleanType; active.IsMandatory = true; active.SetDefaultValue(E("True")); entity.IsActiveAttribute = active;
        var position = 0;
        foreach (var (recordId, recordLabel) in records) {
            position++;
            var record = entity.CreateRecord(recordId);
            foreach (var value in record.AttributeValues)
                value.SetValue(E(value.Attribute.Name switch { "Id" => Q(recordId), "Label" => Q(recordLabel), "Order" => position.ToString(), "Is_Active" => "True", var other => throw new InvalidOperationException("Unexpected static entity attribute " + other) }));
        }
        return entity;
    }
    // ---- Structures
    public static IStructure Structure(IESpace space, string name, string description, params (string Name, ITypeSignature Type)[] attributes) {
        Require(!Walk(space).OfType<IStructure>().Any(s => s.Name == name), "Structure already exists: " + name);
        var structure = space.CreateStructure(name);
        structure.Description = description;
        foreach (var (attributeName, type) in attributes) Attribute(structure, attributeName, type);
        return structure;
    }
    public static IStructureAttribute Attribute(IStructure structure, string name, ITypeSignature type, int? length = null, bool mandatory = false, string? defaultValue = null) {
        var attribute = structure.CreateAttribute(name);
        attribute.DataType = type; attribute.IsMandatory = mandatory;
        if (length != null) attribute.Length = length;
        if (defaultValue != null) attribute.SetDefaultValue(E(defaultValue));
        return attribute;
    }
    public static IListType ListOf(IESpace space, ITypeSignature elementType) => space.GetOrCreateListType(elementType);
    // Never delete AnonymousStructures or ListTypes by hand, even when nothing refers to them: the transaction's
    // global state check fails with "eSpace has missing Anonymous Structures". The model owns their lifecycle.

    // ---- Aggregates. One source, optional filter and sort, no cache. Outputs read as <Name>.List, <Name>.List.Length,
    // <Name>.List.Current.<Entity>.<Attribute>. filter and sort are expressions in the aggregate's own scope.
    public static IAggregateNode Aggregate(IAction action, string name, IEntity entity, string? filter = null, string? sort = null, int maxRecords = 100) {
        var node = Node<IAggregateNode>(action, name);
        Fill(node, entity, filter, sort, maxRecords);
        return node;
    }
    public static IScreenAggregate ScreenAggregate(IMobileScreen screen, string name, IEntity entity, string? filter = null, string? sort = null, bool onDemand = false, int maxRecords = 100) {
        var aggregate = screen.CreateScreenAggregate(false, name);
        aggregate.Fetch = onDemand ? DataSourceFetch.OnDemand : DataSourceFetch.AtStart;
        Fill(aggregate, entity, filter, sort, maxRecords);
        return aggregate;
    }
    private static void Fill(IAggregate aggregate, IEntity entity, string? filter, string? sort, int maxRecords) {
        aggregate.CacheInMinutes = 0;
        aggregate.SetMaxRecords(E(maxRecords.ToString()));
        var full = (IFullAggregate)aggregate;
        var root = full.CreateCombineSourcesOperation();
        root.CreateSource((IDataSource)entity, entity.Name);
        if (filter != null) root.CreateFilter().SetCondition(E(filter));
        if (sort != null) root.CreateSort().SetAttribute(E(sort));
        full.RootOperation = root;
    }
    public static IRefreshDataNode Refresh(IAction action, IObject dataSource) { var node = Node<IRefreshDataNode>(action); node.DataSource = dataSource; return node; }

    // ---- Client and screen logic
    public static IClientAction ClientAction(IESpace space, string name, string description, bool isPublic = false) {
        Require(!Walk(space).OfType<IClientAction>().Any(a => a.Name == name), "Client action already exists: " + name);
        var action = space.CreateClientAction(name); action.Description = description; action.Public = isPublic; return action;
    }
    public static IScreenAction ScreenAction(IMobileScreen screen, string name) {
        Require(!screen.ScreenActions.Any(a => a.Name == name), "Screen action already exists: " + name);
        return screen.CreateScreenAction(name);
    }
    public static ILocalVariable ScreenVariable(IMobileScreen screen, string name, ITypeSignature type, string? defaultValue = null) {
        var variable = screen.CreateLocalVariable(name); variable.DataType = type;
        if (defaultValue != null) variable.SetDefaultValue(E(defaultValue));
        return variable;
    }
    public static IJavaScriptNode JavaScript(IAction action, string name, string code) { var node = Node<IJavaScriptNode>(action, name); node.JavaScript = code; return node; }
}
