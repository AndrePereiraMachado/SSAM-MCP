using OutSystems.Model;
using OutSystems.Model.Logic;
using OutSystems.Model.Logic.Nodes;
using OutSystems.Model.Types;
using OutSystems.Model.UI;
using OutSystems.Model.UI.Mobile;
using OutSystems.Model.UI.Mobile.Widgets;
using W = ServiceStudio.Plugin.NRWidgets;
using WE = ServiceStudio.Plugin.NRWidgets.Enumerations;

// Interface primitives beyond container and expression: captions, form, input, label, button, link, list, icon,
// static text, extended properties, style sheets, and blocks (definition, inputs, events, instances, handlers).
// Widget parents are screens, blocks or contents (a container's Content, a button's Content, a list's ListItem).
internal static partial class Authoring {
    // ---- Captions. A button, link or label created by CreateWidget already carries a default Text widget
    // ("Button", "Save", "label"); the caption replaces that text instead of adding a second one beside it.
    // Lesson from 16/09: an Expression added next to the default text rendered as "Button Drop pin here".
    public static ITextWidget Caption(IObject content, string text, string css = "") {
        var caption = content.Children.OfType<ITextWidget>().FirstOrDefault() ?? Widget<ITextWidget>(content, "Text");
        caption.Text = text;
        if (css != "") caption.SetStyleClasses(E(Q(css)));
        return caption;
    }
    public static ITextWidget StaticText(IObject parent, string name, string text, string css = "") { var t = Widget<ITextWidget>(parent, name); t.Text = text; if (css != "") t.SetStyleClasses(E(Q(css))); return t; }
    public static W.IForm Form(IObject parent, string name, string css = "") { var form = Widget<W.IForm>(parent, name); if (css != "") form.SetStyle(E(Q(css))); return form; }
    // An input bound to a variable expression (a screen local variable, a record attribute, ...). The prompt is the
    // placeholder; a separate label is only needed when the design shows one.
    public static W.IInput Input(IObject parent, string name, string variable, string prompt = "", bool mandatory = false, int? maxLength = null, WE.InputType? inputType = null, string? width = null) {
        var input = Widget<W.IInput>(parent, name);
        input.SetVariable(E(variable));
        if (prompt != "") input.SetPrompt(E(Q(prompt)));
        input.SetMandatory(mandatory);
        if (maxLength != null) input.MaxLength = maxLength;
        if (inputType != null) input.InputType = inputType.Value;
        if (width != null) input.Width = width;
        return input;
    }
    public static W.ILabel Label(IObject parent, string name, string text, IMobileWidget? target = null) {
        var label = Widget<W.ILabel>(parent, name);
        Caption(label.Content, text);
        if (target != null) label.TargetWidget = target;
        return label;
    }
    // A button whose click runs a screen or client action. css "btn" is the outlined button, "btn btn-primary" the filled one.
    public static W.IButton Button(IObject parent, string name, string text, IObjectSignature? onClick = null, string css = "", string? width = null) {
        var button = Widget<W.IButton>(parent, name);
        Caption(button.Content, text);
        if (onClick != null) button.OnClick.Destination = onClick;
        if (css != "") button.SetStyle(E(Q(css)));
        if (width != null) button.Width = width;
        return button;
    }
    public static W.ILink Link(IObject parent, string name, string text, IObjectSignature? onClick = null) {
        var link = Widget<W.ILink>(parent, name);
        Caption(link.Content, text);
        if (onClick != null) link.OnClick.Destination = onClick;
        return link;
    }
    // The platform's own select, bound straight to a variable: no event and no handler on the consumer, which is
    // the whole point of using it instead of a block that renders its own control and reports the click.
    // List is the source, and Values and Labels are read per element (Id and Label for a WFChoice).
    public static W.IDropdown Dropdown(IObject parent, string name, string variable, string list,
        string values = "Id", string labels = "Label", bool mandatory = false, string? width = null) {
        var dropdown = Widget<W.IDropdown>(parent, name);
        EX(dropdown, "Variable", variable);
        EX(dropdown, "List", list);
        EX(dropdown, "Values", values);
        EX(dropdown, "Labels", labels);
        EX(dropdown, "Mandatory", mandatory ? "True" : "False");
        if (width != null) dropdown.Width = width;
        return dropdown;
    }

