using System.Text.Json.Nodes;

namespace Anvil.Reading;

// One problem of an edited data text: its line, a code, what is wrong and the fix (with the corrected text when the fix is
// certain). Every problem of a text comes at once (the owner's rule: refused once, with all of them).
public sealed record DdlProblem(int Line, string Code, string Message, string Fix, string? Corrected = null)
{
    // More fields of the refusal (the edit ready to send: the current declarations and their basedOn), copied as they are.
    public JsonObject? Data { get; init; }
}

// One op the way back emits, with the line of the text it comes from and what it changes ("Produto.Nome").
public sealed record DdlStep(JsonObject Op, int Line, string What);

// The way back of the data text (ssam-ddl/1, step DL2 of the SSAM text plan): the ops that make the module's data what an
// edited text says, where the text speaks. New entities, static entities and structures become one `spec` op (SpecExpander);
// everything else is the raw verbs: create, set, rename, move, delete. Elements are matched by their @key: the same key with
// another name is a rename (never a delete and a create); an element without a key is new; a child whose key is absent from
// a statement sent whole (an attribute, a record of a `values` list, a structure attribute) is deleted; `drop … -- @key`
// deletes a top-level element or an index. A property neither text writes is left to the platform (its default follows the
// name, as the Studio's does); every other difference is one `set` of that property. The text is compared with the text of
// the module (DataDdl), which reads back to the model exactly (the fixed point of DL1), so a text sent back unchanged
// compiles to zero ops.
public sealed class DdlCompilation
{
    // The spec data of the new entities, static entities and structures (null when the text declares none), with the
    // `_line` of each declaration.
    public JsonObject? Spec { get; internal set; }
    public int SpecLine { get; internal set; }
    // The renames and deletes that free a name a new element of the same edit takes: they run before anything is created.
    public List<DdlStep> Before { get; } = [];
    public List<DdlStep> Steps { get; } = [];
    public List<DdlProblem> Problems { get; } = [];
    // The new elements of the text, each with the $alias its ops register (keys come from the apply).
    public Dictionary<DdlElement, string> Aliases { get; } = new(ReferenceEqualityComparer.Instance);
    public List<DdlElement> Created { get; } = [];
    // Kept elements whose type the edit changes: like a new one, a size its text leaves out is the new type's own.
    public List<DdlElement> Retyped { get; } = [];
    public JsonArray Renamed { get; } = [];
    public JsonArray Deleted { get; } = [];

    public int Count => (Spec != null ? 1 : 0) + Before.Count + Steps.Count;

    // The ops in the order they run: the spec first, then the steps.
    public List<(JsonObject Op, int Line, string What)> Ops()
    {
        var ops = new List<(JsonObject, int, string)>(Before.Select(s => (s.Op, s.Line, s.What)));
        if (Spec != null) ops.Add((new JsonObject { ["op"] = "spec", ["data"] = Spec.DeepClone() }, SpecLine, "new types"));
        ops.AddRange(Steps.Select(s => (s.Op, s.Line, s.What)));
        return ops;
    }

    public JsonObject Summary() => new() {
        ["ops"] = Count, ["spec"] = Spec != null, ["created"] = new JsonArray(Created.Select(e => (JsonNode)(Owner(e) + e.Name)).ToArray()),
        ["renamed"] = Renamed.DeepClone(), ["deleted"] = Deleted.DeepClone(),
        ["set"] = Steps.Count(s => s.Op["op"]?.ToString() == "set"), ["moved"] = Steps.Count(s => s.Op["op"]?.ToString() == "move") };

    private static string Owner(DdlElement e) => e.Parent != null ? e.Parent.Name + "." : "";
}

public sealed class DdlCompiler
{
    // Properties whose value is another element, written by name in the text.
    private static readonly HashSet<string> AttributeRefs = new(StringComparer.Ordinal) { "LabelAttribute", "OrderByAttribute", "IsActiveAttribute" };
    // Handled by their own rule (type and size together, the identifier, an index's columns, a timer's action, an event's
    // handler, the folder).
    private static readonly HashSet<string> Special = new(StringComparer.Ordinal) {
        "DataType", "Length", "Decimals", "Identifier", "Unique", "Action", "Destination", "Folder" };

    private readonly DdlDocument edit;
    private readonly DdlDocument? @base;
    private readonly string lane;
    private readonly string prefix;
    private readonly string text;
    private readonly DdlCompilation result = new();
    private readonly Dictionary<string, DdlElement> baseByKey = new(StringComparer.Ordinal);
    private readonly Dictionary<string, DdlElement> editByKey = new(StringComparer.Ordinal);
    private int aliases;
    // The phases, in the order they run (DdlCompilation.Ops).
    private readonly List<DdlStep> early = [], renames = [], creates = [], sets = [], moves = [], indexDrops = [], indexCreates = [], deletes = [], drops = [];
    private readonly JsonObject spec = [];
    private readonly List<int> specLines = [];

    // Elements an earlier round of the same edit created: a type written without its size keeps the size the platform gives
    // a new element of that type (Decimal is Decimal(37,8)); every other property is what the text says.
    private readonly HashSet<DdlElement> fresh;

    private DdlCompiler(DdlDocument edit, DdlDocument? @base, string lane, string prefix, string text, IEnumerable<DdlElement>? fresh)
    {
        this.edit = edit; this.@base = @base; this.lane = lane; this.prefix = prefix; this.text = text;
        this.fresh = new HashSet<DdlElement>(fresh ?? [], ReferenceEqualityComparer.Instance);
        if (@base != null) foreach (var element in @base.All()) if (element.Key.Length > 0) baseByKey.TryAdd(element.Key, element);
    }

    // The ops of an edited text against the module's own text (base); without a base, only what the text creates (the
    // static checks of a job read that before any model is loaded). `text` is the edit as written (the corrected text of a
    // certain fix is built from it); `prefix` names the $aliases of this compile.
    public static DdlCompilation Compile(DdlDocument edit, DdlDocument? @base, string lane, string prefix = "$ddl", string text = "", IEnumerable<DdlElement>? fresh = null)
    {
        var compiler = new DdlCompiler(edit, @base, lane, prefix, text, fresh);
        compiler.Run();
        return compiler.result;
    }

    // The names the edit gives elements it keeps by key (old name -> new name), by kind of reference: types (entities, static
    // entities, structures), the records of each static entity (by its new name), and site properties, client and session
    // variables (as expressions name them).
    public sealed class Renames
    {
        public readonly Dictionary<string, string> Types = new(StringComparer.Ordinal);
        public readonly Dictionary<string, Dictionary<string, string>> Records = new(StringComparer.Ordinal);
        public readonly Dictionary<string, string> Site = new(StringComparer.Ordinal), Client = new(StringComparer.Ordinal), Session = new(StringComparer.Ordinal);
        public bool Any => Types.Count + Records.Count + Site.Count + Client.Count + Session.Count > 0;
    }

    // What the edit renames, against the module's text.
    public static Renames RenamesOf(DdlDocument edit, DdlDocument @base)
    {
        var renames = new Renames();
        var byKey = new Dictionary<string, DdlElement>(StringComparer.Ordinal);
        foreach (var element in @base.All()) if (element.Key.Length > 0) byKey.TryAdd(element.Key, element);
        var created = edit.Elements.Where(e => e.Key.Length == 0 && !e.Drop).Select(e => e.Name).ToHashSet(StringComparer.Ordinal);
        foreach (var element in edit.All()) {
            if (element.Drop || element.Key.Length == 0 || !byKey.TryGetValue(element.Key, out var was) || was.Name == element.Name || created.Contains(was.Name)) continue;
            if (element.Parent == null && (DdlRules.IsEntityKind(element.Kind) || element.Kind == "Structure")) renames.Types[was.Name] = element.Name;
            else if (element.Kind == "SiteProperty") renames.Site[was.Name] = element.Name;
            else if (element.Kind == "ClientVariable") renames.Client[was.Name] = element.Name;
            else if (element.Kind == "SessionVariable") renames.Session[was.Name] = element.Name;
            else if (IsRecord(element) && element.Parent?.Kind == "StaticEntity") {
                if (!renames.Records.TryGetValue(element.Parent.Name, out var records)) renames.Records[element.Parent.Name] = records = new(StringComparer.Ordinal);
                records[was.Name] = element.Name;
            }
        }
        return renames;
    }

