using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using OutSystems.Model;

namespace Anvil.Core.Preflight
{
    /// <summary>
    /// T3, paging that does not page (parts A and B), decided on the candidate model after the ops, on both lanes, so every form
    /// that writes a module (logic text or JSON, html, raw sets, a hand port) is judged the same way.
    /// <list type="bullet">
    /// <item>A, LOGIC_START_SERVER_IGNORED. The installed Studios (O11 11.55 and ODC 1.7.29, AbstractDataSet.PropertyIsUserVisible)
    /// show Start Index only on a screen aggregate over server data (WebScreenDataSet, not client side). On any other aggregate
    /// (a server, service, data or client action, a preparation, a local storage aggregate) the property is hidden: only the
    /// Model API writes it, and the O11 runtime ignored it on a published server action (page 2 showed the rows of page 1). An
    /// aggregate with a Start Index other than empty or 0 there is refused when the job wrote that Start Index; a START the base
    /// already had is a HIGH warning. The fix is a screen aggregate with Start Index, or an SQL with OFFSET @Skip ROWS FETCH NEXT
    /// @Take ROWS ONLY and COUNT(*) OVER() for the total.</item>
    /// <item>B, PAGINATION_SOURCE_UNBOUND. For every instance of a paging block (an input StartIndex and an event with the
    /// parameter NewStartIndex: OutSystems UI Pagination, or a ListNavigation the module defines): its StartIndex reads some
    /// state (start); the event has a handler (handler); the handler assigns, from NewStartIndex, a variable the StartIndex reads,
    /// any expression of it ((CurrentPage - 1) * MaxRecords, Filter.StartIndex, Client.PgStart) (assign); that page state reaches
    /// the offset of the list's source: the Start Index of a screen aggregate, or, through a data action or a server action call,
    /// an SQL OFFSET parameter (offset); the handler refreshes that source or calls it again (refresh); the page size the screen
    /// asks for is the block's MaxRecords, compared only in the screen's own terms (maxRecords); TotalCount comes from that source,
    /// directly or through a variable filled from it (totalCount); a list of the screen shows that source, assigned or appended
    /// (load more) (list).</item>
    /// </list>
    /// Who is judged: a job's review (<see cref="Review"/>) reads only its footprint (the screens, blocks and actions of what it
    /// wrote, never the whole module); a pager whose WIRING the job wrote (the instance, its handler and the screen actions it
    /// calls, its source in the screen, the lists that show it) is refused, a pager whose wiring the base already had is a HIGH
    /// warning; an ancestor (the flow a delete touches, the screen a description changes) never makes its pagers the job's.
    /// Every finding names the element, the property, the expected and the actual value, the fix, and the one op that repairs it
    /// when it is certain (a raw set by @key). Registration: ModelSession.PagingReview in ModelSession.Apply, beside the compile
    /// check. Tests: PagingRulesTests (pure part), PagingRulesScenarios (O11 and ODC fixtures, built from zero, and a base made
    /// before T3).
    /// </summary>
    public static class PagingRules
    {
        public const string StartIgnored = "LOGIC_START_SERVER_IGNORED";
        public const string SourceUnbound = "PAGINATION_SOURCE_UNBOUND";
        public static readonly IReadOnlyList<string> Codes = [StartIgnored, SourceUnbound];
        public static readonly IReadOnlyList<string> Facets = ["start", "handler", "assign", "offset", "refresh", "maxRecords", "totalCount", "list"];

        /// <summary>One violation. Facet: which condition of rule B (null for rule A). Suggestion: the raw op that repairs it when
        /// the repair is certain. Warning: a part the job did not write (receipt only).</summary>
        public sealed record Finding(string Code, string? Facet, IObjectSignature Element, string Path, string Property, string Expected, string Actual, string Message, string Fix)
        {
            public JsonObject? Suggestion { get; init; }
            public bool Warning { get; init; }
        }

        /// <summary>The installed Studios' own rule: Start Index is a property of a screen aggregate over server data only.</summary>
        public static bool StartIndexIsNative(object aggregate)
            => Is(aggregate, "IScreenAggregate") && !(ModelHost.Prop(aggregate, "IsClientSide") is true);

        /// <summary>Whether a Start Index expression asks for an offset (empty and 0 ask for none).</summary>
        public static bool AsksForOffset(string? text) => text != null && text.Trim() is { Length: > 0 } t && t != "0";

        // ---- the walk -------------------------------------------------------------------------------------------------------

        /// <summary>Every finding of the whole module, each as an error (the CLI and the tests read a saved module so).</summary>
        public static List<Finding> Run(IObjectSignature module) => Review(module, null, null);

        /// <summary>The findings of a job: <paramref name="written"/> is what it created or changed (null: the whole module, all
        /// of it the job's); <paramref name="startWritten"/> says whether the job wrote an aggregate's Start Index (rule A). Only
        /// the screens, blocks and actions that hold what the job wrote are read.</summary>
        public static List<Finding> Review(IObjectSignature module, IReadOnlyCollection<IObjectSignature>? written, Func<IObjectSignature, bool>? startWritten)
        {
            var findings = new List<Finding>();
            var index = new ModuleFacts();
            try { return Walk(module, written, startWritten, findings, index); }
            finally { LastReviewRead = index.Read; }
        }

        /// <summary>How many objects the last review of this thread read (the footprint bound, measured by the tests).</summary>
        [ThreadStatic] internal static int LastReviewRead;

