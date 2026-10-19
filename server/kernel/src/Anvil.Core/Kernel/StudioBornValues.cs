using System.Collections;
using System.Globalization;
using System.Text.Json.Nodes;
using Anvil.Reading;
using OutSystems.Model;
using ServiceStudio.Model;

namespace Anvil.Core;

/// <summary>
/// What the installed Studio gives an element of each kind of a page when it creates it: the values a fresh element is born
/// with, through the Model API create the html writer uses (ModelSession "create"), in a fresh screen and a fresh block of a
/// disposable copy of the module being read. What a fresh element is born with depends on the Studio, on the module (its
/// kind: a Mobile app's Upload takes images) and on the theme of the UI flow the page is in (its grid, and the grid of the
/// themes it is based on: a page of a flow whose theme has no grid is born without one), so the copy is of the module itself
/// and the pages are created in the flow StudioDefaults prepares for the context it measures (a fresh UI flow with that theme:
/// never one of the module's flows, which the Model API gives in another order on each load). The values are the Studio's;
/// what is fixed here is only the recipe: which kinds to create (the kinds the reading writes: its element table, the data of
/// a page, the parts of an aggregate) and the fresh parents they are created in: a screen where the flow takes one, else (a
/// library) a block as the page. Every element a created one is born with is measured too (the events of a widget, the
/// branches of an If, a Content), and a native event is measured as the writer leaves it, with a destination. The screen's
/// own layout (a block instance of the theme) is never measured: it is the module's content, not what the Studio gives.
/// Each widget kind is measured twice: on the page and inside a fresh Popup (an element inside a Popup is born with the
/// Popup's own values, such as the Transition of its events).
/// Which of these values are defaults of the reading is the reading's rule (ScreenDefaults.FromBorn), never decided here.
/// </summary>
internal static class StudioBornValues
{
    // The data of a page the reading writes (WriteData), created in the fresh screen.
    private static readonly string[] DataKinds = ["LocalVariable", "InputParameter", "ScreenAction", "ScreenAggregate", "DataAction"];
    // The parts of an aggregate (joins, filters and sorts) after its two sources.
    private static readonly string[] QueryKinds = ["Join", "Filter", "Sort"];
    // The flows and pages of the recipe, after the kinds the module itself has (by name): a UI flow, a screen and a block
    // (Reactive and Mobile, then Traditional Web). The first one the Studio creates in the module is the one measured.
    internal static readonly string[] FlowKinds = ["MobileFlow", "WebFlow"];
    private static readonly string[] ScreenKinds = ["MobileScreen", "WebScreen"];
    private static readonly string[] BlockKinds = ["MobileBlock", "WebBlock"];

    /// <summary>The version of the recipe (part of the Studio identity a measurement is kept under): raise it on every change of
    /// what is created or how. 3: in a fresh UI flow with the theme of the context, never in the first flow of the module. 4: the
    /// native Table and its cells (the element table reads them, ScreenHtml.WidgetTags); a kind may be created in the rows of a
    /// Table created before it (a header cell in its HeaderRow).</summary>
    public const int Recipe = 4;

    internal sealed record Measured(
        SortedDictionary<string, SortedDictionary<string, string>> Born,
        SortedDictionary<string, string> Roles,
        List<string> Log);

    /// <summary>The creates of one measurement in a disposable module, through the writer's create (ModelSession): what the Studio
    /// refuses is logged, never thrown.</summary>
    internal sealed class Creator(ESpace disposable)
    {
        public readonly ESpace Module = disposable;
        public readonly KernelModelReader Reader = new();
        public readonly ModelSession Session = new(disposable);
        public readonly List<string> Log = [];
        private int count;

        public string Role(IObjectSignature n) => ModuleIndex.Roles[ModuleIndex.RoleOf(Reader.KindOf(n), new HashSet<string>(Reader.KindNamesOf(n), StringComparer.Ordinal))];

        public IObjectSignature? Make(IObjectSignature parent, string kind, IObjectSignature? source = null, IObjectSignature? dataSource = null)
        {
            var at = (++count).ToString(CultureInfo.InvariantCulture);
            IObjectSignature? made = null;
            try {
                Session.Mutate("measure " + kind, () => {
                    Session.Register("$born.p" + at, parent);
                    var op = new JsonObject { ["op"] = "create", ["parent"] = "$born.p" + at, ["type"] = "I" + kind, ["as"] = "$born.n" + at };
                    if (source != null) { Session.Register("$born.s" + at, source); op["source"] = "$born.s" + at; op["empty"] = true; }
                    if (dataSource != null) { Session.Register("$born.d" + at, dataSource); op["args"] = new JsonObject { ["dataSource"] = "$born.d" + at }; }
                    Session.ApplyOne(op);
                    made = (IObjectSignature)Session.Resolve("$born.n" + at);
                });
            } catch (Exception error) { Log.Add("create " + kind + " under " + Reader.KindOf(parent) + ": " + error.GetBaseException().Message); }
            return made;
        }