    // A text read before renames, in the names the renames give (what the platform rewrites when it renames: the types that
    // name an entity or structure, Entities.<Static>.<Record>, Site./Settings./Client./Session. in expressions). Descriptions,
    // labels and other texts keep their words: the platform does not rewrite them either.
    public static void Canonical(DdlDocument document, Renames renames, string lane)
    {
        if (!renames.Any) return;
        foreach (var element in document.All().Concat(document.Detached)) {
            if (element.Of != null && renames.Types.TryGetValue(element.Of, out var owner)) element.Of = owner;
            if (element.Props.TryGetValue("DataType", out var type) && type != null) element.Props["DataType"] = Type(type, renames);
            if (element.References != null && renames.Types.TryGetValue(element.References, out var referenced)) element.References = referenced;
            if (element.Props.TryGetValue("DefaultValue", out var value) && value != null) element.Props["DefaultValue"] = Expression(value, renames, lane);
            for (var i = 0; i < element.Values.Count; i++) element.Values[i] = (element.Values[i].Attribute, Expression(element.Values[i].Value, renames, lane));
            for (var i = 0; i < element.Arguments.Count; i++) element.Arguments[i] = (element.Arguments[i].Parameter, Expression(element.Arguments[i].Value, renames, lane));
        }
    }

    private static string Type(string type, Renames renames)
    {
        if (renames.Types.TryGetValue(type, out var renamed)) return renamed;
        foreach (var suffix in new[] { " Identifier", " List", " Record" })
            if (type.EndsWith(suffix, StringComparison.Ordinal) && renames.Types.TryGetValue(type[..^suffix.Length], out var inner)) return inner + suffix;
        return type;
    }

    private static string Expression(string expression, Renames renames, string lane)
    {
        string Outside(Func<string, string> code)
        {
            // Only outside text literals ("…" with "" inside).
            var parts = System.Text.RegularExpressions.Regex.Split(expression, "(\"(?:[^\"]|\"\")*\")");
            for (var i = 0; i < parts.Length; i += 2) parts[i] = code(parts[i]);
            return string.Concat(parts);
        }
        string Rename(string text, string prefix, Dictionary<string, string> names) =>
            names.Count == 0 ? text : System.Text.RegularExpressions.Regex.Replace(text, @"(?<![\w.])" + System.Text.RegularExpressions.Regex.Escape(prefix) + @"\.(\w+)(?!\w)",
                m => names.TryGetValue(m.Groups[1].Value, out var to) ? prefix + "." + to : m.Value);
        expression = Outside(text => {
            text = System.Text.RegularExpressions.Regex.Replace(text, @"(?<![\w.])Entities\.(\w+)\.(\w+)(?!\w)", m => {
                var entity = renames.Types.GetValueOrDefault(m.Groups[1].Value) ?? m.Groups[1].Value;
                var record = renames.Records.TryGetValue(entity, out var records) && records.TryGetValue(m.Groups[2].Value, out var to) ? to : m.Groups[2].Value;
                return "Entities." + entity + "." + record;
            });
            text = Rename(text, lane == "odc" ? "Settings" : "Site", renames.Site);
            text = Rename(text, "Client", renames.Client);
            return Rename(text, "Session", renames.Session);
        });
        return expression;
    }

    // A static entity's label and order attributes default to the attributes named Label and Order, so its text does not
    // write them. The edit that renames one of those attributes keeps the link: the reference follows the attribute (its new
    // name written), as the platform's does; dropping the link is writing `label none`. The edit that deletes the attribute
    // (left out of the statement) drops the link with it, before the delete (the platform's link is a use of the attribute:
    // DELETE_HAS_CONSUMERS otherwise), unless a new attribute takes the name (the default links that one). When the records
    // have values of it, DdlConventions refuses that statement first (DDL_STATIC_ATTRIBUTE_LEFT_OUT): only `label none` /
    // `order none`, or an attribute without values, reach this.
    public static void ImplicitReferences(DdlDocument edit, DdlDocument @base)
    {
        var byKey = new Dictionary<string, DdlElement>(StringComparer.Ordinal);
        foreach (var element in @base.Elements) if (element.Key.Length > 0) byKey.TryAdd(element.Key, element);
        foreach (var entity in edit.Elements.Where(e => e.Kind == "StaticEntity" && e.Key.Length > 0 && !e.Drop)) {
            if (!byKey.TryGetValue(entity.Key, out var was)) continue;
            foreach (var (property, name) in new[] { ("LabelAttribute", "Label"), ("OrderByAttribute", "Order") }) {
                if (was.Props.ContainsKey(property) || entity.Props.ContainsKey(property)) continue;
                if (was.Children.FirstOrDefault(c => c.Kind == "EntityAttribute" && c.Name == name) is not { } linked) continue;
                if (entity.Children.FirstOrDefault(c => c.Kind == "EntityAttribute" && c.Key == linked.Key) is { } renamed) {
                    if (renamed.Name != name) entity.Props[property] = renamed.Name;
                }
                else if (!entity.Children.Any(c => c.Kind == "EntityAttribute" && c.Name == name)) entity.Props[property] = null;
            }
        }
    }

    private void Run()
    {
        if (@base != null) {
            ImplicitReferences(edit, @base);
            // References written with the names before this edit's renames read as the names after them, on both sides.
            var renamed = RenamesOf(edit, @base);
            Canonical(edit, renamed, lane);
            Canonical(@base, renamed, lane);
        }
        foreach (var element in edit.All().Concat(edit.Detached)) {
            if (element.Key.Length == 0) continue;
            if (!editByKey.TryAdd(element.Key, element))
                Problem(element, "DDL_KEY_TWICE", $"the key @{element.Key} is written twice ({Describe(editByKey[element.Key])} and {Describe(element)})",
                    "each element keeps its own key; a new element is written without one");
        }
        foreach (var top in edit.Elements) {
            if (top.Drop) { Drop(top); continue; }
            if (top.Kind == "Timer" && top.Props.TryGetValue("Schedule", out var schedule)) {
                try { Anvil.Core.TimerScheduleValue.Prepare(JsonValue.Create(schedule), false); }
                catch (InvalidOperationException error) {
                    Problem(top, "TIMER_SCHEDULE_INVALID", error.Message,
                        "use native HH:mm times (daily: 03:00; every five minutes: 00:00 00:05 ... 23:55); never prose or cron in Schedule");
                    continue;
                }
            }
            if (top.Key.Length > 0) { if (@base != null) EditTop(top); else NewChildrenOfKept(top); continue; }
            NewTop(top);
        }
        if (@base != null) foreach (var statement in edit.Detached) Detached(statement);
        if (spec.Count > 0) { result.Spec = spec; result.SpecLine = specLines.Count > 0 ? specLines.Min() : 1; }
        var steps = early.Concat(renames).Concat(creates).Concat(sets).Concat(moves).Concat(indexDrops).Concat(indexCreates).Concat(deletes).Concat(drops).ToList();
        // A name a new element takes that an element of the module had (renamed or deleted by the same edit): freed first.
        var taken = new HashSet<string>(result.Created.Select(Scope), StringComparer.OrdinalIgnoreCase);
        var freeing = steps.Where(s => freed.TryGetValue(s, out var scope) && taken.Contains(scope)).ToHashSet();
        // The references that stop pointing at what goes run before it (they name existing attributes, or none).
        if (freeing.Count > 0) freeing.UnionWith(early);
        result.Before.AddRange(steps.Where(freeing.Contains));
        result.Steps.AddRange(steps.Where(s => !freeing.Contains(s)));
    }

    // ---- top-level elements ------------------------------------------------------------------------------------------------