    // Single choice without a screen action: the group holds the variable, each radio the value it stands for, and
    // clicking writes the variable. The label around the radio carries the classes the buttons had, so the group
    // looks like the button group it replaces, and the list over the catalogue stays a list -- the native Button
    // Group cannot be authored here at all (see the measurements in docs\HANDOFF.md).
    public static W.IRadioGroup RadioGroup(IObject parent, string name, string variable, string css = "", bool mandatory = false, string? width = null) {
        var group = Widget<W.IRadioGroup>(parent, name);
        group.SetVariable(E(variable));
        group.SetMandatory(mandatory);
        if (css != "") EX(group, "Style", css);
        if (width != null) group.Width = width;
        return group;
    }
    // One option. The radio itself is hidden: what the user clicks is the label around it, which is also what
    // carries the selected state, read from the variable the radio writes.
    public static W.IRadioButton Radio(IObject parent, string name, string value, string css = "") {
        var radio = Widget<W.IRadioButton>(parent, name);
        radio.SetValue(E(value));
        if (css != "") EX(radio, "Style", css);
        return radio;
    }
    // ---- Placeholders: the hole a block leaves for the consumer to fill. The definition side is a widget in the
    // block; the consumer side appears on every instance as a content widget named after it, which is a widget
    // parent like any other. This is how one field block can carry the label, the help text and the validation
    // while the control that writes the answer lives on the screen, next to the variable it writes.
    public static IPlaceholderWidget Placeholder(IObject parent, string name) => Widget<IPlaceholderWidget>(parent, name);
    public static IPlaceholderContentWidget PlaceholderContent(IMobileBlockInstanceWidget instance, string name) {
        var content = instance.Children.OfType<IPlaceholderContentWidget>().FirstOrDefault(c => c.Placeholder?.Name == name);
        Require(content != null, "Block instance " + instance.Name + " has no placeholder " + name + "; it has: " +
            string.Join(", ", instance.Children.OfType<IPlaceholderContentWidget>().Select(c => c.Placeholder?.Name ?? "?")));
        return content!;
    }

    // A list over a source expression such as GetCustomers.List; add row widgets to list.ListItem.
    public static W.IList List(IObject parent, string name, string source) { var list = Widget<W.IList>(parent, name); list.SetSource(E(source)); return list; }
    // Icon names are Phosphor 2.0 names ("warning-circle", "check-circle"); the weight is part of the lookup, so it is
    // never left empty: without it the Studio reports "Non Existing Icon" (live warning seen on 16/09).
    public static W.IIcon Icon(IObject parent, string name, string icon, string css = "", string weight = "regular") {
        var widget = Widget<W.IIcon>(parent, name); widget.Icon = icon; widget.Weight = weight;
        if (css != "") widget.SetStyle(E(Q(css)));
        return widget;
    }
    // The screen If: one widget, two branches, and the condition decides which one renders. It is how a screen
    // shows or hides a part of itself; note that a block instance has no Visible property of its own, so an If (or
    // a container around it) is the only way to make an instance appear and disappear.
    // Widgets go into widget.TrueBranch / widget.FalseBranch, which are widget parents, not contents.
    public static IIfWidget IfWidget(IObject parent, string name, string condition) {
        var widget = Widget<IIfWidget>(parent, name);
        widget.SetCondition(E(condition));
        return widget;
    }