        /// <summary>Sets a property in one command; false (and logged) when the Studio refuses.</summary>
        public bool Set(IObjectSignature target, string property, object? value)
        {
            try { Session.Mutate("measure " + property, () => PrototypeBuilder.SetProperty(target, property, value)); return true; }
            catch (Exception error) { Log.Add("set " + property + " of " + Reader.KindOf(target) + ": " + error.GetBaseException().Message); return false; }
        }

        /// <summary>The same through a property of the Model API (an interface's: the value is of its type).</summary>
        public bool Set(IObjectSignature target, System.Reflection.PropertyInfo property, object? value)
        {
            try { Session.Mutate("measure " + property.Name, () => property.SetValue(target, value)); return true; }
            catch (Exception error) { Log.Add("set " + property.Name + " of " + Reader.KindOf(target) + ": " + error.GetBaseException().Message); return false; }
        }

        /// <summary>The UI flows of the module, by name and key (the Model API gives them in another order on each load).</summary>
        public List<IObjectSignature> Flows() => Reader.ChildrenOf((IObjectSignature)Module).Where(n => Role(n) == "flow")
            .OrderBy(f => Reader.DisplayOf(f), StringComparer.Ordinal).ThenBy(f => Reader.KeyOf(f), StringComparer.Ordinal).ToList();

        /// <summary>A fresh UI flow of the module: of the first of these kinds the Studio creates in it.</summary>
        public IObjectSignature? NewFlow(IEnumerable<string> kinds)
        {
            foreach (var kind in kinds.Distinct())
                if (Make((IObjectSignature)Module, kind) is { } made) return made;
            return null;
        }
    }