    // A statement may name an entity of the module without repeating its declaration (and its complete attribute list).
    private void Detached(DdlElement statement)
    {
        var owner = @base!.Elements.FirstOrDefault(e => !e.Drop && DdlRules.IsEntityKind(e.Kind) && e.Name == statement.Of);
        if (owner == null) {
            var names = edit.Elements.Concat(@base.Elements).Where(e => !e.Drop && DdlRules.IsEntityKind(e.Kind))
                .Select(e => e.Name).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToList();
            var closest = Closest(statement.Of ?? "", names);
            Problem(statement, "DDL_OWNER_UNKNOWN", $"'{statement.Of}' is no entity of this text nor of the module",
                closest.Count > 0 ? "use one of: " + string.Join(", ", closest) : "declare the entity in this text or use an entity of the module" + (names.Count > 0 ? ": " + string.Join(", ", names) : ""));
            return;
        }
        statement.Parent = owner;
        // Only this statement is edited; omitted attributes, records and events of the owner stay untouched.
        var written = new DdlElement { Kind = owner.Kind, Name = owner.Name, Key = owner.Key };
        written.Children.AddRange(owner.Children.Where(c => c.Kind == "EntityAttribute"));
        written.Children.Add(statement);
        if (statement.Kind == "EntityIndex") Indexes(owner, written);
        else Events(owner, written);
    }

    private void Drop(DdlElement drop)
    {
        if (@base == null) { Step(drops, drop, Op("delete", ("target", "@" + drop.Key))); return; }
        if (!baseByKey.TryGetValue(drop.Key, out var target)) { Foreign(drop); return; }
        if (!SameKind(target, drop)) {
            Problem(drop, "DDL_KIND_CHANGED", $"drop names {Describe(target)} as {Words(drop)}", $"drop {Words(target)} {DdlRules.Name(target.Name)}; -- @{target.Key}");
            return;
        }
        if (target.Name != drop.Name)
            Problem(drop, "DDL_DROP_NAME", $"drop names @{drop.Key} {DdlRules.Name(drop.Name)}, and that key is {Describe(target)}",
                $"drop {Words(target)} {DdlRules.Name(target.Name)}; -- @{target.Key}", Replace(drop.Line, $"drop {Words(target)} {DdlRules.Name(target.Name)}; -- @{target.Key}"));
        else {
            Step(target.Kind == "EntityIndex" ? indexDrops : drops, drop, Op("delete", ("target", "@" + drop.Key)));
            Frees(target.Kind == "EntityIndex" ? indexDrops : drops, target);
            result.Deleted.Add(new JsonObject { ["kind"] = target.Kind, ["name"] = Qualified(target), ["key"] = target.Key });
        }
    }

    private void EditTop(DdlElement top)
    {
        if (!baseByKey.TryGetValue(top.Key, out var was)) { Foreign(top); return; }
        if (was.Parent != null) {
            Problem(top, "DDL_PARENT_CHANGED", $"@{top.Key} is {Describe(was)}, a part of {Describe(was.Parent)}, written here as a {Words(top)} of its own",
                "edit it inside the statement of " + was.Parent.Name);
            return;
        }
        if (!SameKind(was, top)) {
            Problem(top, "DDL_KIND_CHANGED", $"@{top.Key} is {Describe(was)} and the text makes it a {Words(top)}",
                $"keep it a {Words(was)}, or drop it (drop {Words(was)} {DdlRules.Name(was.Name)}; -- @{was.Key}) and create the {Words(top)} without a key");
            return;
        }
        if (was.Name != top.Name) Rename(was, top);
        Properties(was, top);
        if (DdlRules.IsEntityKind(top.Kind)) Entity(was, top);
        else if (top.Kind == "Structure") Members(was, top, "StructureAttribute");
        if (top.Kind == "Timer") Arguments(was, top, "@" + top.Key);
    }

    // An element kept by its key, compiled without the module (the static checks): only what it creates.
    private void NewChildrenOfKept(DdlElement top)
    {
        foreach (var child in top.Children.Where(c => c.Key.Length == 0)) {
            if (child.Kind is "EntityAttribute" or "StructureAttribute") NewAttribute(child, "@" + top.Key);
            else if (IsRecord(child) && top.Kind == "StaticEntity") NewRecord(child, "@" + top.Key);
            else if (child.Kind == "EntityIndex") NewIndex(child, top, "@" + top.Key);
        }
    }

    private void NewTop(DdlElement top)
    {
        // A name is taken by an element of the module the edit keeps under it (one it renames or drops frees its name).
        if (@base != null && @base.Elements.FirstOrDefault(e => e.Parent == null && Family(e.Kind) == Family(top.Kind)
                && string.Equals(e.Name, top.Name, StringComparison.OrdinalIgnoreCase)
                && !(editByKey.TryGetValue(e.Key, out var kept) && (kept.Drop || !string.Equals(kept.Name, e.Name, StringComparison.OrdinalIgnoreCase)))) is { } taken) {
            Problem(top, "DDL_NAME_TAKEN", $"{Words(top)} {DdlRules.Name(top.Name)} has no key, so it is new, and the module already has {Describe(taken)}",
                $"to change {DdlRules.Name(taken.Name)}, end its line with its key (-- @{taken.Key}); to add another one, give it another name");
            return;
        }
        switch (top.Kind) {
            case "ServerEntity" or "ClientEntity": NewEntity(top); break;
            case "StaticEntity": NewStatic(top); break;
            case "Structure": NewStructure(top); break;
            case "SiteProperty" or "ClientVariable" or "SessionVariable": NewDeclaration(top); break;
            case "Timer": NewDeclaration(top); break;
            default:
                Problem(top, "DDL_UNSUPPORTED", $"a new {Words(top)} cannot be created from the data text", "create it in the Studio, then edit it here by its key");
                break;
        }
    }

    // ---- properties ----------------------------------------------------------------------------------------------------------