        private static List<Finding> Walk(IObjectSignature module, IReadOnlyCollection<IObjectSignature>? written, Func<IObjectSignature, bool>? startWritten, List<Finding> findings, ModuleFacts index)
        {
            List<IObjectSignature> aggregates, scopes;
            HashSet<IObjectSignature>? touched = null;
            if (written == null)
            {
                List<IObjectSignature> all;
                try { all = module.GetAllDescendantsOfType<IObjectSignature>().Where(o => !o.WasDeleted).ToList(); }
                catch { return findings; }
                index.Read += all.Count;
                aggregates = all.Where(IsAggregate).ToList();
                scopes = all.Where(IsScope).ToList();
            }
            else
            {
                // The footprint: every written object with its ancestors (what a pager's wiring is compared against), the
                // screens and blocks above them, and the aggregates of the actions they are in.
                touched = new HashSet<IObjectSignature>(ReferenceEqualityComparer.Instance);
                var scopeSet = new HashSet<IObjectSignature>(ReferenceEqualityComparer.Instance);
                var flows = new HashSet<IObjectSignature>(ReferenceEqualityComparer.Instance);
                var aggregateSet = new HashSet<IObjectSignature>(ReferenceEqualityComparer.Instance);
                foreach (var w in written)
                {
                    if (w.WasDeleted) continue;
                    for (IObjectSignature? p = w; p != null && !ReferenceEquals(p, module); p = p.Parent as IObjectSignature)
                    {
                        if (!touched.Add(p)) break;
                        if (IsScope(p)) scopeSet.Add(p);
                        else if (IsAction(p)) flows.Add(p);
                        if (IsAggregate(p)) aggregateSet.Add(p);
                    }
                }
                foreach (var flow in flows) foreach (var aggregate in index.Desc(flow).Where(IsAggregate)) aggregateSet.Add(aggregate);
                aggregates = [.. aggregateSet];
                scopes = [.. scopeSet];
            }
            // A: every aggregate that asks for an offset where the Studio offers none.
            foreach (var aggregate in aggregates)
            {
                var start = Text(ModelHost.Prop(aggregate, "StartIndex"));
                if (!AsksForOffset(start) || StartIndexIsNative(aggregate)) continue;
                var owner = Owner(aggregate);
                var where = owner == null ? "" : $" in {Kind(owner)} {Name(owner)}";
                var why = Is(aggregate, "IScreenAggregate") ? "a local storage screen aggregate" : "an aggregate of an action flow";
                findings.Add(new Finding(StartIgnored, null, aggregate, PathOf(aggregate), "StartIndex", "empty (the Studio shows Start Index only on a screen aggregate over server entities)", start!,
                    $"aggregate {Name(aggregate)}{where} has Start Index '{start}', but it is {why}: the Studio hides Start Index there and the runtime ignores it, so every page returns the first rows",
                    "page in the screen: a screen aggregate with Start Index = the page variable and Max. Records = the page size; or, in a server action, an SQL node with "
                    + "ORDER BY ... OFFSET @Skip ROWS FETCH NEXT @Take ROWS ONLY (Skip = Max(0, StartIndex), Take = the page size, never 0) and COUNT(*) OVER() as the total, then remove START from this aggregate")
                { Warning = written != null && !(startWritten?.Invoke(aggregate) ?? true) });
            }
            // B: every paging block instance of those screens and blocks.
            foreach (var scope in scopes)
                foreach (var instance in index.Desc(scope).Where(o => Is(o, "IMobileBlockInstanceWidget")))
                    if (Pager.Of(instance) is { } p)
                    {
                        var check = new PagerCheck(index, scope, p);
                        var found = check.Run();
                        if (found.Count == 0) continue;
                        var mine = touched == null || check.Wiring().Any(touched.Contains);
                        findings.AddRange(mine ? found : found.Select(f => f with { Warning = true }));
                    }
            return findings;
        }

        private static bool IsAggregate(IObjectSignature o) => Is(o, "IAggregate") || Is(o, "IAggregateNode");
        private static bool IsScope(IObjectSignature o) => Is(o, "IMobileScreen") || Is(o, "IMobileBlock");
        private static bool IsAction(IObjectSignature o) => Is(o, "IServerAction") || Is(o, "IServiceAction") || Is(o, "IClientAction") || Is(o, "IScreenAction") || Is(o, "IDataAction");

        // ---- the paging block ---------------------------------------------------------------------------------------------

        /// <summary>A block instance that pages: its StartIndex, MaxRecords and TotalCount arguments and its navigation event.</summary>
        internal sealed record Pager(IObjectSignature Instance, string Block, IObjectSignature? Start, IObjectSignature? Max, IObjectSignature? Total,
            IObjectSignature? Handler, IObjectSignature? EventHandler, string EventName, string? HandlerParameter)
        {
            public static Pager? Of(IObjectSignature instance)
            {
                var block = ModelHost.Prop(instance, "SourceBlock") as IObjectSignature;
                if (block == null) return null;
                var inputs = Names(ModelHost.Prop(block, "InputParameters"));
                if (!inputs.Contains("StartIndex", StringComparer.OrdinalIgnoreCase)) return null;
                var events = Objects(ModelHost.Prop(block, "Events")).Where(e => Names(ModelHost.Prop(e, "InputParameters")).Contains("NewStartIndex", StringComparer.OrdinalIgnoreCase)).ToList();
                if (events.Count == 0) return null;
                var eventName = Name(events[0]);
                IObjectSignature? Argument(params string[] names) => Objects(ModelHost.Prop(instance, "Arguments"))
                    .FirstOrDefault(a => ModelHost.Prop(a, "Parameter") is { } p && names.Contains(Name(p), StringComparer.OrdinalIgnoreCase));
                var handler = Objects(ModelHost.Prop(instance, "EventHandlers")).FirstOrDefault(h => ModelHost.Prop(h, "Event") is { } e && string.Equals(Name(e), eventName, StringComparison.OrdinalIgnoreCase));
                var action = handler == null ? null : ModelHost.Prop(handler, "Handler") as IObjectSignature;
                // The handler's input that receives NewStartIndex: the argument of the handler whose value reads the event's parameter.
                string? parameter = null;
                if (handler != null)
                    foreach (var argument in Objects(ModelHost.Prop(handler, "Arguments")))
                        if (Refers(Text(ModelHost.Prop(argument, "Value")), "NewStartIndex") && ModelHost.Prop(argument, "Parameter") is { } p) { parameter = Name(p); break; }
                return new Pager(instance, Name(block), Argument("StartIndex"), Argument("MaxRecords", "RowsPerPage", "PageSize"), Argument("TotalCount", "TotalRecords", "Count"),
                    action, handler, eventName, parameter);
            }
        }