    /// <summary>Kind (or Kind@popup) -> property -> "type:text" of every element the Studio created in <paramref name="flow"/> and
    /// every element they were born with (Born), and the role of each kind in the module index (Roles: widget, event,
    /// variable...). The module of <paramref name="maker"/> is changed: the caller loads it for this and releases it after.</summary>
    public static Measured Measure(Creator maker, IObjectSignature flow)
    {
        var r = maker.Reader;
        var born = new SortedDictionary<string, SortedDictionary<string, string>>(StringComparer.Ordinal);
        var roles = new SortedDictionary<string, string>(StringComparer.Ordinal);
        var log = maker.Log;
        var result = new Measured(born, roles, log);
        string Role(IObjectSignature n) => maker.Role(n);
        IObjectSignature? Make(IObjectSignature parent, string kind, IObjectSignature? source = null, IObjectSignature? dataSource = null) => maker.Make(parent, kind, source, dataSource);
        // The kinds of screen and block the module has first (by name), then the recipe's (a Reactive or Mobile page, a
        // Traditional Web one).
        var pages = maker.Flows().SelectMany(f => r.ChildrenOf(f)).Where(n => Role(n) is "screen" or "block").ToList();
        var screenKinds = pages.Where(p => Role(p) == "screen").Select(p => r.KindOf(p)).Distinct().Order(StringComparer.Ordinal).Concat(ScreenKinds).Distinct().ToList();
        var blockKinds = pages.Where(p => Role(p) == "block").Select(p => r.KindOf(p)).Distinct().Order(StringComparer.Ordinal)
            .Concat(screenKinds.Select(k => k.EndsWith("Screen", StringComparison.Ordinal) ? k[..^"Screen".Length] + "Block" : k)).Concat(BlockKinds).Distinct().ToList();
        IObjectSignature? Root(IEnumerable<string> kinds)
        {
            foreach (var kind in kinds)
                if (Make(flow, kind) is { } made) return made;
            return null;
        }
        // A screen where the flow takes one (a library takes none: its page is a block); a block in any case.
        var screen = Root(screenKinds);
        var block = Root(blockKinds);
        if ((screen ?? block) == null) { log.Add("the UI flow takes no screen or block: nothing measured"); return result; }
        // The page the widgets and the data are created in: the screen, else a second fresh block (the first one is the source of
        // the block instance measured on the page, and a block never holds an instance of itself).
        var host = screen ?? (block != null ? Make(flow, r.KindOf(block)) : null) ?? block!;
        // A screen action: the destination of every native event measured (the writer binds one before reading it back).
        var action = Make(host, "ScreenAction");
        void Destination(IObjectSignature evt)
        {
            try {
                maker.Session.Mutate("measure destination", () => PrototypeBuilder.SetProperty(evt, "Destination", action));
            } catch (Exception error) { log.Add("destination of " + r.KindOf(evt) + ": " + error.GetBaseException().Message); }
        }
        void Record(IObjectSignature node, string suffix, bool withBorn = true)
        {
            foreach (var n in withBorn ? r.Walk(node).ToList() : [node]) {
                var key = r.KindOf(n) + suffix;
                // An expression value is no element of the page (its text is the fact of its owner).
                if (born.ContainsKey(key) || Role(n) == "expression") continue;
                if (action != null && Role(n) == "event" && r.PropertyOf(n, "Destination") is { } destination && destination() == null) Destination(n);
                var facts = new SortedDictionary<string, string>(StringComparer.Ordinal);
                foreach (var (name, value) in r.PropertiesOf(n)) {
                    if (ModelReader<IObjectSignature>.IsNoise(name) || ScreenHtml.NotFacts.Contains(name)) continue;
                    object? v;
                    try { v = value(); } catch { continue; }
                    if (Fact(v, r) is { } fact) facts[name] = fact;
                }
                // The first element of a kind answers (the same kind is born the same: the tests measure it on several modules).
                born[key] = facts;
                roles[key] = Role(n);
            }
        }
        // The screen and the block themselves, not what the module's theme puts in them (their layout).
        if (screen != null) Record(screen, "", withBorn: false);
        else log.Add("not created: a screen (" + string.Join(", ", screenKinds) + "): the page is a block");
        // A block with an input, an event and a placeholder: its instance is born with an argument, a handler and a slot.
        if (block != null) {
            Record(block, "", withBorn: false);
            foreach (var kind in new[] { "InputParameter", "BlockEvent", "PlaceholderWidget" })
                if (Make(block, kind) is { } part) Record(part, "");
        } else log.Add("not created: a block (" + string.Join(", ", blockKinds) + ")");
        var page = Make(host, "Container") ?? host;
        var widgetKinds = ScreenHtml.WidgetTags.Keys.Where(k => k is not ("MobileBlockInstanceWidget" or "PlaceholderWidget")).Concat(["List", "AdvancedHtml"])
            .Distinct().Order(StringComparer.Ordinal).ToList();
        // Each kind under the first parent that takes it: the page's container, the screen, then what was created before it
        // (a radio button in its group, a list item in its list) and the rows of a Table (a header cell in its HeaderRow, a row
        // cell in its Row).
        bool Place(string kind, List<IObjectSignature> parents, string suffix)
        {
            foreach (var parent in parents.ToList())
                if (Make(parent, kind) is { } made) {
                    Record(made, suffix); parents.Add(made);
                    foreach (var row in new[] { "HeaderRow", "Row" })
                        if (r.PropertyOf(made, row)?.Invoke() is IObjectSignature held) parents.Add(held);
                    return true;
                }
            return false;
        }
        var parents = new List<IObjectSignature> { page, host };
        var pending = widgetKinds.Concat(DataKinds).ToList();
        for (var pass = 0; pass < 3 && pending.Count > 0; pass++)
            pending = pending.Where(kind => !Place(kind, parents, "")).ToList();
        foreach (var kind in pending) log.Add("not created: " + kind);
        if (block != null && !ReferenceEquals(block, host) && Make(page, "MobileBlockInstanceWidget", block) is { } instance) Record(instance, "");
        // The parts of an aggregate: two sources (two fresh entities), then a join, a filter and a sort.
        if (parents.FirstOrDefault(p => r.KindOf(p) == "ScreenAggregate") is { } aggregate) {
            var sources = 0;
            for (var e = 0; e < 2; e++)
                if (Make((IObjectSignature)maker.Module, "Entity") is { } entity && Make(aggregate, "AliasedSource", dataSource: entity) is { } src) { Record(src, ""); sources++; }
            if (sources == 2) foreach (var kind in QueryKinds) if (Make(aggregate, kind) is { } part) Record(part, ""); else log.Add("not created: " + kind);
        }
        // An HTML event of an HTML element and an extended property: the element's own factory, as the writer creates them.
        if (parents.FirstOrDefault(p => r.KindOf(p) == "AdvancedHtml") is { } html) {
            IObjectSignature? htmlEvent = null;
            try {
                maker.Session.Mutate("measure Event", () => {
                    var create = PrototypeBuilder.FindMethod(html, "CreateEvent") ?? throw new InvalidOperationException("no CreateEvent");
                    htmlEvent = create.Invoke(html, create.GetParameters().Select(p => p.HasDefaultValue ? p.DefaultValue : null).ToArray()) as IObjectSignature;
                    if (htmlEvent != null) PrototypeBuilder.SetProperty(htmlEvent, "Event", "onfocus");
                });
            } catch (Exception error) { log.Add("create Event: " + error.GetBaseException().Message); }
            if (htmlEvent != null) Record(htmlEvent, "");
            Place("ExtendedProperty", [html], "");
        }
        // Inside a fresh Popup: every widget kind again.
        if (parents.FirstOrDefault(p => r.KindOf(p) == "Popup") is { } popup) {
            var inside = Make(popup, "Container") ?? popup;
            Record(inside, ScreenDefaults.PopupSuffix);
            var popupParents = new List<IObjectSignature> { inside };
            var rest = widgetKinds.Where(k => k != "Popup").ToList();
            for (var pass = 0; pass < 3 && rest.Count > 0; pass++)
                rest = rest.Where(kind => !Place(kind, popupParents, ScreenDefaults.PopupSuffix)).ToList();
            foreach (var kind in rest) log.Add("not created in a popup: " + kind);
        }
        return result;
    }