    // Every property one of the two texts writes: the edit's value (or its default when it leaves the property out) where it
    // differs from the module's. A property neither writes is the platform's (its default follows the element).
    private void Properties(DdlElement was, DdlElement now)
    {
        var before = new DdlParsedContext(was);
        var after = new DdlParsedContext(now);
        var target = Ref(now);
        var typed = now.Kind is "EntityAttribute" or "StructureAttribute" or "SiteProperty" or "ClientVariable" or "SessionVariable";
        var typeChanged = typed && !DdlRules.Same(was.Props.GetValueOrDefault("DataType"), now.Props.GetValueOrDefault("DataType"));
        foreach (var property in was.Props.Keys.Union(now.Props.Keys).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal)) {
            if (Special.Contains(property) || typeChanged && property == "DefaultValue") continue;
            var a = before.Value(property); var b = after.Value(property);
            // An attribute is named by its identity: renamed in the same statement, it is the same attribute.
            if (AttributeRefs.Contains(property) ? Identity(was, a) == Identity(now, b) : DdlRules.Same(a, b)) continue;
            Set(AttributeRefs.Contains(property) ? RefPhase(Owner(now), b) : sets, now, target, property, b, a);
        }
        if (typed) Type(was, now, target, typeChanged);
        Folder(was, now, target);
        if (now.Kind == "Timer" && !DdlRules.Same(was.Props.GetValueOrDefault("Action"), now.Props.GetValueOrDefault("Action")))
            Step(sets, now, Op("set", ("target", target), ("prop", "Action"), ("value", ActionRef(now.Props.GetValueOrDefault("Action")))));
        if (DdlRules.IsEntityKind(now.Kind) && Identity(was, was.Props.GetValueOrDefault("Identifier")) != Identity(now, now.Props.GetValueOrDefault("Identifier"))) {
            var identifier = now.Props.GetValueOrDefault("Identifier");
            Step(RefPhase(now, identifier), now, Op("set", ("target", target), ("prop", "IdentifierAttribute"), ("value", identifier == null ? null : AttributeRef(now, identifier))));
        }
    }

    // The attribute an element names by name (its label, order, active, identifier attribute): its key, "new:<name>" for a
    // new one, the name when no attribute has it (null for none).
    private static string? Identity(DdlElement owner, string? name)
    {
        if (name == null) return null;
        var entity = owner.Kind is "EntityAttribute" or "StructureAttribute" ? owner.Parent ?? owner : owner;
        return entity.Children.FirstOrDefault(c => c.Kind == "EntityAttribute" && c.Name == name) is { } attribute
            ? attribute.Key.Length > 0 ? "@" + attribute.Key : "new:" + name : "?" + name;
    }

    // A reference to an attribute is written before the deletes (the attribute it stops pointing at may go), unless the
    // attribute it now points at is new (then after the creates).
    private List<DdlStep> RefPhase(DdlElement owner, string? attribute) =>
        attribute != null && owner.Children.FirstOrDefault(c => c.Kind == "EntityAttribute" && c.Name == attribute) is { Key.Length: 0 } ? sets : early;

    // The type and its size: the type first (a new type resets the size), then the sizes and the default the text gives. A
    // default typed by an identifier is cleared before the type changes (the Studio's own check fails otherwise).
    private void Type(DdlElement was, DdlElement now, string target, bool typeChanged)
    {
        var type = now.Props.GetValueOrDefault("DataType");
        var defaultBefore = was.Props.GetValueOrDefault("DefaultValue");
        var defaultAfter = now.Props.GetValueOrDefault("DefaultValue");
        if (typeChanged) {
            var identifier = (was.Props.GetValueOrDefault("DataType") ?? "").EndsWith(" Identifier", StringComparison.Ordinal) || (type ?? "").EndsWith(" Identifier", StringComparison.Ordinal);
            if (identifier && !DdlRules.Unset(defaultBefore)) Step(early, now, Op("set", ("target", target), ("prop", "DefaultValue"), ("value", "")));
            Step(sets, now, Op("set", ("target", target), ("prop", "DataType"), ("value", type)));
            result.Retyped.Add(now);
        }
        // A size the text no longer writes is cleared (null); after a type change only the sizes the text writes are set (the
        // new type has its own; the reading after the apply sets any the platform keeps otherwise).
        foreach (var size in new[] { "Length", "Decimals" }) {
            var value = now.Props.GetValueOrDefault(size);
            var differs = !DdlRules.Same(was.Props.GetValueOrDefault(size), value);
            if (typeChanged ? value != null : fresh.Contains(now) ? value != null && differs : differs)
                Step(sets, now, Op("set", ("target", target), ("prop", size), ("value", value)));
        }
        // After a type change the default is written as the text gives it (the platform may have dropped it).
        if (typeChanged && (defaultAfter != null || !DdlRules.Unset(defaultBefore)))
            Step(sets, now, Op("set", ("target", target), ("prop", "DefaultValue"), ("value", defaultAfter ?? "")));
    }

    // `folder X`: the element moves into the folder of that name in its branch of the module tree (created when missing);
    // without it, out of every folder.
    private void Folder(DdlElement was, DdlElement now, string target)
    {
        var folder = now.Props.GetValueOrDefault("Folder");
        if (DdlRules.Same(was.Props.GetValueOrDefault("Folder"), folder)) return;
        Step(sets, now, Op("move", ("target", target), ("into", folder == null ? "@espace" : "folder:" + folder)));
    }

    // One `set`: the value the text gives, or, for a property the edit leaves out whose default is no value, the value that
    // clears it (null for a reference, False/No for a flag, "" for a text or an expression).
    private void Set(List<DdlStep> phase, DdlElement now, string target, string property, string? value, string? was)
    {
        JsonNode? node;
        if (AttributeRefs.Contains(property)) node = value == null ? null : JsonValue.Create(AttributeRef(Owner(now), value));
        else if (value != null) node = JsonValue.Create(value);
        else node = was switch { "True" or "False" => JsonValue.Create("False"), "Yes" or "No" => JsonValue.Create("No"), _ => JsonValue.Create("") };
        var op = new JsonObject { ["op"] = "set", ["target"] = target, ["prop"] = property, ["value"] = node };
        Step(phase, now, op);
    }

    // ---- entities ------------------------------------------------------------------------------------------------------------

    private void Entity(DdlElement was, DdlElement now)
    {
        if (!ValuesNameAttributes(now)) return;
        Members(was, now, "EntityAttribute");
        if (now.Kind == "StaticEntity") Records(was, now);
        Indexes(was, now);
        Events(was, now);
    }

    // The attributes of a statement sent whole: kept by key (renamed, changed), new (created), absent (deleted), and their order.
    private void Members(DdlElement was, DdlElement now, string kind)
    {
        var kept = new HashSet<string>(StringComparer.Ordinal);
        foreach (var member in now.Children.Where(c => c.Kind == kind)) {
            if (member.Key.Length == 0) { NewAttribute(member, Ref(now)); continue; }
            if (!baseByKey.TryGetValue(member.Key, out var before)) { Foreign(member); continue; }
            if (before.Parent?.Key != was.Key) {
                Problem(member, "DDL_PARENT_CHANGED", $"@{member.Key} is {Describe(before)} of {Describe(before.Parent)}, written here inside {Describe(now)}",
                    $"an attribute stays in its {Words(before.Parent!)}: write it there; here, write a new one without a key");
                continue;
            }
            if (before.Kind != member.Kind) { Problem(member, "DDL_KIND_CHANGED", $"@{member.Key} is {Describe(before)}", "keep its kind"); continue; }
            kept.Add(member.Key);
            if (before.Name != member.Name) Rename(before, member);
            Properties(before, member);
        }
        foreach (var gone in was.Children.Where(c => c.Kind == kind && !kept.Contains(c.Key) && !editByKey.ContainsKey(c.Key))) Delete(gone, now);
        Order(was.Children.Where(c => c.Kind == kind && kept.Contains(c.Key)).Select(Ref)
            .Concat(now.Children.Where(c => c.Kind == kind && c.Key.Length == 0).Select(Ref)).ToList(),
            now.Children.Where(c => c.Kind == kind && (c.Key.Length == 0 || kept.Contains(c.Key))).ToList());
    }

    // move ops that turn the order the module will have (current, the deleted ones out, the new ones at the end) into the
    // order of the text: each member out of place goes after the one the text writes before it (or first).
    private void Order(List<string> current, List<DdlElement> wanted)
    {
        var order = new List<string>(current);
        for (var i = 0; i < wanted.Count; i++) {
            var reference = Ref(wanted[i]);
            if (i < order.Count && order[i] == reference) continue;
            order.Remove(reference);
            order.Insert(i, reference);
            Step(moves, wanted[i], i == 0 ? Op("move", ("target", reference), ("first", true)) : Op("move", ("target", reference), ("after", Ref(wanted[i - 1]))));
        }
    }

    private void Records(DdlElement was, DdlElement now)
    {
        // Without `values` the statement says nothing of the records: they stay as they are.
        if (!now.HasValues) return;
        var kept = new HashSet<string>(StringComparer.Ordinal);
        var names = AttributeNames(was, now);
        foreach (var record in now.Children.Where(IsRecord)) {
            if (record.Key.Length == 0) { NewRecord(record, Ref(now)); continue; }
            if (!baseByKey.TryGetValue(record.Key, out var before)) { Foreign(record); continue; }
            if (before.Parent?.Key != was.Key) {
                Problem(record, "DDL_PARENT_CHANGED", $"@{record.Key} is the record {DdlRules.Name(before.Name)} of {Describe(before.Parent)}, written here in {Describe(now)}",
                    "a record stays in its static entity: write it there; here, write a new one without a key");
                continue;
            }
            kept.Add(record.Key);
            if (before.Name != record.Name) Rename(before, record);
            Properties(before, record);
            Values(before, record, names, "@" + record.Key);
        }
        foreach (var gone in was.Children.Where(c => IsRecord(c) && c.Parent?.Kind == "StaticEntity" && !kept.Contains(c.Key) && !editByKey.ContainsKey(c.Key))) Delete(gone, now);
    }

    // The attribute names of the base, by the key of the attribute, in the edit's names (a renamed attribute keeps its key).
    private static Dictionary<string, string> AttributeNames(DdlElement was, DdlElement now)
    {
        var current = now.Children.Where(c => c.Kind == "EntityAttribute" && c.Key.Length > 0).ToDictionary(c => c.Key, c => c.Name, StringComparer.Ordinal);
        var names = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var attribute in was.Children.Where(c => c.Kind == "EntityAttribute"))
            names[attribute.Name] = current.GetValueOrDefault(attribute.Key) ?? attribute.Name;
        return names;
    }

    // A record's values (Attribute = expression) by attribute: set where the edit gives another expression, cleared where it
    // gives none (the path names the attribute as the edit does: renames run before). The value of an attribute the edit
    // deletes goes with it: never cleared first.
    private void Values(DdlElement was, DdlElement now, Dictionary<string, string> names, string target)
    {
        var before = was.Values.GroupBy(v => names.GetValueOrDefault(v.Attribute) ?? v.Attribute, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.First().Value, StringComparer.Ordinal);
        var after = now.Values.GroupBy(v => v.Attribute, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.First().Value, StringComparer.Ordinal);
        var attributes = now.Parent?.Children.Where(c => c.Kind == "EntityAttribute").Select(c => c.Name).ToHashSet(StringComparer.Ordinal);
        foreach (var attribute in before.Keys.Union(after.Keys).Order(StringComparer.Ordinal)) {
            var a = before.GetValueOrDefault(attribute); var b = after.GetValueOrDefault(attribute);
            if (DdlRules.Same(a, b)) continue;
            if (b == null && attributes != null && !attributes.Contains(attribute)) continue;
            Step(sets, now, Op("set", ("target", target + "/" + attribute), ("prop", "Value"), ("value", b ?? "")));
        }
    }

    private void Indexes(DdlElement was, DdlElement now)
    {
        var names = AttributeKeys(now);
        foreach (var index in now.Children.Where(c => c.Kind == "EntityIndex")) {
            if (index.Key.Length == 0) { NewIndex(index, now, Ref(now)); continue; }
            if (!baseByKey.TryGetValue(index.Key, out var before) || before.Parent?.Key != was.Key) { Foreign(index); continue; }
            var beforeColumns = before.Columns.Select(c => was.Children.FirstOrDefault(a => a.Kind == "EntityAttribute" && a.Name == c)?.Key ?? "?" + c).ToList();
            var afterColumns = index.Columns.Select(c => names.GetValueOrDefault(c) ?? "?" + c).ToList();
            if (!beforeColumns.SequenceEqual(afterColumns)) {
                // Other columns are another index: the old one goes and the new one comes (its key changes, reported).
                Step(indexDrops, index, Op("delete", ("target", "@" + index.Key)));
                result.Deleted.Add(new JsonObject { ["kind"] = "EntityIndex", ["name"] = Qualified(before), ["key"] = before.Key, ["keyChanged"] = true });
                index.Key = "";
                NewIndex(index, now, Ref(now));
                continue;
            }
            if (before.Name != index.Name) Rename(before, index);
            if (!DdlRules.Same(before.Props.GetValueOrDefault("Unique"), index.Props.GetValueOrDefault("Unique")))
                Step(sets, index, new JsonObject { ["op"] = "set", ["target"] = "@" + index.Key, ["prop"] = "Unique", ["value"] = index.Props.GetValueOrDefault("Unique") == "True" });
            Properties(before, index);
        }
    }

    private static Dictionary<string, string> AttributeKeys(DdlElement entity) =>
        entity.Children.Where(c => c.Kind == "EntityAttribute").GroupBy(c => c.Name, StringComparer.Ordinal)
            .ToDictionary(g => g.Key, g => g.First().Key.Length > 0 ? g.First().Key : "new:" + g.Key, StringComparer.Ordinal);

    // The entity events of ODC (on create|update|delete E -> Handler(args)) and its sample record: their own statements, edited
    // by key; an event line with no key gives the entity's event a handler; one with `-> none()` takes it away.
    private void Events(DdlElement was, DdlElement now)
    {
        foreach (var @event in now.Children.Where(c => DdlRules.IsEventKind(c.Kind))) {
            var target = @event.Key.Length > 0 ? "@" + @event.Key : Ref(now) + "/" + @event.Kind[..^"LifeCycleDatabaseEvent".Length];
            var before = @event.Key.Length > 0 && baseByKey.TryGetValue(@event.Key, out var b) ? b : null;
            if (@event.Key.Length > 0 && before == null) { Foreign(@event); continue; }
            if (!DdlRules.Same(before?.Props.GetValueOrDefault("Destination"), @event.Props.GetValueOrDefault("Destination")))
                Step(sets, @event, Op("set", ("target", target), ("prop", "Destination"), ("value", ActionRef(@event.Props.GetValueOrDefault("Destination")))));
            Arguments(before, @event, target);
        }
        foreach (var sample in now.Children.Where(c => IsRecord(c) && now.Kind != "StaticEntity")) {
            var target = sample.Key.Length > 0 ? "@" + sample.Key : Ref(now) + "/SampleRecord";
            var before = sample.Key.Length > 0 && baseByKey.TryGetValue(sample.Key, out var b) ? b : new DdlElement();
            Values(before, sample, AttributeNames(was, now), target);
        }
    }

    // A call's arguments (a timer's `with (…)`, an event's handler): set by parameter where the expression changes.
    private void Arguments(DdlElement? was, DdlElement now, string target)
    {
        var before = (was?.Arguments ?? []).GroupBy(a => a.Parameter, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.First().Value, StringComparer.Ordinal);
        var after = now.Arguments.GroupBy(a => a.Parameter, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.First().Value, StringComparer.Ordinal);
        foreach (var parameter in before.Keys.Union(after.Keys).Order(StringComparer.Ordinal)) {
            var a = before.GetValueOrDefault(parameter); var b = after.GetValueOrDefault(parameter);
            if (DdlRules.Same(a, b)) continue;
            Step(sets, now, Op("set", ("target", target + "/arg:" + parameter), ("prop", "Value"), ("value", b ?? "")));
        }
    }

    // ---- new elements ------------------------------------------------------------------------------------------------------

    private void NewAttribute(DdlElement attribute, string parent)
    {
        var alias = Alias(attribute);
        Step(creates, attribute, Op("create", ("parent", parent), ("type", attribute.Kind == "StructureAttribute" ? "IStructureAttribute" : "IEntityAttribute"),
            ("name", attribute.Name), ("as", alias)));
        Written(creates, attribute, alias, first: ["DataType", "Length", "Decimals"]);
        result.Created.Add(attribute);
    }

    private void NewRecord(DdlElement record, string parent)
    {
        var alias = Alias(record);
        Step(creates, record, Op("create", ("parent", parent), ("type", "IRecord"), ("name", record.Name), ("as", alias)));
        foreach (var (attribute, value) in record.Values)
            Step(creates, record, Op("set", ("target", alias + "/" + attribute), ("prop", "Value"), ("value", value)));
        Written(creates, record, alias, first: []);
        result.Created.Add(record);
    }

    private void NewIndex(DdlElement index, DdlElement entity, string parent)
    {
        if (entity.Kind != "ServerEntity") {
            Problem(index, "DDL_UNSUPPORTED", $"index {DdlRules.Name(index.Name)}: only an entity of the module's own database takes an index ({Describe(entity)})", "remove the index");
            return;
        }
        var columns = new JsonArray();
        foreach (var column in index.Columns) {
            if (entity.Children.FirstOrDefault(c => c.Kind == "EntityAttribute" && c.Name == column) is not { } attribute) {
                Unknown(index, "column", column, entity);
                return;
            }
            columns.Add((JsonNode)Ref(attribute));
        }
        var alias = Alias(index);
        Step(indexCreates, index, new JsonObject { ["op"] = "create", ["parent"] = parent, ["type"] = "EntityIndex", ["name"] = index.Name, ["as"] = alias,
            ["args"] = new JsonObject { ["unique"] = index.Props.GetValueOrDefault("Unique") == "True", ["attributes"] = columns } });
        result.Created.Add(index);
    }

    // A site property (setting), client or session variable, or timer: create, then what the text writes.
    private void NewDeclaration(DdlElement element)
    {
        var alias = Alias(element);
        var type = element.Kind switch { "SiteProperty" => "ISiteProperty", "ClientVariable" => "IClientVariable", "SessionVariable" => "ISessionVariable", _ => "ITimer" };
        Step(creates, element, Op("create", ("parent", "@espace"), ("type", type), ("name", element.Name), ("as", alias)));
        if (element.Kind == "Timer" && element.Props.GetValueOrDefault("Action") is { } action)
            Step(creates, element, Op("set", ("target", alias), ("prop", "Action"), ("value", ActionRef(action))));
        Written(creates, element, alias, first: ["DataType", "Length", "Decimals"]);
        if (element.Kind == "Timer") foreach (var (parameter, value) in element.Arguments)
            Step(creates, element, Op("set", ("target", alias + "/arg:" + parameter), ("prop", "Value"), ("value", value)));
        result.Created.Add(element);
    }

    // The properties a new element's text writes, as sets on its alias (the `first` ones first, in that order).
    private void Written(List<DdlStep> phase, DdlElement element, string alias, string[] first)
    {
        foreach (var property in first.Where(element.Props.ContainsKey).Concat(element.Props.Keys.Where(p => !first.Contains(p)).Order(StringComparer.Ordinal))) {
            if (property is "Identifier" or "Unique" or "Action" or "Destination") continue;
            if (property == "Folder") { Step(sets, element, Op("move", ("target", alias), ("into", element.Props[property] is { } f ? "folder:" + f : "@espace"))); continue; }
            Set(AttributeRefs.Contains(property) ? sets : phase, element, alias, property, element.Props[property], null);
        }
    }

    private void NewEntity(DdlElement entity)
    {
        if (!ValuesNameAttributes(entity)) return;
        var section = entity.Kind == "ClientEntity" ? "clientEntities" : "entities";
        var entry = Declaration(entity, entity.Kind == "ServerEntity" ? ["public", "description", "label", "updateBehavior", "folder", "labelAttribute"] : ["public", "description", "label", "folder", "labelAttribute"]);
        var attributes = entity.Children.Where(c => c.Kind == "EntityAttribute").ToList();
        var identifier = entity.Props.GetValueOrDefault("Identifier");
        var id = attributes.FirstOrDefault(a => a.Name == identifier);
        // The spec writes the identifier Id first (Long Integer, AutoNumber on the server); another one is declared as written.
        var specId = id != null && id.Name == "Id" && attributes[0] == id;
        if (!specId) entry["id"] = false;
        else if (id!.Props.GetValueOrDefault("DataType") is { } idType && idType != "Long Integer") entry["idType"] = idType;
        var specAttributes = new JsonArray();
        var order = new List<string>();
        if (specId) { result.Aliases[id!] = "$" + entity.Name + ".Id"; result.Created.Add(id!); order.Add("$" + entity.Name + ".Id"); }
        foreach (var attribute in attributes) {
            if (specId && attribute == id) continue;
            specAttributes.Add(AttributeSpec(entity, attribute, isStatic: false));
            order.Add("$" + entity.Name + "." + attribute.Name);
        }
        if (specAttributes.Count > 0) entry["attributes"] = specAttributes;
        if (specId) {
            // What the spec writes on its Id (AutoNumber on the server, none on the client) and the text may say otherwise.
            var auto = id!.Props.GetValueOrDefault("IsAutoNumber") is "Yes" or "True";
            if (auto != (entity.Kind == "ServerEntity")) Step(sets, id, Op("set", ("target", "$" + entity.Name + ".Id"), ("prop", "IsAutoNumber"), ("value", auto ? "Yes" : "No")));
            foreach (var property in id.Props.Keys.Where(p => p is not ("DataType" or "IsAutoNumber" or "IsMandatory")).Order(StringComparer.Ordinal))
                Set(sets, id, "$" + entity.Name + ".Id", property, id.Props[property], null);
        }
        else if (id != null)
            Step(sets, entity, Op("set", ("target", "$" + entity.Name), ("prop", "IdentifierAttribute"), ("value", "$" + entity.Name + "." + id.Name)));
        var indexes = new JsonArray();
        foreach (var index in entity.Children.Where(c => c.Kind == "EntityIndex")) {
            if (entity.Kind != "ServerEntity") { NewIndex(index, entity, "$" + entity.Name); continue; }
            var missing = index.Columns.FirstOrDefault(c => attributes.All(a => a.Name != c));
            if (missing != null) { Unknown(index, "column", missing, entity); continue; }
            indexes.Add(new JsonObject { ["name"] = index.Name, ["unique"] = index.Props.GetValueOrDefault("Unique") == "True",
                ["attributes"] = new JsonArray(index.Columns.Select(c => (JsonNode)c).ToArray()), ["_line"] = index.Line });
            Residual(index, "$" + entity.Name + "/" + index.Name, ["Unique"]);
            result.Created.Add(index);
        }
        if (indexes.Count > 0) entry["indexes"] = indexes;
        Section(section, entry, entity);
        Residual(entity, "$" + entity.Name, Taken(entry));
        if (entity.Children.Any(c => DdlRules.IsEventKind(c.Kind) || IsRecord(c))) Events(new DdlElement(), entity);
        AttributeOrder(entity, order);
    }

    // Every value of a record (and of an ODC sample record) names an attribute of its entity.
    private bool ValuesNameAttributes(DdlElement entity)
    {
        var names = entity.Children.Where(c => c.Kind == "EntityAttribute").Select(c => c.Name).ToHashSet(StringComparer.Ordinal);
        var good = true;
        foreach (var record in entity.Children.Where(IsRecord))
            foreach (var (attribute, _) in record.Values.Where(v => !names.Contains(v.Attribute))) { Unknown(record, "value of", attribute, entity); good = false; }
        return good;
    }

    private void NewStatic(DdlElement entity)
    {
        if (!ValuesNameAttributes(entity)) return;
        var entry = Declaration(entity, ["public", "description", "folder", "labelAttribute", "activeAttribute", "restrictedInQueries"]);
        var attributes = entity.Children.Where(c => c.Kind == "EntityAttribute").ToList();
        var specAttributes = new JsonArray();
        var named = attributes.ToDictionary(a => a.Name, StringComparer.Ordinal);
        foreach (var attribute in attributes) specAttributes.Add(AttributeSpec(entity, attribute, isStatic: true));
        if (specAttributes.Count > 0) entry["attributes"] = specAttributes;
        // The spec creates Id, Label and Order first; the others follow in the text's order.
        var order = new List<string> { "$" + entity.Name + ".Id", "$" + entity.Name + ".Label", "$" + entity.Name + ".Order" };
        order.AddRange(attributes.Where(a => a.Name is not ("Id" or "Label" or "Order")).Select(a => "$" + entity.Name + "." + a.Name));
        foreach (var conventional in new[] { "Id", "Label", "Order" }.Where(n => !named.ContainsKey(n))) {
            // An attribute of the spec's convention the text does not have: the entity stops pointing at it, then it goes.
            var property = conventional switch { "Id" => "IdentifierAttribute", "Label" => "LabelAttribute", _ => "OrderByAttribute" };
            var replacement = conventional == "Id" ? entity.Props.GetValueOrDefault("Identifier") : entity.Props.GetValueOrDefault(property);
            Step(sets, entity, Op("set", ("target", "$" + entity.Name), ("prop", property), ("value", replacement == null ? null : "$" + entity.Name + "." + replacement)));
            Step(deletes, entity, Op("delete", ("target", "$" + entity.Name + "." + conventional)));
            order.Remove("$" + entity.Name + "." + conventional);
        }
        // Records: the Id, Label and Order the spec writes, taken from the text's values when they are its plain literals;
        // any other value is written as the text has it.
        var records = new JsonArray();
        var ids = entity.Children.Where(IsRecord).Select(r => r.Values.FirstOrDefault(v => v.Attribute == "Id").Value).ToList();
        var plainIds = named.ContainsKey("Id") && ids.All(v => int.TryParse(v, out var n) && n > 0) && ids.Distinct().Count() == ids.Count;
        var position = 0;
        foreach (var record in entity.Children.Where(IsRecord)) {
            position++;
            var entryRecord = new JsonObject { ["name"] = record.Name, ["_line"] = record.Line };
            var values = record.Values.GroupBy(v => v.Attribute, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.First().Value, StringComparer.Ordinal);
            if (plainIds) entryRecord["id"] = int.Parse(values["Id"]);
            if (values.GetValueOrDefault("Label") is { } label && PlainText(label) is { } plain && named.ContainsKey("Label")) entryRecord["label"] = plain;
            if (values.GetValueOrDefault("Order") is { } orderValue && int.TryParse(orderValue, out var n) && named.ContainsKey("Order")) entryRecord["order"] = n;
            foreach (var (attribute, value) in values)
                if (attribute is not ("Id" or "Label" or "Order") && named.ContainsKey(attribute)) entryRecord[attribute] = value;
            records.Add(entryRecord);
            var alias = "$" + entity.Name + "." + record.Name;
            result.Aliases[record] = alias;
            // What the spec writes otherwise (Id = position, Label = "<name>", Order = position) set to the text's value.
            foreach (var conventional in new[] { "Id", "Label", "Order" }.Where(named.ContainsKey)) {
                var written = values.GetValueOrDefault(conventional);
                var specWrites = conventional switch {
                    "Id" => plainIds ? written : position.ToString(), "Label" => entryRecord["label"] is { } l ? written : "\"" + record.Name.Replace("\"", "\"\"") + "\"",
                    _ => entryRecord["order"] is { } ? written : position.ToString() };
                if (!DdlRules.Same(specWrites, written)) Step(sets, record, Op("set", ("target", alias + "/" + conventional), ("prop", "Value"), ("value", written ?? "")));
            }
            Residual(record, alias, []);
            result.Created.Add(record);
        }
        if (records.Count > 0) entry["records"] = records;
        Section("static", entry, entity);
        Residual(entity, "$" + entity.Name, Taken(entry));
        AttributeOrder(entity, order);
    }

    private void NewStructure(DdlElement structure)
    {
        var entry = Declaration(structure, ["public", "description", "folder"]);
        var attributes = new JsonArray();
        foreach (var attribute in structure.Children.Where(c => c.Kind == "StructureAttribute")) attributes.Add(AttributeSpec(structure, attribute, isStatic: false));
        if (attributes.Count > 0) entry["attributes"] = attributes;
        Section("structures", entry, structure);
        Residual(structure, "$" + structure.Name, Taken(entry));
    }

    // The spec keys of a declaration that the text writes (name, public, description, …).
    private JsonObject Declaration(DdlElement element, string[] keys)
    {
        var entry = new JsonObject { ["name"] = element.Name, ["_line"] = element.Line };
        foreach (var key in keys) {
            var property = SpecProperty(key);
            if (!element.Props.TryGetValue(property, out var value) || value == null) continue;
            entry[key] = key switch {
                "public" or "restrictedInQueries" => value is "True" or "Yes" ? JsonValue.Create(true) : null,
                "updateBehavior" => value,
                _ => value };
            if (entry[key] == null) entry.Remove(key);
        }
        if (element.Kind == "ServerEntity" && element.Props.GetValueOrDefault("Public") == "True" && element.Props.GetValueOrDefault("ExposeReadOnly") is "False")
            entry["readOnly"] = false;
        return entry;
    }

    private static string SpecProperty(string key) => key switch {
        "public" => "Public", "description" => "Description", "label" => "Label", "updateBehavior" => "UpdateBehavior", "folder" => "Folder",
        "labelAttribute" => "LabelAttribute", "activeAttribute" => "IsActiveAttribute", "restrictedInQueries" => "IsRestrictedInQueries",
        "mandatory" => "IsMandatory", "default" => "DefaultValue", "deleteRule" => "DeleteRule", "nameInJSON" => "NameInJSON",
        "length" => "Length", "decimals" => "Decimals", "type" => "DataType", _ => key };

    // The Model API properties a spec entry takes care of.
    private static HashSet<string> Taken(JsonObject entry)
    {
        var taken = new HashSet<string>(entry.Select(p => SpecProperty(p.Key)), StringComparer.Ordinal) { "Identifier", "Description" };
        if (entry.ContainsKey("readOnly")) taken.Add("ExposeReadOnly");
        return taken;
    }

    // An attribute as the spec writes it, and a set for every property it writes otherwise (or not at all).
    private JsonObject AttributeSpec(DdlElement owner, DdlElement attribute, bool isStatic)
    {
        var entry = new JsonObject { ["name"] = attribute.Name, ["_line"] = attribute.Line };
        var props = attribute.Props;
        entry["type"] = props.GetValueOrDefault("DataType") ?? "Text";
        var taken = new HashSet<string>(StringComparer.Ordinal) { "DataType", "Description" };
        foreach (var (key, property) in new[] { ("length", "Length"), ("decimals", "Decimals") })
            if (props.GetValueOrDefault(property) is { } size && int.TryParse(size, out var number) && number >= 0) { entry[key] = number; taken.Add(property); }
        if (props.GetValueOrDefault("IsMandatory") == "True") { entry["mandatory"] = true; taken.Add("IsMandatory"); }
        if (props.GetValueOrDefault("DefaultValue") is { } value) { entry["default"] = value; taken.Add("DefaultValue"); }
        if (props.GetValueOrDefault("Description") is { } description) entry["description"] = description;
        if (props.TryGetValue("Label", out var label) && label != null) { entry["label"] = label; taken.Add("Label"); }
        if (props.GetValueOrDefault("NameInJSON") is { } json) { entry["nameInJSON"] = json; taken.Add("NameInJSON"); }
        if (owner.Kind != "Structure" && props.GetValueOrDefault("DeleteRule") is { } rule && (props.GetValueOrDefault("DataType") ?? "").EndsWith(" Identifier", StringComparison.Ordinal)) {
            entry["deleteRule"] = rule; taken.Add("DeleteRule");
        }
        // The static Id of the spec is never AutoNumber: so is the text's (DdlConventions leaves `auto` out of a new one).
        if (isStatic && attribute.Name == "Id") taken.Add("IsAutoNumber");
        var alias = "$" + owner.Name + "." + attribute.Name;
        result.Aliases[attribute] = alias;
        Residual(attribute, alias, taken);
        result.Created.Add(attribute);
        return entry;
    }

    // The sets of what a spec entry does not write: every other property of the text, with the attribute refs by alias.
    private void Residual(DdlElement element, string alias, ICollection<string> taken)
    {
        foreach (var property in element.Props.Keys.Order(StringComparer.Ordinal)) {
            if (taken.Contains(property) || property is "Identifier" or "Unique" or "Action" or "Destination") continue;
            if (property == "Folder") { Step(sets, element, Op("move", ("target", alias), ("into", element.Props[property] is { } f ? "folder:" + f : "@espace"))); continue; }
            if (property is "Length" or "Decimals" && element.Props[property] is { } size) {
                Step(sets, element, Op("set", ("target", alias), ("prop", property), ("value", size)));
                continue;
            }
            Set(sets, element, alias, property, element.Props[property], null);
        }
    }

    private void AttributeOrder(DdlElement owner, List<string> specOrder)
    {
        var wanted = owner.Children.Where(c => c.Kind is "EntityAttribute" or "StructureAttribute").ToList();
        Order(specOrder, wanted);
    }

    private void Section(string section, JsonObject entry, DdlElement element)
    {
        if (spec[section] is not JsonArray list) spec[section] = list = new JsonArray();
        list.Add(entry);
        specLines.Add(element.Line);
        result.Aliases[element] = "$" + element.Name;
        result.Created.Add(element);
    }

    // ---- helpers ---------------------------------------------------------------------------------------------------------

    // The steps that free a name: the scope and the name they free ("type:Produto", "@<parent key>:Nome").
    private readonly Dictionary<DdlStep, string> freed = new(ReferenceEqualityComparer.Instance);

    private string Scope(DdlElement element) => Scope(element, element.Name);

    private static string Scope(DdlElement element, string name) =>
        (element.Parent == null ? Family(element.Kind) : (element.Parent.Key.Length > 0 ? "@" + element.Parent.Key : "new:" + element.Parent.Name)) + ":" + name;

    private void Frees(List<DdlStep> phase, DdlElement element)
    {
        if (phase.Count > 0) freed[phase[^1]] = Scope(element, element.Name);
    }

    private void Rename(DdlElement was, DdlElement now)
    {
        Step(renames, now, Op("rename", ("target", "@" + now.Key), ("name", now.Name)));
        Frees(renames, was);
        result.Renamed.Add(new JsonObject { ["kind"] = now.Kind, ["key"] = now.Key, ["from"] = Qualified(was), ["to"] = now.Name });
    }

    private void Delete(DdlElement gone, DdlElement owner)
    {
        Step(deletes, gone, Op("delete", ("target", "@" + gone.Key)), owner.Line);
        Frees(deletes, gone);
        result.Deleted.Add(new JsonObject { ["kind"] = gone.Kind, ["name"] = Qualified(gone), ["key"] = gone.Key });
    }

    private void Foreign(DdlElement element) =>
        Problem(element, "DDL_KEY_FOREIGN", $"@{element.Key} ({Words(element)} {DdlRules.Name(element.Name)}) is not a data element of this module",
            "read the module's data again (ssam_map view \"ddl\") and edit that text; a new element is written without a key");

    private void Unknown(DdlElement element, string what, string name, DdlElement owner)
    {
        var names = owner.Children.Where(c => c.Kind == "EntityAttribute").Select(c => c.Name).ToList();
        var closest = Closest(name, names);
        var corrected = closest.Count == 1 && element.Line > 0 ? ReplaceWord(element.Line, name, closest[0]) : null;
        Problem(element, "DDL_NAME_UNKNOWN", $"{Words(element)} {DdlRules.Name(element.Name)}: {what} {DdlRules.Name(name)} is not an attribute of {Describe(owner)}",
            closest.Count > 0 ? "use one of: " + string.Join(", ", closest) : "attributes of " + owner.Name + ": " + string.Join(", ", names), corrected);
    }

    private string AttributeRef(DdlElement owner, string? name)
    {
        if (name == null) return "";
        if (owner.Children.FirstOrDefault(c => c.Kind == "EntityAttribute" && c.Name == name) is { } attribute) return Ref(attribute);
        Unknown(owner, "attribute", name, owner);
        return "";
    }

    private static string? ActionRef(string? name) => name == null ? null : "IServerAction:" + name;

    private static DdlElement Owner(DdlElement element) => element.Kind is "EntityAttribute" or "StructureAttribute" ? element.Parent ?? element : element;

    // The reference of an element in the ops: its key, or the $alias of the op that creates it.
    private string Ref(DdlElement element)
    {
        if (element.Key.Length > 0) return "@" + element.Key;
        if (result.Aliases.TryGetValue(element, out var alias)) return alias;
        return Alias(element);
    }

    private string Alias(DdlElement element)
    {
        if (result.Aliases.TryGetValue(element, out var alias)) return alias;
        alias = prefix + "~" + ++aliases;
        result.Aliases[element] = alias;
        return alias;
    }

    private void Step(List<DdlStep> phase, DdlElement element, JsonObject op, int? line = null) =>
        phase.Add(new DdlStep(op, line ?? element.Line, Qualified(element)));

    private static JsonObject Op(string verb, params (string Key, object? Value)[] fields)
    {
        var op = new JsonObject { ["op"] = verb };
        foreach (var (key, value) in fields) op[key] = value switch { null => null, bool b => JsonValue.Create(b), JsonNode n => n, _ => JsonValue.Create(value.ToString()) };
        return op;
    }

    private void Problem(DdlElement element, string code, string message, string fix, string? corrected = null) =>
        result.Problems.Add(new DdlProblem(element.Line, code, message, fix, corrected));

    private static bool IsRecord(DdlElement element) => element.Kind is "Record" or "StaticEntityRecord";
    private static bool SameKind(DdlElement a, DdlElement b) => a.Kind == b.Kind || IsRecord(a) && IsRecord(b);

    // Names one family shares (entities and structures are types, a variable kind its own).
    private static string Family(string kind) => DdlRules.IsEntityKind(kind) || kind == "Structure" ? "type" : kind;

    private static string Qualified(DdlElement element) => (element.Parent != null && element.Parent.Name.Length > 0 ? element.Parent.Name + "." : "") + element.Name;

    private string Words(DdlElement element) => element.Kind switch {
        "EntityAttribute" or "StructureAttribute" => "attribute", "Record" or "StaticEntityRecord" => "record", "EntityIndex" => "index", "Structure" => "type",
        "SiteProperty" => lane == "odc" ? "setting" : "site property", "ClientVariable" => "client variable", "SessionVariable" => "session variable", "Timer" => "timer",
        _ when DdlRules.IsEventKind(element.Kind) => "event",
        _ => DdlRules.EntityWords(element.Kind) + "entity" };

    private string Describe(DdlElement? element) => element == null ? "?" : Words(element) + " " + DdlRules.Name(Qualified(element)) + (element.Key.Length > 0 ? " (@" + element.Key + ")" : "");

    // A plain OutSystems text literal ("…" with "" for a quote), unquoted; null for any other expression.
    private static string? PlainText(string expression)
    {
        if (expression.Length < 2 || expression[0] != '"' || expression[^1] != '"') return null;
        var inner = expression[1..^1];
        for (var i = 0; i < inner.Length; i++) {
            if (inner[i] != '"') continue;
            if (i + 1 < inner.Length && inner[i + 1] == '"') { i++; continue; }
            return null;
        }
        return inner.Replace("\"\"", "\"");
    }

    // The closest names: equal but for the case, else within two edits, else sharing 70% of the name as prefix or suffix.
    private static List<string> Closest(string name, IReadOnlyList<string> names)
    {
        var same = names.Where(n => string.Equals(n, name, StringComparison.OrdinalIgnoreCase)).ToList();
        if (same.Count > 0) return same;
        var near = names.Select(n => (n, d: Distance(n.ToLowerInvariant(), name.ToLowerInvariant()))).Where(x => x.d <= 2).OrderBy(x => x.d).ThenBy(x => x.n, StringComparer.Ordinal).Select(x => x.n).ToList();
        if (near.Count > 0) return near.Take(3).ToList();
        var share = (int)Math.Ceiling(name.Length * 0.7);
        return names.Where(n => n.Length >= share && (n.StartsWith(name[..share], StringComparison.OrdinalIgnoreCase) || n.EndsWith(name[^share..], StringComparison.OrdinalIgnoreCase))).Take(3).ToList();
    }

    private static int Distance(string a, string b)
    {
        var d = new int[a.Length + 1, b.Length + 1];
        for (var i = 0; i <= a.Length; i++) d[i, 0] = i;
        for (var j = 0; j <= b.Length; j++) d[0, j] = j;
        for (var i = 1; i <= a.Length; i++)
            for (var j = 1; j <= b.Length; j++)
                d[i, j] = Math.Min(Math.Min(d[i - 1, j] + 1, d[i, j - 1] + 1), d[i - 1, j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1));
        return d[a.Length, b.Length];
    }

    // The text with one line replaced, or a word of it: the corrected text of a certain fix.
    private string? Replace(int line, string with)
    {
        if (text.Length == 0) return null;
        var lines = text.Replace("\r\n", "\n").Split('\n');
        if (line < 1 || line > lines.Length) return null;
        lines[line - 1] = with;
        return string.Join('\n', lines);
    }

    private string? ReplaceWord(int line, string word, string with)
    {
        if (text.Length == 0) return null;
        var lines = text.Replace("\r\n", "\n").Split('\n');
        if (line < 1 || line > lines.Length) return null;
        var pattern = new System.Text.RegularExpressions.Regex(@"(?<![\w\]])" + System.Text.RegularExpressions.Regex.Escape(word) + @"(?![\w\[])");
        if (pattern.Matches(lines[line - 1]).Count != 1) return null;
        lines[line - 1] = pattern.Replace(lines[line - 1], DdlRules.Name(with), 1);
        return string.Join('\n', lines);
    }
}