        // ---- the check of one instance --------------------------------------------------------------------------------------

        private sealed class PagerCheck(ModuleFacts index, IObjectSignature scope, Pager p)
        {
            private readonly List<Finding> found = [];
            private readonly List<IObjectSignature> wiring = [p.Instance];
            private string Where => $"{Name(p.Instance)} ({p.Block}) of {Kind(scope)} {Name(scope)}";

            /// <summary>The elements whose change makes this pager the job's: the instance, its handler and the screen actions it
            /// calls, the source in the screen and the lists that show it.</summary>
            public IEnumerable<IObjectSignature> Wiring() => wiring;

            private void Add(string facet, IObjectSignature element, string property, string expected, string actual, string message, string fix, JsonObject? suggestion = null)
                => found.Add(new Finding(SourceUnbound, facet, element, PathOf(element), property, expected, actual, $"{Where}: {message}", fix) { Suggestion = suggestion });

            public List<Finding> Run()
            {
                var startText = Text(ModelHost.Prop(p.Start, "Value"));
                var reads = Paths(startText);
                if (reads.Count == 0)
                {
                    Add("start", p.Start ?? p.Instance, "StartIndex", "an expression of the page state (a variable that OnNavigate assigns)", startText.Length == 0 ? "empty" : startText,
                        $"StartIndex is '{(startText.Length == 0 ? "empty" : startText)}', which reads no variable, so the page can never move",
                        $"create a local variable StartIndex (Integer, default 0) in {Name(scope)}, bind it to StartIndex of {Name(p.Instance)}, assign it from NewStartIndex in the {p.EventName} handler and use it as the Start Index of the list's source");
                    return found;
                }
                if (p.Handler == null)
                {
                    Add("handler", p.Instance, p.EventName, "a screen action that assigns the page state and refreshes the source", "no handler",
                        $"{p.EventName} has no handler, so clicking a page changes nothing",
                        $"create a screen action PageChanged (input NewStartIndex: Integer) that assigns {reads[0]} from NewStartIndex and refreshes the list's source, and set it as the {p.EventName} handler of {Name(p.Instance)} with NewStartIndex = NewStartIndex");
                    return found;
                }
                var chain = index.Chain(p.Handler, scope);
                wiring.AddRange(chain);
                // A block that wraps the pager and hands the navigation to the screen that uses it (StartIndex reads an input of
                // the block and the handler triggers an event of the block): the screen pages, and its instance of the block is
                // the pager judged there.
                if (Is(scope, "IMobileBlock") && index.Inputs(scope).Any(i => reads.Any(r => Root(r).Equals(i, StringComparison.OrdinalIgnoreCase)))
                    && chain.Any(a => index.Desc(a).Any(o => Is(o, "ITriggerNode"))))
                    return found;
                // The page state: what the handler assigns from NewStartIndex (through locals of the handler too) that the
                // StartIndex reads.
                var tainted = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                if (p.HandlerParameter != null) tainted.Add(p.HandlerParameter); else foreach (var i in index.Inputs(p.Handler)) tainted.Add(i);
                var assigns = chain.SelectMany(index.Assignments).ToList();
                for (var grew = true; grew;)
                {
                    grew = false;
                    foreach (var (variable, value) in assigns)
                        if (variable.Length > 0 && tainted.Any(t => Reads(value, t)) && tainted.Add(variable)) grew = true;
                }
                var state = tainted.Where(t => reads.Any(r => Reads(startText, t))).ToList();
                if (state.Count == 0)
                {
                    Add("assign", p.Handler, "Assign", $"{reads[0]} = <expression of {p.HandlerParameter ?? "NewStartIndex"}>",
                        string.Join("; ", assigns.Select(a => a.Variable + " = " + a.Value).DefaultIfEmpty("no assignment")),
                        $"the handler {Name(p.Handler)} assigns nothing the StartIndex '{startText}' reads from the event's NewStartIndex{(p.HandlerParameter == null ? " (the handler receives no NewStartIndex)" : "")}",
                        $"give {Name(p.Handler)} an input NewStartIndex (Integer) bound to the event's NewStartIndex and assign {reads[0]} from it before refreshing the source");
                    return found;
                }
                var source = index.SourceOf(scope, state, chain);
                if (source == null)
                {
                    var why = index.WhyUnbound(scope, state, chain);
                    Add("offset", p.Start ?? p.Instance, "StartIndex", $"{string.Join(", ", state)} as the offset of the list's source", why,
                        $"the page state {string.Join(", ", state)} reaches no offset of a data source ({why}), so every page shows the same rows",
                        $"set the Start Index of the list's screen aggregate to {startText} (and Max. Records to {Text(ModelHost.Prop(p.Max, "Value"))}); for a server action source pass {startText} to an input that feeds OFFSET @Skip ROWS FETCH NEXT @Take ROWS ONLY in its SQL");
                    return found;
                }
                wiring.Add(source.Element);
                var lists = index.Lists(scope);
                wiring.AddRange(lists.Where(l => source.Shows(Text(ModelHost.Prop(l, "Source")))));
                if (source.Refreshable && !chain.Any(a => index.Refreshes(a).Any(t => Same(t, source.Element))))
                    Add("refresh", p.Handler, "RefreshData", $"Refresh Data {source.Name}", "no refresh of " + source.Name,
                        $"the handler {Name(p.Handler)} moves the page but never refreshes {source.Name}, so the list keeps the old page",
                        $"add Refresh Data {source.Name} to {Name(p.Handler)} after the assign of the page state");
                // The page size in the screen's own terms: the aggregate's Max. Records, or the argument the screen (or its data
                // action) passes for the callee's page-size input; never the callee's own expression.
                var maxText = Text(ModelHost.Prop(p.Max, "Value"));
                if (p.Max != null && source.Size is { } size && size.Text.Length > 0 && !Same(size.Text, maxText))
                {
                    if (size.Argument != null)
                        Add("maxRecords", p.Max, "MaxRecords", maxText, size.Text,
                            $"the block shows pages of '{maxText}' and {size.Where} asks {size.Callee} for pages of '{size.Text}': the counter and the rows disagree",
                            $"pass {maxText} as {size.Input} of {size.Callee} in {size.Where}", Set(size.Argument, "Value", maxText));
                    else if (size.Element != null)
                        Add("maxRecords", p.Max, "MaxRecords", maxText, size.Text,
                            $"MaxRecords is '{maxText}' on the block and '{size.Text}' on {source.Name}: the counter and the rows disagree as soon as one changes",
                            $"use the same expression on both: set Max. Records of {source.Name} to {maxText}", Set(size.Element, "MaxRecords", maxText));
                    else if (!size.Fixed)
                        Add("maxRecords", p.Max, "MaxRecords", maxText, size.Text,
                            $"MaxRecords is '{maxText}' on the block and the SQL of {source.Name} fetches pages of '{size.Text}'",
                            $"use {maxText} as the page size (FETCH NEXT) of the SQL of {source.Name}");
                    else
                        Add("maxRecords", p.Max, "MaxRecords", maxText, size.Text + " (fixed inside " + size.Callee + ")",
                            $"{size.Callee} fetches pages of {size.Text} that no input sets, and the block shows pages of '{maxText}'",
                            $"give {size.Callee} a page-size input that feeds its FETCH NEXT (or Max. Records) and pass {maxText} to it");
                }
                var totalText = Text(ModelHost.Prop(p.Total, "Value"));
                if (p.Total != null && !source.Counts(totalText, index.ScopeAssignments(scope)))
                    Add("totalCount", p.Total, "TotalCount", source.Count, totalText.Length == 0 ? "empty" : totalText,
                        $"TotalCount is '{totalText}', not the count of the paged source {source.Name}: the counter counts other rows than the list",
                        $"set TotalCount of {Name(p.Instance)} to {source.Count}", source.CountIsCertain ? Set(p.Total, "Value", source.Count) : null);
                if (lists.Count > 0 && !lists.Any(l => source.Shows(Text(ModelHost.Prop(l, "Source")))))
                    Add("list", lists[0], "Source", source.ListExpression, string.Join("; ", lists.Select(l => Name(l) + " = " + Text(ModelHost.Prop(l, "Source")))),
                        $"no list of {Name(scope)} shows the paged source {source.Name}: the pagination moves one source and the list shows another",
                        $"set the Source of the list to {source.ListExpression}", lists.Count == 1 && source.ListIsCertain ? Set(lists[0], "Source", source.ListExpression) : null);
                return found;
            }
        }

