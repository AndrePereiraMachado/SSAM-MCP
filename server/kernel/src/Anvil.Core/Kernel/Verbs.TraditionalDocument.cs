using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Reading;
using OutSystems.Model;
using OutSystems.Model.UI;

namespace Anvil.Core;

public sealed partial class ModelSession
{
    // The Traditional front end shares the html document entry and native mutation primitives.
    // Its widget model is distinct from Mobile: never send Mobile widgets or DefaultScreen to it.
    private sealed class TraditionalDocumentCompiler(ModelSession s, string source, DocumentOptions options)
    {
        private readonly List<ScreenDocument.Problem> problems = [];
        private readonly JsonArray written = [];
        // k of the reading the document is based on -> the ObjectKey of what this document made for it (a recreation
        // repoints the consumers of the original by it; ScreenRecreationProof compares the readings by it).
        private readonly JsonObject keys = [];
        private void Keyed(ScreenHtml.Node node, IObjectSignature item) { if (node.Get("k") is { Length: > 0 } k) keys[k] = item.ObjectKey!.ToString(); }
        private IObjectSignature? root, entry;
        private readonly List<(IObjectSignature Label, string For)> labels = [];
        private int sequence;
        private const string WebText = "OutSystems.Model.UI.Web.Widgets.ITextWidget";
        private static readonly Dictionary<string, string> Types = new(StringComparer.Ordinal) {
            ["div"] = "IContainerWidget", ["span"] = "IContainerWidget", ["a"] = "ILinkWidget",
            ["button"] = "IButtonWidget", ["input"] = "IInputWidget", ["textarea"] = "IInputWidget",
            ["table"] = "ITableWidget", ["tr"] = "IRowWidget", ["td"] = "ICellWidget",
            ["table-records"] = "ITableRecordsWidget", ["list-records"] = "IListRecordsWidget",
            ["Block"] = "IWebBlockInstanceWidget", ["form"] = "ServiceStudio.Plugin.Widgets.IForm",
            ["checkbox-input"] = "ICheckBoxWidget", ["password-input"] = "IInputPasswordWidget",
            ["radio-input"] = "IRadioButtonWidget", ["select"] = "IComboBoxWidget",
            ["img"] = "IImageWidget", ["upload"] = "IInputFilenameWidget", ["label"] = "ServiceStudio.Plugin.Widgets.ILabel",
            ["text"] = WebText, ["expr"] = "IExpressionWidget"
        };
        private void Problem(ScreenHtml.Node node, string message) => problems.Add(new(ScreenDocument.Traditional,
            node.Line, node.Column, message, "Traditional supports div/span, text and {{ expressions }} (expr value/example), input/textarea/checkbox/password/radio with bind and onchange, form record, select bind/options/source-entity/source-attribute, button/a with onclick, img, upload, table/tr/td, table-records/list-records with source/line-count/start-index (table slots HeaderRow/DataRow), Block/slot, div if/else and list; use the installed component contract for other widgets."));
        private static bool Data(ScreenHtml.Node n) => n.Tag == "var" || n.Tag == "input" && n.Get("bind") == null;
        // The attributes the language spends on its own rows: misplaced, they are refused; any other plain name on a
        // widget is an extended property of that widget, as the reader prints them (OSTagName="h1" on an expression).
        private static readonly HashSet<string> Language = new(StringComparer.Ordinal) { "k", "id", "name", "class", "style", "if", "else", "list",
            "onclick", "method", "validation", "type", "bind", "placeholder", "mandatory", "required", "maxlength", "rows", "onchange", "enabled", "value",
            "record", "editable", "source-entity", "source-attribute", "options", "label", "empty", "empty-value", "source", "line-count", "start-index", "example", "for", "onnotify",
            "flow", "title", "description", "roles", "actions", "default", "kind", "html", "tag" };
        private static readonly Regex PlainName = new(@"^[A-Za-z_][A-Za-z0-9_\-]*$", RegexOptions.CultureInvariant);
        private static bool Extended(ScreenHtml.Node node, string key) => Types.ContainsKey(node.Tag) && node.Tag != "Block" && !Language.Contains(key)
            && !key.StartsWith("os-", StringComparison.Ordinal) && !key.StartsWith("ext:", StringComparison.Ordinal) && !key.StartsWith("on", StringComparison.Ordinal) && PlainName.IsMatch(key);
        private void Check(ScreenHtml.Node node, bool top = false, bool declaration = false)
        {
            if (node.IsText) { ScreenHtml.Run(node.Text!, out _, out var fault); if (fault != null) Problem(node, fault); return; }
            var allowed = new HashSet<string>(StringComparer.Ordinal);
            // k is the identity of the reading an edit or a recreation is based on: accepted everywhere, written nowhere.
            allowed.Add("k");
            if (top) allowed.UnionWith(["name", "flow", "title", "description", "roles", "actions"]);
            else if (Data(node)) { allowed.UnionWith(["name", "type", "default", "mandatory", "description"]); if (!declaration) Problem(node, "Variables and input parameters must be direct children of screen or block; a visual input needs bind."); }
            else if (node.Tag == "os-opaque" || node.Tag.StartsWith("os-", StringComparison.Ordinal)) {
                // A widget the language has no row for (os-opaque) or an element of another kind the reader prints by its
                // kind (a UI flow connector of the screen) keeps its native subtree: a recreation moves the original (by k);
                // a new document cannot make it.
                if (!(options.MoveOpaque && options.Opaque != null && node.Get("k") is { Length: > 0 } opaque && options.Opaque(opaque) != null))
                    Problem(node, "<os-opaque kind=\"" + node.Get("kind") + "\"> is a widget the Traditional document cannot create; keep it where the reading put it (edit by k and basedOn) or write it with the native verbs.");
                return;
            }
            else if (node.Tag == "style") { if (node.Attributes.Count > 0) Problem(node, "Traditional <style> writes the screen or block stylesheet; scope and other attributes are unsupported."); return; }
            else if (node.Tag == "slot") allowed.Add("name");
            else if (Types.ContainsKey(node.Tag)) {
                allowed.UnionWith(["id", "name", "class", "style"]);
                if (node.Tag == "div") allowed.UnionWith(["if", "else", "list"]);
                if (node.Tag is "button" or "a") allowed.UnionWith(["onclick", "method", "validation"]);
                if (node.Tag is "input" or "textarea" or "checkbox-input" or "password-input" or "radio-input")
                    allowed.UnionWith(["type", "bind", "placeholder", "mandatory", "required", "maxlength", "rows", "onchange", "enabled", "value"]);
                if (node.Tag == "form") allowed.UnionWith(["record", "editable"]);
                if (node.Tag == "select") allowed.UnionWith(["bind", "source-entity", "source-attribute", "required", "options", "label", "value", "empty", "empty-value", "enabled", "onchange"]);
                if (node.Tag is "table-records" or "list-records") allowed.UnionWith(["source", "line-count", "start-index"]);
                if (node.Tag == "expr") allowed.UnionWith(["value", "example"]);
                if (node.Tag == "upload") allowed.UnionWith(["required", "enabled"]);
                if (node.Tag == "label") allowed.Add("for");
            }
            else Problem(node, "Traditional has no document mapping for <" + node.Tag + ">.");
            if (node.Get("method") is { } method && method is not ("Ajax" or "Submit" or "Navigate"))
                Problem(node, "method must be Ajax, Submit or Navigate (Ajax means Ajax Submit).");
            if (node.Get("validation") is { } validation && validation is not ("None" or "Server" or "ClientAndServer"))
                Problem(node, "validation must be None, Server or ClientAndServer.");
            if ((node.Get("method") != null || node.Get("validation") != null) && node.Get("onclick") == null)
                Problem(node, "method and validation require onclick.");
            foreach (var a in node.Attributes) {
                if (!allowed.Contains(a.Key) && !((top || Types.ContainsKey(node.Tag)) && (a.Key.StartsWith("os-", StringComparison.Ordinal) || a.Key.StartsWith("ext:", StringComparison.Ordinal))) && !(node.Tag == "Block" && (a.Key.StartsWith(':') || a.Key.StartsWith('@') || a.Key == "onnotify")) && !Extended(node, a.Key)) Problem(node, "Unsupported Traditional attribute " + a.Key + " on <" + node.Tag + ">; it would not be preserved.");
                if (a.Key.StartsWith("ext:", StringComparison.Ordinal)) {
                    if (a.Key.Length == 4 || ScreenDocument.ScriptAttribute(a.Key,a.Value) != null) Problem(node,"Extended attributes must have a name and cannot introduce inline browser code; bind native events to actions.");
                    if (ScreenDocument.AttributeBindingProblem(node,a.Key,a.Value) is { } binding) problems.Add(binding);
                }
                if (a.Key.Equals("os-Visible", StringComparison.OrdinalIgnoreCase) && !(a.Key == "os-Visible" && a.Value == "True")) Problem(node, "Use div if/else for a new conditional widget; the canonical constant os-Visible=True only preserves an always-visible control.");
                if (a.Key is "class" or "style" && ScreenHtml.HasBinding(a.Value)) Problem(node, "Traditional " + a.Key + " must be literal; dynamic classes need a native extended property.");
                if ((a.Key == "onclick" || a.Key == "onchange" || a.Key == "onnotify" || a.Key.StartsWith('@')) && !ScreenHtml.TryCall(a.Value, out _, out _)) Problem(node, "An event requires a destination and named OutSystems argument expressions.");
            }
            if (node.Tag == "button" && node.Children.Any(c => !c.IsText)) Problem(node, "Traditional button content must be text or {{ expression }}.");
            if (node.Tag == "Block" && node.Get("name") == null) Problem(node, "Block needs the name of its source block.");
            if (node.Tag == "text" && node.Children.Any(c => !c.IsText)) Problem(node, "text contains only literal text.");
            if (node.Tag == "label" && node.Children.Any(c => !c.IsText && c.Tag != "text"))
                Problem(node, "A native Traditional label contains literal text; put dynamic expressions beside its input.");
            if (node.Tag == "expr" && (node.Get("value") == null || node.Children.Any(c => !c.IsText || !string.IsNullOrWhiteSpace(c.Text)))) Problem(node, "expr requires value and no children.");
            if (node.Tag == "text") return; // Literal braces are not binding syntax inside canonical text.
            foreach (var child in node.Children) Check(child, declaration: top);
        }
        private IObjectSignature Create(IObjectSignature parent, string type, string? name = null)
        {
            // The footprint keeps the parent as a scope before the child exists, as a create op would (B3): the sweep
            // and the scopes then agree on what this document created.
            s.FootprintScopes("create", new JsonObject { ["parent"] = "@" + parent.ObjectKey });
            var item = (IObjectSignature)s.NewChild(parent, type, name);
            s.Anchor(item, created: true);
            written.Add(new JsonObject { ["type"] = type, ["key"] = item.ObjectKey!.ToString(), ["name"] = TypeResolver.Name(item) });
            return item;
        }
        private void Set(IObjectSignature item, string property, string value)
        {
            var op = new JsonObject { ["op"] = "set", ["target"] = "@" + item.ObjectKey, ["prop"] = property, ["value"] = value };
            if (property == "Style") {
                var (written, done) = s.StyleRule(item, op);
                if (done != null) return;
                op = written;
            }
            s.SetCore(item, op);
        }
        private void ComboColumn(IObjectSignature item, string column, bool identifier)
        {
            var dot = column.LastIndexOf('.');
            if (dot <= 0 || dot == column.Length - 1)
                throw new KernelRefusalException(ScreenDocument.Traditional, "Traditional select label/value requires Record.Field; received " + column);
            var recordName = column[..dot];
            IObjectSignature record;
            try { record = (IObjectSignature)s.Resolve("IEntitySignature:" + recordName); }
            catch (KeyNotFoundException) { record = (IObjectSignature)s.Resolve("IStructureSignature:" + recordName); }
            var field = At(record, "/" + column[(dot + 1)..]);
            var parent = TraditionalWidgetMetadata.ColumnParent(item, record, field);
            Set(item, identifier ? "SourceIdentifierAttributeParent" : "SourceAttributeParent", "@" + parent.ObjectKey);
            if (!ReferenceEquals(parent, field))
                Set(item, identifier ? "SourceIdentifierAttribute" : "SourceAttribute", "@" + field.ObjectKey);
            Set(item, identifier ? "SourceIdentifierAttributeRecord" : "SourceAttributeRecord", "@" + record.ObjectKey);
        }
        private static string Expression(string text) { var value = ScreenHtml.Run(text, out var expression, out _); return expression ? value : "\"" + value.Replace("\"", "\"\"") + "\""; }
        private void TextValue(IObjectSignature item, string property, string value)
        {
            // The WebScreen title getter is an expression, but SetTitle takes its literal caption.
            if (property != "Title" && IsExpressionProperty(item, property)) Set(item, property, Expression(value));
            else {
                if (ScreenHtml.HasBinding(value)) throw new FormatException("Traditional " + property + " takes literal text, not a binding.");
                var verbatim = s._verbatim;
                try { s._verbatim = true; Set(item, property, value); }
                finally { s._verbatim = verbatim; }
            }
        }
        private IObjectSignature At(IObjectSignature item, string suffix) => (IObjectSignature)s.Resolve("@" + item.ObjectKey + suffix);
        // An event handler of the document is an action of its own root: a name the root does not own is refused with
        // the fix, never a KeyNotFoundException out of the apply.
        private IObjectSignature Owned(string actionName, string attribute)
        {
            try { return At(root!, "/" + actionName); }
            catch (KeyNotFoundException) {
                throw new KernelRefusalException(ScreenDocument.NameUnknown, attribute + " names " + actionName + ", which is no action of "
                    + TypeResolver.Name(root!) + "; declare " + TypeResolver.Name(root!) + "." + actionName + " in a logic op of the same job.");
            }
        }
        private void NativeProperties(IObjectSignature item, ScreenHtml.Node node)
        {
            if (node.Tag == "select" && node.Get("os-SourceEntity") is { } entity)
                Set(item,"SourceEntity",entity.Contains(':') || entity.StartsWith('@') ? entity : "IEntitySignature:" + entity);
            foreach (var attribute in node.Attributes.Where(a => a.Key.StartsWith("ext:", StringComparison.Ordinal) || Extended(node, a.Key))) {
                var extended = Create(item,"IExtendedProperty");
                Set(extended,"Property",attribute.Key.StartsWith("ext:", StringComparison.Ordinal) ? attribute.Key[4..] : attribute.Key); Set(extended,"Value",ScreenHtml.Unsugar(attribute.Value));
            }
            foreach (var attribute in node.Attributes.Where(a => a.Key.StartsWith("os-", StringComparison.Ordinal))) {
                var property = attribute.Key[3..]; var target = item;
                // Targets of a screen are its UI flow connectors, derived: the connectors themselves are moved (os-ActionConnector).
                if (ReferenceEquals(item, root) && property == "Targets") continue;
                if (node.Tag == "select" && property == "SourceEntity") continue;
                if (node.Tag == "select" && property == "SourceAttribute" && attribute.Value.StartsWith("EntityAttributeSignature:",StringComparison.Ordinal)
                    && ModelHost.Prop(item,"SourceEntity") is IObjectSignature sourceEntity) {
                    var sourceAttribute = At(sourceEntity,"/" + attribute.Value["EntityAttributeSignature:".Length..]);
                    Set(item,property,"@" + sourceAttribute.ObjectKey); continue;
                }
                // The reader prints a column record by its bare name (os-SourceAttributeRecord="User"), as it prints
                // os-SourceEntity: read it back as the entity of that name, or the structure when no entity has it.
                if (node.Tag == "select" && property is "SourceAttributeRecord" or "SourceIdentifierAttributeRecord"
                    && !attribute.Value.Contains(':') && !attribute.Value.StartsWith('@') && !attribute.Value.StartsWith('$')) {
                    object record;
                    try { record = s.Resolve("IEntitySignature:" + attribute.Value); }
                    catch (KeyNotFoundException) { record = s.Resolve("IStructureSignature:" + attribute.Value); }
                    Set(item,property,"@" + ((IObjectSignature)record).ObjectKey); continue;
                }
                if (property.StartsWith("onclick.", StringComparison.Ordinal)) { target = At(item, "/OnClick"); property = property[8..]; }
                else if (property.StartsWith("onchange.", StringComparison.Ordinal)) { target = At(item, "/OnChange"); property = property[9..]; }
                // Type is a derived contract printed by the reader. It is checked
                // against the source binding, never dropped or assigned by force.
                if (property == "Type" && node.Tag is "table-records" or "list-records") {
                    var actual = UiCatalog.TypeName(ModelHost.Prop(item, property));
                    if (actual != attribute.Value) throw new KernelRefusalException(ScreenDocument.Traditional,
                        "Derived records Type differs from the HTML: expected " + attribute.Value + ", read " + actual);
                } else Set(target, property, attribute.Value);
            }
        }
        public JsonObject Run()
        {
            var parsed = ScreenHtml.Parse(source);
            var nodes = parsed.Children.Where(n => !n.IsText || !string.IsNullOrWhiteSpace(n.Text)).ToList();
            if (nodes.Count != 1 || nodes[0].Tag is not ("screen" or "block")) throw new FormatException("Traditional html needs one screen or block document.");
            var top = nodes[0]; Check(top, true);
            var name = top.Get("name") ?? "";
            if (!Regex.IsMatch(name, @"^[A-Za-z_][A-Za-z0-9_]*$")) Problem(top, "A screen or block needs a valid name.");
            if (problems.Count > 0) throw ScreenDocument.Refusal(problems, source, "/html");
            var flow = (IObjectSignature)s.Resolve("IWebFlow:" + (top.Get("flow") ?? "MainFlow"));
            if (flow.Children.OfType<IObjectSignature>().Any(c => string.Equals(TypeResolver.Name(c), name, StringComparison.OrdinalIgnoreCase)))
                throw new KernelRefusalException(ScreenDocument.RootExists, "Traditional document creates a new root; '" + name + "' already exists. Read ssam_map view html and edit with k and basedOn.");
            try {
                root = Create(flow, top.Tag == "screen" ? "IWebScreen" : "IWebBlock", name);
                Keyed(top, root);
                if (top.Get("description") is { } description) Set(root, "Description", description);
                if (top.Get("title") is { } title) TextValue(root, "Title", title);
                if (top.Get("roles") is { } roles) s.SetCore(root, new JsonObject { ["op"] = "set", ["target"] = "@" + root.ObjectKey, ["prop"] = "Roles",
                    ["value"] = new JsonArray(roles.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries).Select(r => (JsonNode)("IRole:" + r)).ToArray()) });
                foreach (var node in top.Children.Where(Data)) {
                    var data = Create(root, node.Tag == "var" ? "ILocalVariable" : "IInputParameter", node.Get("name"));
                    Keyed(node, data);
                    var dataType = node.Get("type") ?? "Text";
                    // The canonical reader qualifies native basic types.
                    Set(data, "DataType", dataType.StartsWith("BasicType:", StringComparison.Ordinal) ? dataType[10..] : dataType);
                    if (node.Get("default") is { } value) Set(data, "DefaultValue", value);
                    if (node.Tag == "input") Set(data, "IsMandatory", node.Get("mandatory") ?? "False");
                    if (node.Get("description") is { } why) Set(data, "Description", why);
                }
                NativeProperties(root, top);
                options.BeforeContent?.Invoke(root);
                var declared = options.DeclaredBy?.Invoke(root.GetInterface()?.Name ?? "", name) ?? [];
                foreach (var action in (top.Get("actions") ?? "").Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
                    if (!root.Children.OfType<IObjectSignature>().Any(c => Implements(c, "IScreenAction") && TypeResolver.Name(c) == action)
                        && !(action == "Preparation" && (declared.Contains(action) || root.Children.OfType<IObjectSignature>().Any(c => Implements(c, "IPreparation")))))
                        throw new KernelRefusalException(ScreenDocument.NameUnknown, "Declare action " + name + "." + action + " in a logic op of the same job.");
                IObjectSignature host = root;
                if (top.Tag == "screen" && root.Children.OfType<IObjectSignature>().FirstOrDefault(c => Implements(c, "IWebBlockInstanceWidget")) is { } defaultLayout) {
                    var visual = top.Children.Where(n => !Data(n) && n.Tag != "style" && !(n.IsText && string.IsNullOrWhiteSpace(n.Text)) && !n.Tag.StartsWith("os-", StringComparison.Ordinal)).ToList();
                    if (visual.Count == 0 || top.Children.Any(n => n.Tag == "Block"))
                        defaultLayout.Delete(); // The document supplies the shell (or has none); do not nest it inside the template shell.
                    else host = At(root, "/#IWebBlockInstanceWidget/MainContent");
                }
                Children(host, top.Children.Where(n => !Data(n)).ToList());
                // A label names its input by the input's name, which may come later in the document.
                foreach (var (label, forName) in labels) {
                    var targets = root.GetAllDescendantsOfType<IObjectSignature>().Where(w => Implements(w, "IWidget") && TypeResolver.Name(w) == forName).ToList();
                    if (targets.Count != 1) throw new KernelRefusalException(ScreenDocument.NameUnknown, "label for=\"" + forName + "\" names " + targets.Count + " widgets of " + name + "; give the input that id.");
                    Set(label, "TargetWidget", "@" + targets[0].ObjectKey);
                }
                var css = string.Join("\n", All(top).Where(n => n.Tag == "style").Select(n => string.Concat(n.Children.Select(c => c.Text))));
                if (options.Css != null) css += "\n" + options.Css;
                Set(root, "StyleSheet", css);
                if (ThemeCss.Of(root)?.EffectiveValue?.Replace("\r\n", "\n") != css.Replace("\r\n", "\n"))
                    throw new InvalidOperationException("Traditional document stylesheet readback mismatch.");
                // Entry is the Traditional navigation mechanism. Keep an existing entry/default intact.
                if (top.Tag == "screen" && !((IObjectSignature)s._espace).GetAllDescendantsOfType<IObjectSignature>().Any(c => Implements(c, "IEntry"))) {
                    entry = Create(flow, "IEntry", name + "Entry");
                    s.Link(new JsonObject { ["op"] = "link", ["from"] = "@" + entry.ObjectKey, ["to"] = "@" + root.ObjectKey });
                    Set(entry, "IsDefault", "True");
                }
                return new JsonObject { ["form"] = "ssam-html/1", ["context"] = "Traditional", ["root"] = name,
                    ["key"] = root.ObjectKey!.ToString(), ["created"] = written, ["keys"] = keys, ["entryCreated"] = entry != null,
                    ["editing"] = "Read existing Traditional roots with ssam_map view html; edit with k and basedOn. Document creation refuses a duplicate root." };
            }
            catch { entry?.Delete(); root?.Delete(); throw; }
        }
        private static IEnumerable<ScreenHtml.Node> All(ScreenHtml.Node node) { yield return node; foreach (var child in node.Children) foreach (var n in All(child)) yield return n; }
        // The original of an os-opaque element of the reading, moved under the host by the platform (its subtree and its
        // consumers follow): the recreation keeps what the language has no row for. Checked before anything is written.
        private void MoveOpaque(IObjectSignature host, ScreenHtml.Node node)
        {
            var k = node.Get("k") ?? "";
            var original = k.Length > 0 && options.MoveOpaque ? options.Opaque?.Invoke(k) : null;
            if (original == null) throw new KernelRefusalException(ScreenDocument.OpaqueTouched, "<os-opaque kind=\"" + node.Get("kind") + "\"> is a widget the Traditional document cannot create; keep it where the reading put it (edit by k and basedOn).");
            var moved = (IObjectSignature)StudioAdapter.Runtime.MoveObject((IObject)original, (IObject)host);
            keys[k] = moved.ObjectKey!.ToString();
            written.Add(new JsonObject { ["type"] = "moved:" + node.Get("kind"), ["key"] = moved.ObjectKey!.ToString(), ["name"] = TypeResolver.Name(moved) });
        }
        private void Children(IObjectSignature host, List<ScreenHtml.Node> nodes)
        {
            for (var i = 0; i < nodes.Count; i++) {
                var node = nodes[i];
                if (node.IsText) { if (!string.IsNullOrWhiteSpace(node.Text)) Text(host, node.Text!); continue; }
                if (node.Tag == "style") continue;
                if (node.Get("if") is { } condition) {
                    var branch = Create(host, "OutSystems.Model.UI.Web.Widgets.IIfWidget", node.Get("id")); Set(branch, "Condition", condition);
                    Keyed(node, branch);
                    NativeProperties(branch,node);
                    if (node.Get("style") is { } style) Set(branch,"CustomStyle",style);
                    var yes = At(branch,"/TrueBranch");
                    // div if is the native branch, exactly as the reader prints it.
                    // A requested class needs a visual container inside that branch.
                    if (node.Get("class") is { } classes) { yes = Create(yes,"IContainerWidget"); Set(yes,"StyleClasses",classes); }
                    Children(yes, node.Children);
                    var next = i + 1; while (next < nodes.Count && nodes[next].IsText && string.IsNullOrWhiteSpace(nodes[next].Text)) next++;
                    if (next < nodes.Count && nodes[next].Get("else") != null) {
                        var otherwise=nodes[next]; var no=At(branch,"/FalseBranch");
                        if (otherwise.Attributes.Any(a=>a.Key!="else")) Element(no,otherwise);
                        else Children(no,otherwise.Children);
                        i=next;
                    }
                } else if (node.Get("else") != null) throw new FormatException("Traditional else must follow div if.");
                else Element(host, node);
            }
        }
        private void Text(IObjectSignature host, string text)
        {
            var value = ScreenHtml.Run(text, out var expression, out _);
            if (!expression) value = Regex.Replace(value.Trim(), @"\s*\n\s*", " ");
            var item = Create(host, expression ? "IExpressionWidget" : WebText);
            Set(item, expression ? "Value" : "Text", value);
        }
        private void Element(IObjectSignature host, ScreenHtml.Node node)
        {
            if (node.Tag == "os-opaque" || node.Tag.StartsWith("os-", StringComparison.Ordinal)) { MoveOpaque(host, node); return; }
            if (node.Get("list") is { } list) { var rows = Create(host, "IListRecordsWidget", "Rows" + ++sequence); Set(rows, "SourceRecordList", list); host = rows; }
            if (node.Tag == "slot") {
                var slot = At(host, "/" + node.Get("name"));
                Keyed(node, slot);
                // An explicitly supplied slot replaces sample content; omitted slots retain the official defaults.
                foreach (var child in slot.Children.OfType<IWidget>().ToArray()) child.Delete();
                Children(slot, node.Children); return;
            }
            var type = Types[node.Tag];
            // The installed Model API exposes Method/Validation on ILinkOnClick only.
            // Explicit event policy uses that native widget, with button styling when requested.
            var policyLink = node.Tag == "button" && (node.Get("method") != null || node.Get("validation") != null || node.Get("os-onclick.Method") != null);
            if (policyLink) type = "ILinkWidget";
            if (node.Tag == "input" && node.Get("type") == "checkbox") type = "ICheckBoxWidget";
            else if (node.Tag == "input" && node.Get("type") == "password") type = "IInputPasswordWidget";
            else if (node.Tag == "input" && node.Get("type") == "radio") type = "IRadioButtonWidget";
            var item = Create(host, type, node.Get("id") ?? (node.Tag == "Block" ? null : node.Get("name")));
            Keyed(node, item);
            if (node.Get("class") is { } classes) Set(item, FindProperty(item, "StyleClasses") != null ? "StyleClasses" : "Style", classes);
            if (policyLink) Set(item, "StyleClasses", "Button " + (node.Get("class") ?? ""));
            if (node.Get("style") is { } style) Set(item, "CustomStyle", style);
            else if (node.Tag == "span") Set(item, "CustomStyle", "display: inline;");
            if (node.Tag == "Block") {
                var blockName = node.Get("name")!;
                if (blockName.Contains(':')) Set(item, "SourceBlock", blockName.StartsWith('I') ? blockName : "I" + blockName);
                else {
                    try { Set(item, "SourceBlock", "IWebBlock:" + blockName); }
                    catch (UnresolvedReferenceException) { Set(item, "SourceBlock", "IWebBlockSignature:" + blockName); }
                }
            }
            if (node.Tag == "label" && node.Get("for") is { } forName) labels.Add((item, forName));
            if (node.Tag is "table-records" or "list-records") {
                if (node.Get("source") is { } records) Set(item, "SourceRecordList", records);
                if (node.Get("line-count") is { } lines) Set(item, "LineCount", lines);
                if (node.Get("start-index") is { } start) Set(item, "StartIndex", start);
            }
            if (node.Get("bind") is { } bind) Set(item, "Variable", bind);
            if (node.Get("enabled") is { } enabled) Set(item, "Enabled", enabled);
            if (node.Tag == "form") {
                if (node.Get("record") is { } record) Set(item, "SourceRecord", record);
                if (node.Get("editable") is { } editable) Set(item, "IsEditable", editable);
            }
            if (node.Tag == "select") {
                if (node.Get("options") is { } options) Set(item, "SourceRecordList", options);
                if (node.Get("source-entity") is { } entity) Set(item, "SourceEntity", entity);
                if (node.Get("source-attribute") is { } attribute) Set(item, "SourceAttribute", attribute);
                if (node.Get("label") is { } labelColumn) ComboColumn(item, labelColumn, false);
                if (node.Get("value") is { } valueColumn) ComboColumn(item, valueColumn, true);
                if (node.Get("empty") is { } empty) {
                    var caption = empty.StartsWith('"') && empty.EndsWith('"') ? empty[1..^1].Replace("\"\"", "\"") : empty;
                    var add = ModelApiMetadata.Methods(item.GetType()).Single(m=>m.Name == "AddSpecialValue");
                    add.Invoke(item, [caption, node.Get("empty-value") ?? "0"]);
                }
                if (node.Get("required") is { } requiredChoice) Set(item, "IsMandatory", requiredChoice.Length == 0 ? "True" : requiredChoice);
            }
            if (node.Tag == "upload" && node.Get("required") is { } uploadRequired) Set(item, "Mandatory", uploadRequired.Length == 0 ? "True" : uploadRequired);
            if (node.Tag == "expr") {
                Set(item, "Value", node.Get("value")!);
                if (node.Get("example") is { } example) TextValue(item, "Example", example);
            }
            else if (node.Tag != "select" && node.Get("value") is { } radioValue) {
                if (type != "IRadioButtonWidget") throw new KernelRefusalException(ScreenDocument.Traditional, "value requires a Traditional radio input; use bind for editable values.");
                Set(item, "Value", radioValue);
            }
            if (node.Get("onchange") is { } onChange) {
                ScreenHtml.TryCall(onChange, out var actionName, out var arguments);
                var target = Owned(actionName, "onchange");
                if (!Implements(target, "IScreenAction"))
                    throw new KernelRefusalException(ScreenDocument.Traditional, "Traditional onchange requires a screen action of the current screen or block.");
                var handler = At(item, "/OnChange");
                Set(handler, "Destination", "@" + target.ObjectKey);
                foreach (var (parameter, value) in arguments) Set(At(handler, "/" + parameter), "Value", value);
            }
            if (node.Tag is "input" or "textarea" or "checkbox-input" or "password-input" or "radio-input") {
                if (node.Get("placeholder") is { } prompt) TextValue(item, "Prompt", prompt);
                if (node.Get("mandatory") is { } mandatory) Set(item, "Mandatory", mandatory);
                if (node.Get("required") is { } required) Set(item, "Mandatory", required.Length == 0 ? "True" : required);
                if (node.Get("maxlength") is { } maxLength) Set(item, "MaxLength", maxLength);
                if (node.Tag == "textarea") Set(item, "TextLines", node.Get("rows") ?? "4");
                if (node.Get("type") is { } inputType && inputType is not ("text" or "password" or "checkbox" or "radio")) Set(item, "Type", inputType);
            }
            if (node.Get("onclick") is { } destination) {
                ScreenHtml.TryCall(destination, out destination, out var arguments);
                IObjectSignature target;
                if (destination.IndexOf(':') is var colon && colon > 0 && destination[..colon] == "ScreenAction") target = Owned(destination[(colon + 1)..], "onclick");
                else if (colon > 0) target = (IObjectSignature)s.Resolve(destination.StartsWith('I') ? destination : "I" + destination);
                else {
                    try { target = At(root!, "/" + destination); }
                    catch (KeyNotFoundException) { target = (IObjectSignature)s.Resolve("IWebScreen:" + destination); }
                }
                var click = At(item, "/OnClick"); Set(click, "Destination", "@" + target.ObjectKey);
                foreach (var (parameter, value) in arguments) Set(At(click, "/" + parameter), "Value", value);
                var navigation = Implements(target, "IWebScreen") || Implements(target, "IExternalSite");
                var method = node.Get("method") ?? node.Get("os-onclick.Method") ?? (navigation ? "Navigate" : "Submit");
                if (method == "Navigate" && !navigation || method != "Navigate" && navigation)
                    throw new KernelRefusalException(ScreenDocument.Traditional, "Navigate requires a screen/external site; Ajax/Submit require a screen action. Choose method for the destination, not the caption.");
                if (node.Tag == "a" || policyLink) {
                    Set(click, "Method", method);
                    if (node.Get("validation") is { } validation) Set(click, "Validation", validation);
                }
            }
            if (node.Tag == "Block") foreach (var attribute in node.Attributes) {
                if (attribute.Key.StartsWith(':')) Set(At(item, "/" + attribute.Key[1..]), "Value", attribute.Value);
                else if (attribute.Key.StartsWith('@') || attribute.Key == "onnotify") {
                    ScreenHtml.TryCall(attribute.Value, out var handlerName, out var arguments);
                    var target = Owned(handlerName, attribute.Key);
                    var handler = At(item, "/" + (attribute.Key == "onnotify" ? "OnNotify" : attribute.Key[1..]));
                    Set(handler, attribute.Key == "onnotify" ? "Destination" : "Handler", "@" + target.ObjectKey);
                    foreach (var (parameter, value) in arguments) Set(At(handler, "/" + parameter), "Value", value);
                }
            }
            NativeProperties(item, node);
            if (node.Tag == "text") Set(item, "Text", string.Concat(node.Children.Select(c => c.Text)));
            else if (node.Tag == "label") TextValue(item, "Text", string.Concat(node.Children.Select(c => c.IsText ? c.Text : string.Concat(c.Children.Select(t=>t.Text)))));
            else if (node.Tag == "expr") { }
            else if (node.Tag == "button" && !policyLink) { var caption = string.Concat(node.Children.Select(c => c.Text)); if (caption.Length > 0 || node.Get("os-Label") == null) TextValue(item, "Label", caption); }
            else if (node.Tag == "table-records" && node.Children.Any(c => c.Tag == "tr")) {
                var rows = node.Children.Where(c => !c.IsText || !string.IsNullOrWhiteSpace(c.Text)).ToList();
                if (rows.Count != 2 || rows.Any(c => c.Tag != "tr"))
                    throw new KernelRefusalException(ScreenDocument.Traditional,"Canonical table-records requires HeaderRow then DataRow as exactly two tr elements.");
                for (var i=0;i<2;i++) {
                    var row = At(item, i == 0 ? "/HeaderRow" : "/DataRow");
                    Keyed(rows[i], row);
                    foreach (var child in row.Children.OfType<IWidget>().ToArray()) child.Delete();
                    if (rows[i].Get("id") is { } id) Set(row,"Name",id);
                    if (rows[i].Get("class") is { } rowClasses) Set(row,"StyleClasses",rowClasses);
                    if (rows[i].Get("style") is { } rowStyle) Set(row,"CustomStyle",rowStyle);
                    NativeProperties(row,rows[i]); Children(row,rows[i].Children);
                }
            } else Children(item, node.Children);
        }
    }
}
