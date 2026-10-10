using OutSystems.Model;
using OutSystems.Model.Enumerations;
using OutSystems.Model.Expressions;
using OutSystems.Model.UI;
using OutSystems.Model.Logic;
using OutSystems.Model.Logic.Nodes;
using OutSystems.Model.Types;
using OutSystems.Model.UI.Mobile;
using OutSystems.Model.UI.Mobile.Widgets;
using W = ServiceStudio.Plugin.NRWidgets;

// Shared authoring primitives for candidate builders. Extracted from the helpers that every
// delivery folder used to redeclare (CarrierOffice, NativePatch, backoffice builders).
// Everything here operates on the native Model API inside a caller-owned transaction.
internal static partial class Authoring {
    public const int X0 = 3200, Y0 = 800, Step = 1600;

    // Model traversal and property access
    public static IEnumerable<IModelObject> Walk(IModelObject root) { yield return root; foreach (var child in root.Children) foreach (var node in Walk(child)) yield return node; }
    public static ExpressionDefinition E(string expression) => ExpressionDefinition.Parse(expression);
    public static string Q(string text) => "\"" + text.Replace("\"", "\"\"") + "\"";
    // Esta era a linha mais cara do projecto. `.Single(p => p.Name == property)` atira a excepcao generica do
    // LINQ -- "Sequence contains no matching element" -- que nao diz a propriedade pedida, nem o objecto, nem o
    // que existia. Na leitura integral da sessao de 2026-09-17 (docs/ONDE-FORAM-AS-8-HORAS.md) isto aparece como
    // 180 minutos de trabalho contaminado, com a agravante de o proprio agente ter DIAGNOSTICADO a linha as 20h e
    // ela continuar intacta as 23h.
    //
    // Agora nomeia: o objecto, a propriedade pedida, as parecidas e a lista do que existe. E o mesmo contrato que
    // o kernel do Anvil ja tinha em Verbs.cs (PropertyError), trazido para ca.
    public static void Set(IModelObject target, string property, object? value) {
        var pi = Property(target, property, escrita: true);
        pi.SetValue(target, value);
    }

    public static void EX(IModelObject target, string property, string expression) => Set(target, property, E(expression));

    public static string? Text(IModelObject target, string property) {
        var value = Property(target, property, escrita: false).GetValue(target);
        return value is IExpression expression ? expression.Text : value is IModelObject reference ? reference.Key.ToString() : value?.ToString();
    }