        /// <summary>The page size a source asks for: the screen's argument for the callee's page-size input (Argument), or the
        /// screen aggregate's own Max. Records (Element), or a size fixed inside the callee (neither).</summary>
        internal sealed record PageSize(string Text, IObjectSignature? Argument, IObjectSignature? Element, string? Input, string Callee, string Where, bool Fixed = false);

        /// <summary>The source the page state reaches: a screen aggregate (its Start Index), a data action, or a server action the
        /// handler calls (with the variables it fills: the rows, appended or assigned, and the count).</summary>
        internal sealed record Source(IObjectSignature Element, string Name, bool Refreshable, PageSize? Size,
            string Count, bool CountIsCertain, string ListExpression, bool ListIsCertain, IReadOnlyCollection<string> RowWords, IReadOnlyCollection<string> CountWords)
        {
            /// <summary>The count of the source: as it is or converted (LongIntegerToInteger(GetItems.Count)), or a variable an
            /// action of the screen fills from it (OnAfterFetch: Total = GetItems.Count); another source's is not.</summary>
            public bool Counts(string total, IReadOnlyList<(string Variable, string Value)> assignments)
            {
                if (Direct(total)) return true;
                foreach (var (variable, value) in assignments)
                    if (variable.Length > 0 && Reads(total, variable) && Direct(value)) return true;
                return false;
            }

            private bool Direct(string text) => CountIsCertain ? PagingRules.Reads(text, Count) : CountWords.Any(w => PagingRules.Reads(text, w));

            public bool Shows(string list) => RowWords.Any(w => PagingRules.Reads(list, w));
        }

        // ---- the facts of the module the checks read -------------------------------------------------------------------------

        internal sealed class ModuleFacts
        {
            private readonly Dictionary<IObjectSignature, List<IObjectSignature>> descendants = new(ReferenceEqualityComparer.Instance);
            private readonly Dictionary<string, Dictionary<string, (string? Size, string? SizeInput)>?> reaching = new(StringComparer.Ordinal);
            /// <summary>The objects read so far.</summary>
            public int Read;

            /// <summary>The descendants of an element (read once per element).</summary>
            public List<IObjectSignature> Desc(IObjectSignature root)
            {
                if (descendants.TryGetValue(root, out var list)) return list;
                try { list = root.GetAllDescendantsOfType<IObjectSignature>().Where(o => !o.WasDeleted).ToList(); } catch { list = []; }
                Read += list.Count;
                return descendants[root] = list;
            }

            public IEnumerable<IObjectSignature> Kids(IObjectSignature parent, string type) => Desc(parent).Where(o => ReferenceEquals(o.Parent, parent) && Is(o, type));

            public List<string> Inputs(IObjectSignature action) => Kids(action, "IInputParameter").Select(Name).ToList();

            /// <summary>The handler and the screen actions of the same scope it calls, transitively.</summary>
            public List<IObjectSignature> Chain(IObjectSignature handler, IObjectSignature scope)
            {
                var seen = new HashSet<IObjectSignature>(ReferenceEqualityComparer.Instance) { handler };
                var queue = new Queue<IObjectSignature>([handler]);
                while (queue.Count > 0)
                    foreach (var call in Desc(queue.Dequeue()).Where(o => Is(o, "IExecuteClientActionNode")))
                        if (ModelHost.Prop(call, "Action") is IObjectSignature callee && ReferenceEquals(callee.Parent, scope) && seen.Add(callee)) queue.Enqueue(callee);
                return [.. seen];
            }