    // An HTML attribute on a widget, such as role="alert" or data-testid. CreateExtendedProperty is declared per
    // widget interface (container, text, icon...), not on IMobileWidget, so it is reached through the concrete type.
    public static void ExtendedProperty(IMobileWidget widget, string property, string value) => ExtendedPropertyExpression(widget, property, Q(value));
    // The same, when the attribute's value is an expression in the widget's scope rather than a literal, which is
    // how a block's chrome tags its parts with the field key it was given (data-wf-field = FieldKey).
    public static void ExtendedPropertyExpression(IMobileWidget widget, string property, string expression) {
        var create = widget.GetType().GetMethod("CreateExtendedProperty", Type.EmptyTypes)
            ?? widget.GetType().GetInterfaces().Select(i => i.GetMethod("CreateExtendedProperty", Type.EmptyTypes)).FirstOrDefault(m => m != null);
        Require(create != null, "Widget " + widget.DisplayName + " (" + widget.GetInterface().Name + ") has no extended properties.");
        var extended = (IModelObject)create!.Invoke(widget, null)!;
        Set(extended, "Property", property); EX(extended, "Value", expression);
    }
    // CSS appended to a screen, or to a theme of the module (usually the app theme).
    public static void ScreenCss(IMobileScreen screen, string css) => screen.StyleSheet = string.IsNullOrWhiteSpace(screen.StyleSheet) ? css : screen.StyleSheet.TrimEnd() + "\n" + css;
    public static IMobileTheme Theme(IESpace space, string name) => Walk(space).OfType<IMobileTheme>().Single(t => t.Name == name);
    public static void ThemeCss(ITheme theme, string css) => theme.StyleSheet = string.IsNullOrWhiteSpace(theme.StyleSheet) ? css : theme.StyleSheet.TrimEnd() + "\n" + css;

    // ---- Blocks: reusable UI with input parameters, local variables, events raised to the screen that hosts
    // the instance, and instances placed on screens or inside other widgets.
    public static IMobileFlow Flow(IESpace space, string name) => Walk(space).OfType<IMobileFlow>().Single(f => f.Name == name);
    public static IMobileBlock Block(IMobileFlow flow, string name, string description) {
        Require(!Walk(flow).OfType<IMobileBlock>().Any(b => b.Name == name), "Block already exists: " + name);
        var block = flow.CreateBlock(name); block.Description = description; return block;
    }
    public static IInputParameter BlockInput(IMobileBlock block, string name, ITypeSignature type, bool mandatory = false) { var p = block.CreateInputParameter(name); p.DataType = type; p.IsMandatory = mandatory; return p; }
    public static ILocalVariable BlockVariable(IMobileBlock block, string name, ITypeSignature type, string? defaultValue = null) {
        var variable = block.CreateLocalVariable(name); variable.DataType = type;
        if (defaultValue != null) variable.SetDefaultValue(E(defaultValue));
        return variable;
    }
    public static IBlockEvent BlockEvent(IMobileBlock block, string name, params (string Name, ITypeSignature Type)[] parameters) {
        var blockEvent = block.CreateEvent(name);
        foreach (var (parameterName, type) in parameters) { var p = blockEvent.CreateInputParameter(parameterName); p.DataType = type; }
        return blockEvent;
    }
    public static IScreenAction BlockAction(IMobileBlock block, string name) {
        Require(!block.ScreenActions.Any(a => a.Name == name), "Block action already exists: " + name);
        return block.CreateScreenAction(name);
    }
    // Raises a block event from a block action; argument values are expressions in the action's scope, by parameter name.
    public static ITriggerNode Trigger(IAction action, IBlockEvent blockEvent, params (string Argument, string Value)[] arguments) {
        var node = Node<ITriggerNode>(action, blockEvent.DisplayName); node.Event = blockEvent;
        foreach (var (argument, value) in arguments) node.Arguments.Single(a => a.DisplayName == argument).SetValue(E(value));
        return node;
    }
    // An instance of a block on a screen or inside a widget; argument values are expressions in the host's scope.
    public static IMobileBlockInstanceWidget BlockInstance(IObject parent, string name, IMobileBlock block, params (string Argument, string Value)[] arguments) {
        var instance = Widget<IMobileBlockInstanceWidget>(parent, name); instance.SourceBlock = block;
        foreach (var (argument, value) in arguments) instance.Arguments.Single(a => a.DisplayName == argument).SetValue(E(value));
        return instance;
    }
    // Routes a block event of an instance to a screen action whose input parameters mirror the event's.
    public static void Handle(IMobileBlockInstanceWidget instance, string eventName, IObjectSignature handler) {
        var slot = instance.EventHandlers.SingleOrDefault(h => h.Event.DisplayName == eventName);
        Require(slot != null, "Block instance " + instance.Name + " has no event " + eventName + "; events: " + string.Join(", ", instance.EventHandlers.Select(h => h.Event.DisplayName)));
        slot!.Handler = handler;
    }
}