    // Resolve a propriedade ou diz porque nao da. Nunca devolve null em silencio: um `set` que nao pega e a
    // pior coisa que esta ferramenta pode fazer, porque entrega prova falsa.
    private static OutSystems.Model.MetaModel.IProperty Property(IModelObject target, string property, bool escrita) {
        var todas = target.Descriptor.Properties;
        var encontradas = todas.Where(p => p.Name == property).ToArray();
        if (encontradas.Length == 1) return encontradas[0];
        var alvo = ModelPath.Describe(target);
        if (encontradas.Length > 1)
            throw new InvalidOperationException(
                alvo + " tem " + encontradas.Length + " propriedades chamadas '" + property + "' -- o descritor e ambiguo.");
        var nomes = todas.Select(p => p.Name).Where(n => !string.IsNullOrEmpty(n)).ToArray();
        var parecidas = NameSuggestions.Closest(property, nomes, 4);
        throw new InvalidOperationException(
            alvo + (escrita ? " nao tem a propriedade '" : " nao tem a propriedade '") + property + "'."
            + (parecidas.Count > 0 ? " Parecidas: " + string.Join(", ", parecidas) + "." : "")
            + " Tem " + nomes.Length + ": " + string.Join(", ", nomes.OrderBy(n => n, StringComparer.Ordinal).Take(40))
            + (nomes.Length > 40 ? ", ..." : ""));
    }
    // Some properties hold an expression the API refuses to render: IExpression.Text throws "Error on
    // ParsedExpression GetText: Condition is true". A targeted read should use Text and let that surface; a scan
    // over every widget of a screen has to tolerate it, which is what this is for (Inspect guards the same way).
    public static string? TextOrNull(IModelObject target, string property) { try { return Text(target, property); } catch { return null; } }
    public static void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }

    // Objects outside the element (and outside its ancestors) that still reference it. Deleting with
    // such referrers would leave dangling references, so builders refuse and name them.
    // The model derives types on its own for every entity and structure ("<Name> Record", "<Name> Record List")
    // and points the entity's built-in action signatures at them; those are owned by the element, not users of it.
    // A derived type only counts as a referrer through whoever uses the type from outside the element.
    public static IModelObject[] ExternalReferrers(IModelObject element) {
        var inside = Walk(element).ToHashSet();
        var ancestors = new HashSet<IModelObject>();
        for (var p = element.Parent; p != null; p = p.Parent) ancestors.Add(p);
        var ownKey = element.Key + ".";
        bool Owned(IModelObject r) => inside.Contains(r) || ancestors.Contains(r) || (r.Key?.ToString() ?? "").StartsWith(ownKey, StringComparison.Ordinal);
        var visitedTypes = new HashSet<IModelObject>();
        var external = new List<IModelObject>();
        void Visit(IModelObject r) {
            if (Owned(r)) return;
            var type = DerivedTypeOf(r);
            if (type == null) { external.Add(r); return; }
            if (visitedTypes.Add(type)) foreach (var user in type.Referrers) Visit(user);
        }
        foreach (var r in element.Referrers) Visit(r);
        return external.Distinct().ToArray();
    }
    private static IModelObject? DerivedTypeOf(IModelObject node) {
        for (var n = node; n != null && n is not IESpace; n = n.Parent) if (n is IAnonymousStructure || n is IListType) return n;
        return null;
    }
    public static void RequireDeletable(IModelObject element) {
        var referrers = ExternalReferrers(element);
        Require(referrers.Length == 0, ModelPath.Describe(element) + " is referenced by " + referrers.Length + " objects; refusing to delete: " + string.Join("; ", referrers.Select(ModelPath.Describe)));
    }
    // Refuses when anything outside still uses the element, then deletes it. Derived types are left to the model:
    // deleting them by hand trips the Studio's global state check ("eSpace has missing Anonymous Structures").
    public static void Delete(IModelObject element) { RequireDeletable(element); element.Delete(); }

    // Dependencies. The consumer references one public element of a producer model loaded in the same
    // model services, through the native ESpaceServicesImplementation.AddDependency the Studio itself uses.
    // The returned signature is the reference the consumer's nodes point at. fixSpecificVersion = false
    // leaves the reference free to follow the producer's next published revision.
    public static IObjectSignature AddDependency(IESpace consumer, IModelObject producerElement, bool fixSpecificVersion = false) {
        var implementation = AppDomain.CurrentDomain.GetAssemblies().Single(a => a.GetName().Name == "OutSystems.Model").GetType("ServiceStudio.Model.API.V1.ESpaceServicesImplementation", throwOnError: true)!;
        var method = implementation.GetMethods(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static).Single(m => {
            if (m.Name != "AddDependency") return false;
            var p = m.GetParameters();
            return p.Length == 3 && p[0].ParameterType.IsInstanceOfType(consumer) && p[1].ParameterType.Name == "IShareableESpaceObject" && p[1].ParameterType.IsInstanceOfType(producerElement) && p[2].ParameterType == typeof(bool);
        });
        return (IObjectSignature)(method.Invoke(null, new object[] { consumer, producerElement, fixSpecificVersion }) ?? throw new InvalidOperationException("AddDependency returned no signature for " + ModelPath.Describe(producerElement)));
    }

    // Actions and parameters
    public static IServerAction ServerAction(IESpace space, string name, string description, bool isPublic = false) {
        Require(!Walk(space).OfType<IServerAction>().Any(a => a.Name == name), "Server action already exists: " + name);
        var action = space.CreateServerAction(name); action.Public = isPublic; action.Description = description; return action;
    }
    public static IInputParameter Input(IAction action, string name, ITypeSignature type, bool mandatory = true) { var p = action.CreateInputParameter(name); p.DataType = type; p.IsMandatory = mandatory; return p; }
    public static IOutputParameter Output(IAction action, string name, ITypeSignature type) { var p = action.CreateOutputParameter(name); p.DataType = type; return p; }
    public static ILocalVariable Variable(IAction action, string name, ITypeSignature type) { var v = action.CreateLocalVariable(name); v.DataType = type; return v; }

    // Flow nodes. Chain links nodes through their single Target; If uses TrueTarget/FalseTarget.
    public static T Node<T>(IAction action, string name = "") where T : class, IActionNode => action.CreateNode<T>(name);
    public static void Chain(params IActionNode[] nodes) { for (var i = 0; i < nodes.Length - 1; i++) Set(nodes[i], "Target", nodes[i + 1]); }
    public static IAssignNode Assign(IAction action, params (string Variable, string Value)[] values) {
        var node = Node<IAssignNode>(action);
        foreach (var (variable, value) in values) { var assignment = node.CreateAssignment(); EX(assignment, "Variable", variable); EX(assignment, "Value", value); }
        return node;
    }
    public static IIfNode If(IAction action, string condition, IActionNode whenTrue, IActionNode whenFalse) { var node = Node<IIfNode>(action); node.SetCondition(E(condition)); node.TrueTarget = whenTrue; node.FalseTarget = whenFalse; return node; }
    // A loop over a list. Two connectors, and they are not the same thing: CycleTarget is the body, Target is what
    // runs after the loop. The last node of the body points back at the ForEach, which is how the cycle closes.
    public static IForEachNode ForEach(IAction action, string list, string name = "") {
        var node = Node<IForEachNode>(action, name);
        node.SetRecordList(E(list));
        return node;
    }
    // The built-in list actions (ListAppend, ListClear...) are not elements of the module, so they are reached
    // through a call the module already makes. Nothing is added to the module by using them.
    public static IActionSignature Builtin(IESpace space, string name) {
        var call = Walk(space).OfType<IExecuteClientActionNode>().FirstOrDefault(n => n.Action != null && n.Action.DisplayName == name)?.Action
            ?? Walk(space).OfType<IExecuteServerActionNode>().FirstOrDefault(n => n.Action != null && n.Action.DisplayName == name)?.Action;
        Require(call != null, "The module makes no call to the built-in " + name + ", so its signature cannot be reached this way");
        return call!;
    }
    public static IExecuteServerActionNode CallServer(IAction action, string name, IActionSignature target, params (string Argument, string Value)[] arguments) {
        var node = Node<IExecuteServerActionNode>(action, name); node.Action = target;
        foreach (var (argument, value) in arguments) node.Arguments.Single(x => x.DisplayName == argument).SetValue(E(value));
        return node;
    }
    public static IExecuteClientActionNode CallClient(IAction action, string name, IActionSignature target) { var node = Node<IExecuteClientActionNode>(action, name); node.Action = target; return node; }
    public static IMessageNode Message(IAction action, string text, bool error = false) { var node = Node<IMessageNode>(action); node.SetMessage(E(Q(text))); node.Type = error ? MessageType.Error : MessageType.Success; return node; }
    public static IRaiseExceptionNode Raise(IAction action, IException exception, string message) { var node = Node<IRaiseExceptionNode>(action); node.Exception = exception; node.SetExceptionMessage(E(Q(message))); return node; }
    public static IExceptionHandlerNode CatchAll(IAction action, IESpace space, string name = "HandleFailure") { var handler = Node<IExceptionHandlerNode>(action, name); handler.Exception = space.AllExceptions; handler.LogError = true; return handler; }

    // Screens and widgets. Widget parents are contents (screens, blocks, containers) or placeholders.
    public static IMobileScreen Screen(IMobileFlow flow, string name, string description, bool anonymous) {
        var screen = flow.CreateScreen(name); screen.Description = description; screen.AnonymousAccess = anonymous; return screen;
    }
    public static T Widget<T>(IObject parent, string name) where T : class, IMobileWidget => parent switch {
        IMobileScreen screen => screen.CreateWidget<T>(name, null),
        IMobileBlock block => block.CreateWidget<T>(name, null),
        IContent content => content.CreateWidget<T>(name),
        // The branches of a screen If are widget parents in their own right, not contents.
        IIfBranchWidget branch => branch.CreateWidget<T>(name, null),
        IPlaceholderContentWidget placeholder => (T)placeholder.CreateWidget(typeof(T), name),
        // Some widgets hold their children themselves rather than through a Content: a Button Group holds its
        // items. Creating one in the Content instead compiles, validates and is then dropped on save without a
        // word, which is how an empty group reached the Studio on 17/09, twice.
        _ => Child<T>(parent, name)
    };
    // A pattern widget of a producer -- a Button Group Item, say -- is created from the definition the reference
    // publishes, not from its interface: created from the interface it exists in memory, passes validation and is
    // then dropped on save without a word.
    public static IWidgetDefinitionSignature WidgetDefinition(IESpace space, string name) {
        var all = space.References.SelectMany(r => r.WidgetDefinitions).ToArray();
        var found = all.FirstOrDefault(d => string.Equals(d.Name, name, StringComparison.OrdinalIgnoreCase));
        Require(found != null, "No widget definition named " + name + "; the references publish: " +
            string.Join(", ", all.Select(d => d.Name).OrderBy(n => n)));
        return found!;
    }
    public static T Widget<T>(IObject parent, string name, IWidgetDefinitionSignature definition) where T : class, IMobileWidget {
        var create = parent.GetType().GetInterfaces().SelectMany(i => i.GetMethods())
            .FirstOrDefault(m => m.Name == "CreateWidget" && m.GetParameters().Length == 3
                && typeof(IWidgetDefinitionSignature).IsAssignableFrom(m.GetParameters()[0].ParameterType));
        Require(create != null, parent.GetType().Name + " cannot hold a pattern widget");
        return (T)create!.Invoke(parent, new object?[] { definition, name, null })!;
    }

    private static T Child<T>(IObject parent, string name) where T : class, IMobileWidget {
        // The interfaces, not the class: the implementation is explicit, so the concrete type does not list it.
        // The generic overload first: it is the one every other widget parent is created through.
        var methods = parent.GetType().GetInterfaces().SelectMany(i => i.GetMethods()).Where(m => m.Name == "CreateWidget").ToArray();
        var generic = methods.FirstOrDefault(m => m.IsGenericMethodDefinition && m.GetParameters().Length == 2);
        if (generic != null) return (T)generic.MakeGenericMethod(typeof(T)).Invoke(parent, new object?[] { name, null })!;
        var byType = methods.FirstOrDefault(m => !m.IsGenericMethodDefinition && m.GetParameters().Length == 3 && m.GetParameters()[0].ParameterType == typeof(Type));
        Require(byType != null, "Unsupported widget parent: " + parent.GetType().Name);
        return (T)byType!.Invoke(parent, new object?[] { typeof(T), name, null })!;
    }
    public static W.IContainer Container(IObject parent, string name, string css = "") { var box = Widget<W.IContainer>(parent, name); box.Width = "(fill parent)"; if (css != "") box.SetStyle(E(Q(css))); return box; }
    public static W.IExpression Expression(IObject parent, string name, string expression, string css = "") { var text = Widget<W.IExpression>(parent, name); text.SetValue(E(expression)); if (css != "") text.SetStyle(E(Q(css))); return text; }

    // One native adapter and geometry for kernel jobs and feature builders.
    public static int Layout(IAction action) => Anvil.Core.FlowLayout.Apply(action).Moved;
    public static int Layout(IDataAction action) => Layout(action.Nodes.OfType<IFlowNode>().ToArray());
    public static int Layout(IFlowNode[] nodes) => Anvil.Core.FlowLayout.Apply(nodes, "builder flow").Moved;
    // What the builder runs after Apply, and the reason a feature can no longer deliver a broken flow: every flow
    // the feature touched is laid out, whether the feature asked for it or not. "Touched" is decided by the stamps
    // the builder took before Apply: a flow with a node that is new, or whose LastModifiedDate changed, is laid
    // out; a flow the feature did not touch is left exactly as it was, so no candidate carries a reposition nobody
    // asked for. This replaces the older net, which only fixed flows whose nodes overlapped and so let a
    // hand-positioned flow through in whatever order its nodes happened to be created.
    public static string[] LayoutTouched(IESpace space, IReadOnlyDictionary<string, string?> before) {
        var laidOut = new List<string>();
        bool Touched(IEnumerable<IFlowNode> nodes) => nodes.Any(n => {
            var key = n.Key?.ToString();
            if (key == null || !before.ContainsKey(key)) return true;
            return before[key] != (n.Descriptor.Properties.SingleOrDefault(p => p.Name == "LastModifiedDate")?.GetValue(n)?.ToString());
        });
        void Consider(IModelObject flow, IFlowNode[] nodes) {
            if (nodes.Length < 2 || !Touched(nodes)) return;
            if (Layout(nodes) > 0) laidOut.Add(ModelPath.Describe(flow));
        }
        foreach (var action in Walk(space).OfType<IAction>()) Consider(action, action.Nodes.OfType<IFlowNode>().ToArray());
        foreach (var data in Walk(space).OfType<IDataAction>()) Consider(data, data.Nodes.OfType<IFlowNode>().ToArray());
        return laidOut.ToArray();
    }
}