            public IEnumerable<(string Variable, string Value)> Assignments(IObjectSignature action)
                => Desc(action).Where(o => Is(o, "IAssignment")).Select(a => (Text(ModelHost.Prop(a, "Variable")).Trim(), Text(ModelHost.Prop(a, "Value"))));

            /// <summary>Every assignment of every screen action of a scope (a variable filled in OnAfterFetch, in the handler).</summary>
            public IReadOnlyList<(string Variable, string Value)> ScopeAssignments(IObjectSignature scope)
                => Kids(scope, "IScreenAction").Concat(Kids(scope, "IDataAction")).SelectMany(Assignments).ToList();

            public IEnumerable<IObjectSignature> Refreshes(IObjectSignature action)
                => Desc(action).Where(o => Is(o, "IRefreshDataNode")).Select(r => ModelHost.Prop(r, "DataSource") as IObjectSignature).OfType<IObjectSignature>();

            public List<IObjectSignature> Lists(IObjectSignature scope)
                => Desc(scope).Where(o => (Is(o, "IList") || Is(o, "ITableRecords")) && ModelHost.Prop(o, "Source") != null).ToList();

            public Source? SourceOf(IObjectSignature scope, IReadOnlyList<string> state, List<IObjectSignature> chain)
            {
                // A screen aggregate whose Start Index reads the page state.
                foreach (var aggregate in Kids(scope, "IScreenAggregate"))
                    if (StartIndexIsNative(aggregate) && state.Any(s => Reads(Text(ModelHost.Prop(aggregate, "StartIndex")), s)))
                    {
                        var name = Name(aggregate);
                        var max = Text(ModelHost.Prop(aggregate, "MaxRecords"));
                        return new Source(aggregate, name, true, max.Length > 0 ? new PageSize(max, null, aggregate, null, name, name) : null,
                            name + ".Count", true, name + ".List", true, [name], [name]);
                    }
                // A data action whose flow passes the page state into an offset.
                foreach (var data in Kids(scope, "IDataAction"))
                    if (FlowOffset(data, state, out var size) is true)
                    {
                        var name = Name(data);
                        var outputs = Kids(data, "IOutputParameter").ToList();
                        var rows = outputs.FirstOrDefault(o => IsList(ModelHost.Prop(o, "DataType")));
                        var count = outputs.FirstOrDefault(o => !IsList(ModelHost.Prop(o, "DataType")));
                        return new Source(data, name, true, size,
                            count != null ? name + "." + Name(count) : name + ".<count output>", count != null,
                            rows != null ? name + "." + Name(rows) : name + ".<rows output>", rows != null, [name], [name]);
                    }
                // A server action the handler (or a screen action it calls) calls with the page state into an offset.
                foreach (var action in chain)
                    foreach (var call in Desc(action).Where(o => Is(o, "IExecuteServerActionNode")))
                        if (CallOffset(call, state, action) is { } size)
                        {
                            var callName = Name(call);
                            var callee = (IObjectSignature)ModelHost.Prop(call, "Action")!;
                            var listOutputs = Kids(callee, "IOutputParameter").Where(o => IsList(ModelHost.Prop(o, "DataType"))).Select(Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
                            var rows = new List<string>(); var counts = new List<string>();
                            foreach (var (variable, value) in chain.SelectMany(Assignments))
                                if (variable.Length > 0 && Reads(value, callName))
                                    (Regex.Matches(value, @"(?<![\w.])" + Regex.Escape(callName) + @"\.(\w+)", RegexOptions.IgnoreCase).Any(m => listOutputs.Contains(m.Groups[1].Value)) ? rows : counts).Add(variable);
                            // Load more: (System).ListAppendAll(List = Rows, SourceList = <call>.Rows) or ListAppend into the shown list.
                            foreach (var append in chain.SelectMany(a => Desc(a)).Where(o => Is(o, "IExecuteClientActionNode") || Is(o, "IExecuteServerActionNode")))
                                if (Name(ModelHost.Prop(append, "Action")) is "ListAppendAll" or "ListAppend" && ArgumentValues(append) is var args
                                    && args.TryGetValue("List", out var target) && (args.GetValueOrDefault("SourceList") ?? args.GetValueOrDefault("Element") ?? "") is var from && Reads(from, callName))
                                    rows.Add(target.Trim());
                            return new Source(call, $"{callName} ({Name(callee)})", false, size,
                                counts.Count > 0 ? string.Join(" or ", counts) : callName + ".<count output>", false,
                                rows.Count > 0 ? string.Join(" or ", rows) : callName + ".<rows output>", false,
                                [.. rows.DefaultIfEmpty(callName)], [.. counts.DefaultIfEmpty(callName)]);
                        }
                return null;
            }

            /// <summary>Why the page state reaches no offset: the closest wrong wiring, in words.</summary>
            public string WhyUnbound(IObjectSignature scope, IReadOnlyList<string> state, List<IObjectSignature> chain)
            {
                foreach (var aggregate in Kids(scope, "IScreenAggregate"))
                    if (Desc(aggregate).OfType<IExpression>().Any(e => state.Any(s => Reads(e.Text, s))) || state.Any(s => Reads(Text(ModelHost.Prop(aggregate, "MaxRecords")), s)))
                        return $"screen aggregate {Name(aggregate)} reads it but its Start Index is '{Text(ModelHost.Prop(aggregate, "StartIndex"))}'";
                foreach (var action in chain)
                    foreach (var call in Desc(action).Where(o => Is(o, "IExecuteServerActionNode")))
                        if (Objects(ModelHost.Prop(call, "Arguments")).Any(a => state.Any(s => Reads(Text(ModelHost.Prop(a, "Value")), s))) && ModelHost.Prop(call, "Action") is IObjectSignature callee)
                        {
                            if (Desc(callee).FirstOrDefault(g => IsAggregate(g) && AsksForOffset(Text(ModelHost.Prop(g, "StartIndex")))) is { } ignored)
                                return $"it goes to server action {Name(callee)}, whose aggregate {Name(ignored)} has START {Text(ModelHost.Prop(ignored, "StartIndex"))}, which the runtime ignores";
                            if (Desc(callee).FirstOrDefault(o => Is(o, "ISQLNode")) is { } sql && !Offset.IsMatch(Text(ModelHost.Prop(sql, "Statement"))))
                                return $"it goes to server action {Name(callee)}, whose SQL {Name(sql)} has no OFFSET";
                            return $"it goes to server action {Name(callee)}, which uses it in no OFFSET";
                        }
                return $"no aggregate, data action or server action call of {Name(scope)} reads it as an offset";
            }

            /// <summary>The inputs of a server action that feed an SQL OFFSET (directly, through locals, or through a call to
            /// another such action), each with the page size the same query uses (its text and the input it reads, if one); read
            /// on demand, once per action (a cycle reads as none).</summary>
            private Dictionary<string, (string? Size, string? SizeInput)>? Reaching(IObjectSignature action)
            {
                var key = Key(action);
                if (reaching.TryGetValue(key, out var known)) return known;
                reaching[key] = null;   // in progress: a recursive call reads none
                var result = new Dictionary<string, (string? Size, string? SizeInput)>(StringComparer.OrdinalIgnoreCase);
                if (Is(action, "IServerAction") || Is(action, "IServiceAction"))
                {
                    var inputs = Inputs(action);
                    foreach (var input in inputs)
                        if (FlowOffset(action, [input], out var size) is true)
                            result[input] = (size?.Text, size?.Input);
                }
                return reaching[key] = result;
            }

            /// <summary>Whether the flow passes any of <paramref name="state"/> (or a local assigned from it) into an SQL OFFSET or
            /// into a reaching input of a server action it calls; <paramref name="size"/> is the page size that query uses, in the
            /// flow's own terms (the argument it passes for the callee's page-size input, or its SQL's FETCH NEXT value).</summary>
            private bool? FlowOffset(IObjectSignature flow, IReadOnlyList<string> state, out PageSize? size)
            {
                size = null;
                var words = new HashSet<string>(state, StringComparer.OrdinalIgnoreCase);
                var assigns = Assignments(flow).ToList();
                for (var grew = true; grew;)
                {
                    grew = false;
                    foreach (var (variable, value) in assigns)
                        if (variable.Length > 0 && words.Any(w => Reads(value, w)) && words.Add(variable)) grew = true;
                }
                var inputs = Inputs(flow).ToHashSet(StringComparer.OrdinalIgnoreCase);
                foreach (var sql in Desc(flow).Where(o => Is(o, "ISQLNode")))
                {
                    var statement = Text(ModelHost.Prop(sql, "Statement"));
                    var match = Offset.Match(statement);
                    if (!match.Success) continue;
                    var arguments = ArgumentValues(sql);
                    if (!arguments.TryGetValue(match.Groups[1].Value, out var offset) || !words.Any(w => Reads(offset, w))) continue;
                    string? text = null;
                    if (Fetch.Match(statement) is { Success: true } fetch)
                        text = fetch.Groups[1].Success ? arguments.GetValueOrDefault(fetch.Groups[1].Value) : fetch.Groups[2].Value;
                    text ??= Text(ModelHost.Prop(sql, "MaxRecords")) is { Length: > 0 } m ? m : null;
                    // The page-size input: the one input of the flow the size expression reads (a guard around it is fine).
                    var read = text == null ? [] : inputs.Where(i => Reads(text, i)).ToList();
                    size = text == null ? null : new PageSize(text, null, null, read.Count == 1 ? read[0] : null, Name(flow), Name(flow));
                    return true;
                }
                // A For Each that starts at the offset (its Start Index) over an aggregate that fetches the rows before it too (no
                // Max. Records, or one that reads the offset: MAX Offset + Limit): the page of the Traditional pattern.
                foreach (var loop in Desc(flow).Where(o => Is(o, "IForEachNode")))
                {
                    if (!words.Any(w => Reads(Text(ModelHost.Prop(loop, "StartIndex")), w))) continue;
                    var listText = Text(ModelHost.Prop(loop, "RecordList"));
                    if (Desc(flow).FirstOrDefault(a => IsAggregate(a) && Reads(listText, Name(a))) is { } iterated
                        && Text(ModelHost.Prop(iterated, "MaxRecords")) is { Length: > 0 } fetched && !words.Any(w => Reads(fetched, w))) continue;
                    var text = Text(ModelHost.Prop(loop, "MaximumIterations")) is { Length: > 0 } most ? most : null;
                    var read = text == null ? [] : inputs.Where(i => Reads(text, i)).ToList();
                    size = text == null ? null : new PageSize(text, null, null, read.Count == 1 ? read[0] : null, Name(flow), Name(flow));
                    return true;
                }
                foreach (var call in Desc(flow).Where(o => Is(o, "IExecuteServerActionNode")))
                    if (CallOffset(call, [.. words], flow) is { } found) { size = found; return true; }
                return null;
            }

            /// <summary>The page size of a call that passes the state into a reaching input, in the caller's terms; null when the
            /// call passes none of it.</summary>
            private PageSize? CallOffset(IObjectSignature call, IReadOnlyList<string> state, IObjectSignature caller)
            {
                if (ModelHost.Prop(call, "Action") is not IObjectSignature callee || Reaching(callee) is not { Count: > 0 } reach) return null;
                foreach (var argument in Objects(ModelHost.Prop(call, "Arguments")))
                    if (ModelHost.Prop(argument, "Parameter") is { } parameter && reach.TryGetValue(Name(parameter), out var size) && state.Any(s => Reads(Text(ModelHost.Prop(argument, "Value")), s)))
                    {
                        var where = $"{Kind(caller)} {Name(caller)}";
                        if (size.SizeInput != null && Objects(ModelHost.Prop(call, "Arguments")).FirstOrDefault(a => ModelHost.Prop(a, "Parameter") is { } q && string.Equals(Name(q), size.SizeInput, StringComparison.OrdinalIgnoreCase)) is { } sized)
                            return new PageSize(Text(ModelHost.Prop(sized, "Value")), sized, null, size.SizeInput, Name(callee), where);
                        return new PageSize(size.Size ?? "", null, null, null, Name(callee), where, Fixed: true);
                    }
                return null;
            }
        }