    /// <summary>The fact a value is in the reading (ScreenHtmlModule.FactsOf), for the values that can be a default: an
    /// expression, a text, a boolean, an enumeration member or a number. Null for anything else.</summary>
    internal static string? Fact(object? value, KernelModelReader r) => value switch {
        null or byte[] => null,
        _ when r.ExpressionText(value) is { } expression => "e:" + expression,
        IObjectSignature => null,
        string s => "t:" + s,
        bool b => "b:" + (b ? "True" : "False"),
        IEnumerable => null,
        IFormattable f => "v:" + f.ToString(null, CultureInfo.InvariantCulture),
        _ => null,
    };
}

public sealed partial class ModelHost
{
    /// <summary>What the installed Studio gives a fresh element of each kind (<see cref="StudioBornValues"/>) in the context of
    /// the UI flow named <paramref name="flow"/> (null: a new UI flow of the module), measured as StudioDefaults measures it (a
    /// fresh flow with the theme of the context, in a disposable copy), never kept. The tests of both lanes read it without the
    /// Studio's types.</summary>
    internal StudioBornValues.Measured MeasureBorn(byte[] oml, string? flow = null)
    {
        var espace = Load(oml);
        try {
            var (_, measured, why) = StudioDefaults.MeasureContext(espace, FlowNamed(espace, flow));
            return measured ?? throw new InvalidOperationException(why);
        }
        finally { Release(espace); }
    }

    /// <summary>What a fresh element is born with in the module's own UI flow named <paramref name="flow"/> (not a fresh one),
    /// in a disposable load of these bytes: the tests compare it with the measurement of the flow's context.</summary>
    internal StudioBornValues.Measured MeasureBornInFlow(byte[] oml, string flow)
    {
        var espace = Load(oml);
        try { return StudioBornValues.Measure(new StudioBornValues.Creator(espace), FlowNamed(espace, flow)!); }
        finally { Release(espace); }
    }

    /// <summary>The defaults the reading of these bytes gets for the pages of the UI flow named <paramref name="flow"/> (null: a
    /// new UI flow of the module) (<see cref="StudioDefaults.For(ESpace, IObjectSignature?)"/>: kept for its context, else
    /// measured), in a load of them released after. The tests of both lanes ask it without the Studio's types.</summary>
    internal ScreenDefaults StudioDefaultsOf(byte[] oml, string? flow = null)
    {
        var espace = Load(oml);
        try { return StudioDefaults.For(espace, FlowNamed(espace, flow)); }
        finally { Release(espace); }
    }

    /// <summary>The names of the module's UI flows in the order the Model API gives them on this load.</summary>
    internal List<string> FlowsAsLoaded(byte[] oml)
    {
        var espace = Load(oml);
        try { var maker = new StudioBornValues.Creator(espace); return maker.Reader.ChildrenOf((IObjectSignature)espace).Where(n => maker.Role(n) == "flow").Select(n => maker.Reader.DisplayOf(n)).ToList(); }
        finally { Release(espace); }
    }

    /// <summary>The UI flow (name) of every screen and block of the module, by key.</summary>
    internal Dictionary<string, string> FlowsOfPages(byte[] oml)
    {
        var espace = Load(oml);
        try {
            var maker = new StudioBornValues.Creator(espace);
            var r = maker.Reader;
            return maker.Flows().SelectMany(f => r.ChildrenOf(f).Where(p => maker.Role(p) is "screen" or "block").Select(p => (Key: r.KeyOf(p), Flow: r.DisplayOf(f))))
                .ToDictionary(p => p.Key, p => p.Flow, StringComparer.Ordinal);
        }
        finally { Release(espace); }
    }

    private static IObjectSignature? FlowNamed(ESpace espace, string? flow)
    {
        if (flow == null) return null;
        var maker = new StudioBornValues.Creator(espace);
        return maker.Flows().SingleOrDefault(f => maker.Reader.DisplayOf(f) == flow) ?? throw new InvalidOperationException("no UI flow " + flow);
    }
}