        // ---- text and model helpers -----------------------------------------------------------------------------------------

        // OFFSET @Start ROWS (SQL Server, Oracle, PostgreSQL) or LIMIT ... OFFSET @Start (PostgreSQL); FETCH NEXT @Max / literal.
        internal static readonly Regex Offset = new(@"\bOFFSET\s+@(\w+)", RegexOptions.IgnoreCase | RegexOptions.Compiled);
        private static readonly Regex Fetch = new(@"\b(?:FETCH\s+(?:NEXT|FIRST)|LIMIT)\s+(?:@(\w+)|(\d+))", RegexOptions.IgnoreCase | RegexOptions.Compiled);
        private static readonly Regex Strings = new("\"(?:[^\"]|\"\")*\"", RegexOptions.Compiled);
        private static readonly Regex Word = new(@"(?<![\w.])([A-Za-z_][A-Za-z0-9_]*)", RegexOptions.Compiled);
        private static readonly Regex PathWord = new(@"(?<![\w.])([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)(\s*\()?", RegexOptions.Compiled);
        private static readonly HashSet<string> Keywords = new(StringComparer.OrdinalIgnoreCase) { "and", "or", "not", "True", "False", "like", "in" };
        private static readonly ConcurrentDictionary<Type, HashSet<string>> Interfaces = new();

        internal static bool Is(object? o, string type)
            => o != null && Interfaces.GetOrAdd(o.GetType(), t => t.GetInterfaces().Select(i => i.Name).ToHashSet(StringComparer.Ordinal)).Contains(type);

        /// <summary>Whether an expression names <paramref name="word"/> as an identifier of its own (not a member, not inside a
        /// text literal).</summary>
        internal static bool Refers(string? expression, string word)
        {
            if (string.IsNullOrEmpty(expression) || string.IsNullOrEmpty(word)) return false;
            foreach (Match m in Word.Matches(Strings.Replace(expression, "\"\"")))
                if (string.Equals(m.Groups[1].Value, word, StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        /// <summary>Whether an expression reads <paramref name="path"/>: a name (StartIndex), or a path from its root
        /// (Filter.StartIndex, Client.PgStart), as itself or as the start of a longer path, never inside a text literal.</summary>
        internal static bool Reads(string? expression, string path)
        {
            if (string.IsNullOrEmpty(expression) || string.IsNullOrWhiteSpace(path)) return false;
            return Regex.IsMatch(Strings.Replace(expression, "\"\""), @"(?<![\w.])" + Regex.Escape(path.Trim()) + @"(?![\w])", RegexOptions.IgnoreCase);
        }

        /// <summary>The variables and paths an expression reads (no function names, no keywords, no literals), in order.</summary>
        internal static List<string> Paths(string? expression)
        {
            var found = new List<string>();
            if (string.IsNullOrWhiteSpace(expression)) return found;
            foreach (Match m in PathWord.Matches(Strings.Replace(expression, "\"\"")))
            {
                var path = m.Groups[1].Value;
                if (m.Groups[2].Success || Keywords.Contains(path) || path.StartsWith("Entities.", StringComparison.OrdinalIgnoreCase)) continue;
                if (!found.Contains(path, StringComparer.OrdinalIgnoreCase)) found.Add(path);
            }
            return found;
        }

        private static string Root(string path) => path.Split('.')[0];

        /// <summary>The identifier an expression is, when it is one bare name.</summary>
        internal static string? Identifier(string? expression)
            => expression?.Trim() is { Length: > 0 } t && Regex.IsMatch(t, "^[A-Za-z_][A-Za-z0-9_]*$") ? t : null;

        internal static bool Same(string? a, string? b) => Regex.Replace(a ?? "", @"\s+", "") is var x && string.Equals(x, Regex.Replace(b ?? "", @"\s+", ""), StringComparison.OrdinalIgnoreCase);
        private static bool Same(IObjectSignature a, IObjectSignature b) => ReferenceEquals(a, b) || a.ObjectKey != null && Equals(a.ObjectKey?.ToString(), b.ObjectKey?.ToString());

        private static bool IsList(object? type) => type != null && (Is(type, "IListType") || Is(type, "IRecordListType") || Name(type).EndsWith(" List", StringComparison.Ordinal) || Text(type).EndsWith(" List", StringComparison.Ordinal));

        private static string Text(object? value) => value switch { null => "", IExpression e => e.Text ?? "", string s => s, _ => value.ToString() ?? "" };
        private static string Name(object? o) => o == null ? "" : ModelHost.Prop(o, "Name") as string is { Length: > 0 } n ? n : TypeResolver.Name(o) is { Length: > 0 } t ? t : o.GetType().Name;
        private static string Key(IObjectSignature o) => o.ObjectKey?.ToString() ?? Name(o);
        private static IEnumerable<IObjectSignature> Objects(object? value) => value is System.Collections.IEnumerable items and not string ? items.OfType<IObjectSignature>() : [];
        private static List<string> Names(object? value) => Objects(value).Select(Name).ToList();

        /// <summary>The arguments of a call or an SQL node, by the name of the parameter each fills (the first of a name wins).</summary>
        private static Dictionary<string, string> ArgumentValues(object node)
        {
            var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var argument in Objects(ModelHost.Prop(node, "Arguments")))
                if (ModelHost.Prop(argument, "Parameter") is { } parameter && Name(parameter) is { Length: > 0 } name) values.TryAdd(name, Text(ModelHost.Prop(argument, "Value")));
            return values;
        }

        private static string Kind(IObjectSignature o)
            => Is(o, "IMobileScreen") ? "screen" : Is(o, "IMobileBlock") ? "block" : Is(o, "IServerAction") ? "server action" : Is(o, "IServiceAction") ? "service action"
             : Is(o, "IDataAction") ? "data action" : Is(o, "IClientAction") ? "client action" : Is(o, "IScreenAction") ? "screen action" : ModelHost.Kind(o.GetType().GetInterfaces().FirstOrDefault(i => i.Name.StartsWith('I'))?.Name ?? "element");

        /// <summary>The action, data action, screen or block that holds an element.</summary>
        private static IObjectSignature? Owner(IObjectSignature o)
        {
            for (var p = o.Parent as IObjectSignature; p != null; p = p.Parent as IObjectSignature)
                if (IsAction(p) || IsScope(p) || Is(p, "IWebScreen") || Is(p, "IWebBlock") || Is(p, "IAction")) return p;
            return null;
        }

        private static string PathOf(IObjectSignature o)
        {
            var parts = new List<string>();
            for (IObjectSignature? p = o; p != null && parts.Count < 6; p = p.Parent as IObjectSignature)
                if (Name(p) is { Length: > 0 } n && !Is(p, "IESpace") && !Is(p, "IModule")) parts.Insert(0, n);
            return string.Join("/", parts);
        }

        private static JsonObject Set(IObjectSignature element, string prop, string value)
            => new() { ["op"] = "set", ["target"] = "@" + element.ObjectKey, ["prop"] = prop, ["value"] = value };

        /// <summary>A finding as the CLI and the receipts write it.</summary>
        public static JsonObject ToJson(Finding f)
        {
            var json = new JsonObject
            {
                ["code"] = f.Code, ["severity"] = f.Warning ? "high" : "error", ["facet"] = f.Facet, ["path"] = f.Path, ["key"] = f.Element.ObjectKey?.ToString(),
                ["property"] = f.Property, ["expected"] = f.Expected, ["actual"] = f.Actual, ["message"] = f.Message, ["fix"] = f.Fix,
            };
            if (f.Suggestion != null) json["suggestion"] = f.Suggestion.DeepClone();
            return json;
        }
    }
}

namespace Anvil.Core
{
    public sealed partial class ModelSession
    {
        /// <summary>T3 (Preflight/PagingRules.cs): paging that does not page, on the candidate model of this apply, read only over
        /// the footprint of what the job wrote. A finding on what the job wrote is one more failure of the apply's single refusal
        /// (with its op, the element, the expected and actual values, the fix and, when certain, the one raw op that repairs it); a
        /// finding on what the base already had is a HIGH warning of the receipt. A job that only reads is not judged. Never throws.</summary>
        private void PagingReview(JsonArray ops, List<ApplyFailure> failures)
        {
            if (!_footprintBegun) return;
            if (!ops.OfType<JsonObject>().Any(o => o["op"]?.ToString() is not ("get" or "find" or "dump" or "usages" or "layout"))) return;
            List<Preflight.PagingRules.Finding> findings;
            try
            {
                var (created, changed) = JobObjects();
                var mine = new HashSet<IObjectSignature>(created.Concat(changed), ReferenceEqualityComparer.Instance);
                // Rule A judges who wrote the Start Index: the job created the aggregate, or changed its Start Index (the
                // expression under it, or a raw set of it); a START the base already had is a HIGH warning, whatever else the
                // job changed in that aggregate (a sort fixed by the compile check's patch, its Max. Records, its description).
                bool StartWritten(IObjectSignature o) => created.Contains(o) || SetOpOf(o, "StartIndex", ops) != null
                    || ModelHost.Prop(o, "StartIndex") is IObjectSignature start && mine.Contains(start)
                    || o.ObjectKey?.ToString() is { } key && mine.Any(c => c.ObjectKey?.ToString() == key + ".#StartIndex");
                findings = Preflight.PagingRules.Review((IObjectSignature)_es, mine, StartWritten);
            }
            catch { return; }
            foreach (var finding in findings.Where(f => f.Warning))
                Report("highWarnings", new JsonObject
                {
                    ["code"] = finding.Code, ["severity"] = "high", ["facet"] = finding.Facet, ["message"] = finding.Message + " (the base already had it)", ["fix"] = finding.Fix,
                    ["element"] = finding.Path, ["check"] = "paging",
                });
            var firstWrite = Math.Max(0, ops.Select((x, n) => (x, n)).FirstOrDefault(p => p.x?["op"]?.ToString() is not ("get" or "find" or "dump" or "usages" or "layout")).n);
            foreach (var finding in findings.Where(f => !f.Warning))
            {
                var written = SetOpOf(finding.Element, finding.Property, ops);
                var op = written ?? OriginOp(finding.Element, ops) ?? firstWrite;
                var source = op < ops.Count ? ops[op] as JsonObject : null;
                var kind = source?["op"]?.ToString() ?? "op";
                var problem = JobPreflight.Problem(op, written != null ? "/value" : null, finding.Code, "error",
                    $"{finding.Message}; {finding.Property}: expected {finding.Expected}, actual {finding.Actual}", finding.Fix,
                    written != null && finding.Suggestion?["value"] is JsonValue value ? new JsonArray(new JsonObject { ["op"] = "replace", ["path"] = "/value", ["value"] = value.DeepClone() }) : null);
                problem["element"] = finding.Path;
                problem["key"] = finding.Element.ObjectKey?.ToString();
                problem["check"] = "paging";
                if (finding.Facet != null) problem["facet"] = finding.Facet;
                if (finding.Suggestion != null) problem["suggestion"] = finding.Suggestion.DeepClone();
                failures.Add(new ApplyFailure(op, kind, source ?? new JsonObject(),
                    new KernelRefusalException(finding.Code, $"op #{op} ({kind} {finding.Path}): [{finding.Code}] {finding.Message}. Fix: {finding.Fix}", new JsonArray(problem))));
            }
        }
    }
}
