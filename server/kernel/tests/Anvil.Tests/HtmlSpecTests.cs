using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;
namespace Anvil.Tests;

/// <summary>The HTML compiler is proved at the level of the verbs it emits: same source, same ops; tags, order, classes and
/// attributes preserved; data, filters, events and client functions only from the closed manifest; the CSS scoped under the page
/// root; an existing screen updated without recreating it. Everything unproven is rejected with the source position. The fixture
/// proofs (Verify, theme, delta, merge) are HtmlDeltaTests and the jobs html-dashboard-reactive / html-dashboard-update.</summary>
public sealed class HtmlSpecTests
{
    [Theory]
    [InlineData("<div style='--amount:20%'></div>", null)]
    [InlineData("<div data-av='bar'></div>", "{\"bar\":{\"kind\":\"style\",\"value\":\"\\\"--amount:20%\\\"\"}}")]
    public void UnsupportedInlineCustomPropertiesFailBeforePublishing(string html, string? bindings)
    {
        var ex = Assert.Throws<InvalidOperationException>(() => Expand(Page(html, bindings, false)));
        Assert.Contains("inline CSS custom properties", ex.Message);
    }

    [Fact] public void WholePageUsesBlankLayoutAndKeepsTheFunctionalAccountBlock()
    {
        var ops = Expand(Reference()).Ops;
        Assert.Contains(ops, o => Sets(o, "SourceBlock", "IMobileBlock:LayoutBlank"));
        Assert.DoesNotContain(ops, o => o["parent"]?.ToString().EndsWith("/Title") == true);
        Assert.Contains(ops, o => Is(o, "IMobileBlockInstanceWidget") && o["source"]?.ToString() == "IMobileBlock:UserInfo");
        Assert.Contains(ops, o => Is(o, "IContainer", "Page") && o["parent"]!.ToString().EndsWith("/Content"));
    }
    [Fact] public void FetchFailureHasItsOwnPathAndDoesNotReportSuccessfulEmptyData()
    {
        var ops = Expand(Reference()).Ops;
        foreach (var source in new[] { "LoadDashboard", "LoadRecent", "LoadMine", "LoadNearDue" })
        {
            var owner = ops.Single(o => Is(o, "IDataAction", source))["as"]!.ToString();
            Assert.Contains(ops, o => Is(o, "IOutputParameter", "FetchSucceeded") && o["parent"]?.ToString() == owner);
            Assert.Contains(ops, o => Is(o, "IExceptionHandlerNode", "FetchFailed") && o["parent"]?.ToString() == owner);
            Assert.Equal(2, ops.Count(o => Is(o, "IEndNode") && o["parent"]?.ToString() == owner));
            Assert.Contains(ops, o => Sets(o, "Condition", source + ".IsDataFetched and not " + source + ".FetchSucceeded") && o["target"]!.ToString() == IfOf(ops, o));
            Assert.Contains(ops, o => Sets(o, "Condition", source + ".IsDataFetched and " + source + ".FetchSucceeded") && o["target"]!.ToString() == IfOf(ops, o));
        }
        Assert.DoesNotContain(ops, o => o["prop"]?.ToString() == "Visible");
    }
    private static string? IfOf(List<JsonObject> ops, JsonObject set) => ops.FirstOrDefault(c => Is(c, "IIfWidget") && c["as"]?.ToString() == set["target"]?.ToString())?["as"]?.ToString();

    // ---- visible -> native If; children of <a>/<button> compiled as widgets ---------------------------------------------

    [Fact] public void VisibleIsANativeIfAtTheElementsPlaceWithTheElementInTheTrueBranch()
    {
        var data = Page("""<p>antes</p><div class="banner" hidden data-av="banner">Destaques</div><p>depois</p>""", """{"banner":{"kind":"visible","condition":"ShowBanner"}}""", source: false);
        data["vars"] = JsonNode.Parse("""[{"name":"ShowBanner","type":"Boolean","default":"True"}]""");
        var first = Expand(data).Ops; var ops = Expand(data).Ops;
        Assert.Equal(Dump(first), Dump(ops));
        var page = ops.Single(o => Is(o, "IContainer", "Page"))["as"]!.ToString();
        var iff = ops.FindIndex(o => Is(o, "IIfWidget", "IfBanner"));
        Assert.True(iff >= 0, Dump(ops));
        Assert.Equal(page, ops[iff]["parent"]!.ToString());
        var alias = ops[iff]["as"]!.ToString();
        Assert.True(Sets(ops[iff + 1], "Condition", "ShowBanner") && ops[iff + 1]["target"]!.ToString() == alias, Dump(ops));
        var container = ops.FindIndex(o => Is(o, "IContainer", "Banner"));
        Assert.Equal(alias + "/TrueBranch", ops[container]["parent"]!.ToString());
        // the If takes the element's place among its siblings
        var before = ops.FindIndex(o => Sets(o, "Value", "\"antes\"")); var after = ops.FindIndex(o => Sets(o, "Value", "\"depois\""));
        Assert.True(before < iff && iff < container && container < after, Dump(ops));
        Assert.Contains(ops, o => Sets(o, "Style", "\"banner\"") && o["target"]!.ToString() == ops[container]["as"]!.ToString());
        Assert.DoesNotContain(ops, o => o["prop"]?.ToString() == "Visible"); // neither the binding nor the hidden attribute
        // a key whose If name collides with another key is refused instead of renamed
        var clash = Page("""<div data-av="banner">a</div><div data-av="if.banner">b</div>""", """{"banner":{"kind":"visible","condition":"True"},"if.banner":{"kind":"class","value":"\"x\""}}""", source: false);
        Assert.Contains("already used by another key", Assert.Throws<InvalidOperationException>(() => Expand(clash)).Message);
    }

    [Fact] public void AVisibleDivNestedInALinkBecomesAnIfInsideTheLink()
    {
        var ops = Expand(Page("""<a href="#" class="row" data-av="open"><div class="flag" data-av="flag">Novo</div>Ver lista</a>""",
            """{"open":{"kind":"navigate","destination":"IncidentList"},"flag":{"kind":"visible","condition":"Filter_PriorityId <> NullIdentifier()"}}""", source: false)).Ops;
        var link = ops.Single(o => Is(o, "ILink", "Open"))["as"]!.ToString();
        Assert.Contains(ops, o => o["op"]?.ToString() == "delete" && o["target"]?.ToString() == link + "/#ITextWidget");
        Assert.DoesNotContain(ops, o => o["target"]?.ToString() == link + "/#ITextWidget" && o["op"]?.ToString() == "set");
        var iff = ops.Single(o => Is(o, "IIfWidget", "IfFlag"));
        Assert.Equal(link, iff["parent"]!.ToString());
        Assert.Contains(ops, o => Sets(o, "Condition", "Filter_PriorityId <> NullIdentifier()"));
        var flag = ops.Single(o => Is(o, "IContainer", "Flag"));
        Assert.Equal(iff["as"]!.ToString() + "/TrueBranch", flag["parent"]!.ToString());
        var caption = ops.FindIndex(o => Sets(o, "Value", "\"Ver lista\""));
        Assert.Equal(link, ops[caption - 1]["parent"]!.ToString());
        Assert.Contains(ops, o => Sets(o, "Style", "\"row\"") && o["target"]!.ToString() == link);
        Assert.Contains(ops, o => Sets(o, "Destination", "IMobileScreen:IncidentList") && o["target"]!.ToString() == link + "/OnClick");
    }

    [Fact] public void ACardWrappedInALinkKeepsItsDivIconAndBindings()
    {
        var ops = Expand(Page("""<div class="cards" data-av="cards"><a href="#" class="card-link" data-av="card.open"><div class="card"><i class="fa fa-star"></i><span class="title" data-av="card.title">Título</span><div class="state" data-av="card.state">x</div><div class="hot" data-av="card.hot">Urgente</div></div></a></div>""",
            """{"cards":{"kind":"list"},"card.open":{"kind":"navigate","destination":"IncidentDetail","args":{"IncidentId":"GetIncidents.List.Current.Incident.Id"}},"card.title":{"kind":"field","field":"Title"},"card.state":{"kind":"class","value":"If(GetIncidents.List.Current.Incident.PriorityId = NullIdentifier(), \"\", \"set\")"},"card.hot":{"kind":"visible","condition":"GetIncidents.List.Current.Incident.SlaDueAt < CurrDateTime()"}}""")).Ops;
        var list = ops.Single(o => Is(o, "IList", "Cards"))["as"]!.ToString();
        var link = ops.Single(o => Is(o, "ILink", "CardOpen")); Assert.Equal(list, link["parent"]!.ToString());
        var linkAlias = link["as"]!.ToString();
        Assert.Contains(ops, o => o["op"]?.ToString() == "delete" && o["target"]?.ToString() == linkAlias + "/#ITextWidget");
        var card = ops.Single(o => Is(o, "IContainer") && o["parent"]?.ToString() == linkAlias)["as"]!.ToString();
        Assert.Contains(ops, o => Sets(o, "Style", "\"card\"") && o["target"]!.ToString() == card);
        var icon = ops.FindIndex(o => Sets(o, "Tag", "i"));
        var iconAlias = ops[icon]["target"]!.ToString();
        Assert.Equal(card, ops.Single(o => o["as"]?.ToString() == iconAlias)["parent"]!.ToString());
        var iconClass = ops.FindIndex(o => Sets(o, "Property", "class") && ops.Single(c => c["as"]?.ToString() == o["target"]!.ToString())["parent"]!.ToString() == iconAlias);
        Assert.True(Sets(ops[iconClass + 1], "Value", "\"fa fa-star\""), Dump(ops));
        var span = ops.Single(o => Is(o, "IAdvancedHtml", "CardTitle"))["as"]!.ToString();
        Assert.Equal(card, ops.Single(o => o["as"]?.ToString() == span)["parent"]!.ToString());
        Assert.Contains(ops, o => Is(o, "IExpression") && o["parent"]?.ToString() == span + "/Content");
        Assert.Contains(ops, o => Sets(o, "Value", "GetIncidents.List.Current.Incident.Title"));
        Assert.Contains(ops, o => Sets(o, "Style", "\"state \" + If(GetIncidents.List.Current.Incident.PriorityId = NullIdentifier(), \"\", \"set\")"));
        var iff = ops.Single(o => Is(o, "IIfWidget", "IfCardHot")); Assert.Equal(card, iff["parent"]!.ToString());
        Assert.Equal(iff["as"]!.ToString() + "/TrueBranch", ops.Single(o => Is(o, "IContainer", "CardHot"))["parent"]!.ToString());
        Assert.Contains(ops, o => o["target"]?.ToString() == linkAlias + "/OnClick/IncidentId" && o["value"]?.ToString() == "GetIncidents.List.Current.Incident.Id");
    }

    [Fact] public void AnIconInsideAButtonIsAChildWidgetBeforeItsText()
    {
        var ops = Expand(Page("""<button class="icon-btn" title="Fechar" data-av="close"><i class="fa fa-times"></i>Fechar</button>""",
            """{"close":{"kind":"call","action":"Incident_Close","args":{"IncidentId":"GetIncidents.List.Current.Incident.Id"}}}""")).Ops;
        var button = ops.Single(o => Is(o, "IButton", "Close"))["as"]!.ToString();
        Assert.Contains(ops, o => o["op"]?.ToString() == "delete" && o["target"]?.ToString() == button + "/#ITextWidget");
        var icon = ops.FindIndex(o => Is(o, "IAdvancedHtml") && o["parent"]?.ToString() == button);
        var text = ops.FindIndex(o => Is(o, "IExpression") && o["parent"]?.ToString() == button);
        Assert.True(icon >= 0 && text > icon, Dump(ops));
        Assert.True(Sets(ops[icon + 1], "Tag", "i"), Dump(ops));
        Assert.True(Sets(ops[text + 1], "Value", "\"Fechar\""), Dump(ops));
        Assert.Contains(ops, o => Sets(o, "Style", "\"icon-btn\"") && o["target"]!.ToString() == button);
        Assert.Contains(ops, o => Is(o, "IExecuteServerActionNode", "Incident_Close"));
        // a text-only button keeps its native caption (no delete, no extra expression)
        var plain = Expand(Page("""<button data-av="close">Fechar</button>""", """{"close":{"kind":"call","action":"Incident_Close","args":{"IncidentId":"1"}}}""")).Ops;
        Assert.DoesNotContain(plain, o => o["op"]?.ToString() == "delete");
        Assert.Contains(plain, o => o["target"]?.ToString().EndsWith("/#ITextWidget") == true && Sets(o, "Text", "Fechar"));
    }

    [Fact] public void PagingBoundsAndFilterChangesUseIndependentOffsets()
    {
        var ops = Expand(Reference()).Ops;
        Assert.Contains(ops, o => Sets(o, "Enabled", "LoadRecent.IsDataFetched and (RecentOffset + 20 < LoadRecent.Total)"));
        Assert.Contains(ops, o => Sets(o, "Value", "If(MineOffset < 10, 0, MineOffset - 10)"));
        var search = ops.Single(o => Is(o, "IScreenAction", "SearchChanged"))["as"]!.ToString();
        var assign = Assert.Single(ops, o => Is(o, "IAssignNode") && o["parent"]?.ToString() == search)["as"]!.ToString();
        var assignment = Assert.Single(ops, o => Is(o, "IAssignment") && o["parent"]?.ToString() == assign)["as"]!.ToString();
        Assert.Contains(ops, o => o["target"]?.ToString() == assignment && Sets(o, "Variable", "RecentOffset"));
        Assert.Contains(ops, o => o["target"]?.ToString() == assignment && Sets(o, "Value", "0"));
    }

    [Fact] public void NamespacedFunctionsDoNotOverwriteUnownedFunctionsOrRewriteQuotedText()
    {
        var data = Reference();
        data["bindings"]!["neardue.sla"]!["value"] = "\"SlaCountdown(\" + SlaCountdown(LoadNearDue.Incidents.Current.SlaDueAt)";
        var ops = Expand(data).Ops;
        Assert.Contains(ops, o => Sets(o, "Value", "\"SlaCountdown(\" + Dashboard_SlaCountdown(LoadNearDue.Incidents.Current.SlaDueAt)"));
        Assert.DoesNotContain(ops, o => o["op"]?.ToString() == "delete" && o["target"]?.ToString() == "IClientAction:SlaCountdown");
        var ex = Assert.Throws<InvalidOperationException>(() => HtmlExpander.Expand(data,
            refs => refs.Contains("IClientAction:Dashboard_SlaCountdown") ? "IClientAction:Dashboard_SlaCountdown" : Resolve(refs), Contract, "Reactive"));
        Assert.Contains("not owned by this page", ex.Message);
    }
    [Fact] public void AuthoredHeadingDoesNotGetASecondNativeTitle()
    {
        var page = Expand(Page("<h1>Overview</h1>", source: false));
        Assert.DoesNotContain(page.Ops, o => o["parent"]?.ToString().EndsWith("/Title") == true);
    }

    [Fact] public void MultipleDerivationsShareOneFetchHandlerAndBothRun()
    {
        var data = Reference();
        data["derived"]!.AsArray().Add(JsonNode.Parse("""{"name":"StatusSum","source":"LoadDashboard","output":"IncidentsByStatus","sum":"Total"}"""));
        var ops = Expand(data).Ops;
        Assert.Single(ops, o => o["target"]?.ToString().EndsWith("/OnAfterFetch") == true && o["prop"]?.ToString() == "Destination");
        var loops = ops.Where(o => Is(o, "IForEachNode")).ToArray();
        Assert.Equal(2, loops.Length);
        Assert.Equal(loops[0]["parent"]!.ToString(), loops[1]["parent"]!.ToString());
    }

    [Fact] public void SearchAndPriorityOnlyRefreshTheirConsumer()
    {
        var ops = Expand(Reference()).Ops;
        foreach (var name in new[] { "SearchChanged", "FilterPriorityChanged" })
        {
            var action = ops.Single(o => Is(o, "IScreenAction", name))["as"]!.ToString();
            var refresh = Assert.Single(ops, o => Is(o, "IRefreshDataNode") && o["parent"]?.ToString() == action);
            Assert.Equal("RefreshLoadRecent", refresh["name"]!.ToString());
        }
    }

    [Fact] public void NestedCssConditionsArePreservedWhenScoped()
    {
        var sheet = CssStylesheet.Parse("@media (min-width:900px){@supports (display:grid){.a{display:grid}}}");
        var scoped = sheet.Scoped(".av-test");
        Assert.Contains("@media (min-width:900px)", scoped);
        Assert.Contains("@supports (display:grid)", scoped);
        Assert.Contains(".av-test .a", scoped);
        Assert.Equal(3, scoped.Count(c => c == '{'));
    }
    private static readonly string Root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(HtmlSpecTests).Assembly.Location)!)!;
    private static UiParam Param(string name, string type, bool required = false) => new(name, type, required, null, null);
    private static readonly UiParam[] IncidentFields = [Param("Id", "Incident Identifier"), Param("Title", "Text", true), Param("StatusId", "IncidentStatus Identifier"), Param("PriorityId", "IncidentPriority Identifier"), Param("AssigneeId", "User Identifier"), Param("SlaDueAt", "Date Time"), Param("CreatedAt", "Date Time")];
    private static readonly UiParam[] MetricFields = [Param("Label", "Text"), Param("Total", "Integer")];
    private static readonly UiParam[] ListInputs = [Param("Search", "Text"), Param("StatusId", "IncidentStatus Identifier"), Param("PriorityId", "IncidentPriority Identifier"), Param("AssigneeId", "User Identifier"), Param("OnlyMine", "Boolean"), Param("OnlyOverdue", "Boolean"), Param("OnlyOpen", "Boolean"), Param("OnlyResolvedToday", "Boolean"), Param("StartDate", "Date Time"), Param("EndDate", "Date Time"), Param("StartIndex", "Integer"), Param("MaxRecords", "Integer")];
    private static ScreenContract Contract(string reference)
    {
        var name = reference.Split(':')[1];
        string[] placeholders = name switch { "LayoutTopMenu" => ["Title", "MainContent"], "LayoutBlank" => ["Content"], "Layout" => ["Title", "Content"], "DatePicker" => ["Datepicker", "Placeholder_SSPreview"], _ => [] };
        UiParam[] inputs = name switch
        {
            "IncidentList" => [Param("Search", "Text"), Param("StatusId", "IncidentStatus Identifier"), Param("PriorityId", "IncidentPriority Identifier"), Param("OnlyMine", "Boolean"), Param("OnlyOverdue", "Boolean"), Param("OnlyOpen", "Boolean"), Param("OnlyResolvedToday", "Boolean"), Param("StartDate", "Date Time"), Param("EndDate", "Date Time")],
            "IncidentDetail" or "Incident_Close" => [Param("IncidentId", "Incident Identifier", true)],
            "GetDashboardMetricsForPeriod" => [Param("StartDate", "Date Time"), Param("EndDate", "Date Time")],
            "GetIncidentsNearDue" => [Param("StartDate", "Date Time"), Param("EndDate", "Date Time"), Param("StartIndex", "Integer"), Param("MaxRecords", "Integer")],
            "GetIncidentList" => ListInputs,
            "DatePicker" => [Param("DateFormat", "Text"), Param("ShowTodayButton", "Boolean"), Param("ExtendedClass", "Text")],
            _ => [],
        };
        UiParam[] outputs = name switch
        {
            "GetDashboardMetricsForPeriod" => [Param("TotalOpen", "Integer"), Param("TotalOverdue", "Integer"), Param("TotalCritical", "Integer"), Param("TotalResolvedToday", "Integer"), Param("MyOpenIncidents", "Integer"), Param("IncidentsByStatus", "IncidentStatusMetric List"), Param("IncidentsByPriority", "IncidentPriorityMetric List")],
            "GetIncidentsNearDue" => [Param("Incidents", "Incident List"), Param("Total", "Long Integer")],
            "GetIncidentList" => [Param("Incidents", "Incident List"), Param("Total", "Integer")],
            _ => [],
        };
        UiEvent[] events = name == "DatePicker" ? [new("Initialized", false, null, [Param("DatePickerId", "Text")]), new("OnSelected", true, null, [Param("DatePickerId", "Text"), Param("SelectedDateTime", "Date Time")])] : [];
        var outputFields = new Dictionary<string, IReadOnlyList<UiParam>>(StringComparer.OrdinalIgnoreCase) { ["IncidentsByStatus"] = MetricFields, ["IncidentsByPriority"] = [.. MetricFields, Param("PriorityId", "IncidentPriority Identifier")], ["Incidents"] = IncidentFields };
        return new(reference, inputs, outputs, IncidentFields, events, placeholders.Select(p => new UiPlaceholder(p, null, p, [])).ToArray(), outputFields, new Dictionary<string, IReadOnlyList<string>>());
    }
    private static readonly string[] Known = ["IMobileFlow:MainFlow", "IMobileBlock:LayoutTopMenu", "IMobileBlock:LayoutBlank", "IMobileBlock:UserInfo", "IMobileBlock:Layout", "IMobileBlock:DatePicker", "IServerEntity:Incident", "IStaticEntity:IncidentPriority", "IStaticEntity:IncidentStatus",
        "IMobileScreen:IncidentList", "IMobileScreen:IncidentCreate", "IMobileScreen:IncidentDetail", "IServerAction:Incident_Close", "IServerAction:GetDashboardMetricsForPeriod", "IServerAction:GetIncidentsNearDue", "IServerAction:GetIncidentList"];
    private static string? Resolve(string[] references) => references.FirstOrDefault(Known.Contains);
    private static HtmlCompilation Expand(JsonObject data, JsonObject? existing = null) => HtmlExpander.Expand(data, Resolve, Contract, "Reactive", existing);
    private static JsonObject Page(string body, string? bindings = null, bool source = true)
    {
        var data = JsonNode.Parse("""{"screen":"Dashboard","title":"Visão geral","html":""}""")!.AsObject();
        data["html"] = "<!doctype html><html><head><style>.metric{padding:4px}</style></head><body>" + body + "</body></html>";
        if (source) data["source"] = JsonNode.Parse("""{"entity":"Incident","as":"GetIncidents","max":20}""");
        if (body.Contains("data-av=\"search\"")) data["search"] = JsonNode.Parse("""{"key":"search","field":"Title"}""");
        if (bindings != null) data["bindings"] = JsonNode.Parse(bindings);
        return data;
    }
    private static JsonObject Reference()
    {
        var page = Path.Combine(Root, "tests", "html", "incidents-dashboard.html");
        var data = JsonNode.Parse(File.ReadAllText(Path.ChangeExtension(page, ".bindings.json")))!.AsObject();
        data["html"] = File.ReadAllText(page);
        return data;
    }
    private static string Dump(IEnumerable<JsonObject> ops) => string.Join("\n", ops.Select(o => o.ToJsonString()));
    private static bool Is(JsonObject o, string type, string? name = null) => o["type"]?.ToString() == type && (name == null || o["name"]?.ToString() == name);
    private static bool Sets(JsonObject o, string prop, string value) => o["op"]?.ToString() == "set" && o["prop"]?.ToString() == prop && o["value"]?.ToString() == value;

    [Fact] public void TheReferenceDashboardCompilesDeterministicallyWithItsBehaviours()
    {
        var first = Expand(Reference()); var second = Expand(Reference());
        Assert.Equal(Dump(first.Ops), Dump(second.Ops));
        var ops = first.Ops;
        Assert.Contains(ops, o => Is(o, "IMobileScreen", "Dashboard"));
        foreach (var source in new[] { "LoadDashboard", "LoadNearDue", "LoadMine", "LoadRecent" }) Assert.Contains(ops, o => Is(o, "IDataAction", source));
        Assert.Contains(ops, o => Is(o, "IOutputParameter", "IncidentsByStatus"));
        Assert.Contains(ops, o => Sets(o, "Value", "ReadSource.TotalOpen"));
        Assert.Contains(ops, o => o["target"]?.ToString().EndsWith("/EndDate") == true && o["value"]?.ToString() == "DashboardEndDate");
        // derived value over a fetched list: native loop on OnAfterFetch into a screen variable
        Assert.Contains(ops, o => Is(o, "ILocalVariable", "StatusMax")); Assert.Contains(ops, o => Is(o, "IScreenAction", "DeriveStatusMax"));
        Assert.Contains(ops, o => Is(o, "IForEachNode")); Assert.Contains(ops, o => Sets(o, "Condition", "LoadDashboard.IncidentsByStatus.Current.Total > StatusMax"));
        Assert.Contains(ops, o => o["target"]?.ToString().EndsWith("/OnAfterFetch") == true && o["prop"]?.ToString() == "Destination");
        // period: native DatePickers bound to the declared variables, one handler each, refreshing every source
        Assert.Equal(2, ops.Count(o => Is(o, "IMobileBlockInstanceWidget") && o["source"]?.ToString() == "IMobileBlock:DatePicker"));
        Assert.Contains(ops, o => Sets(o, "Variable", "DashboardStartDate") && o["target"]!.ToString().EndsWith("/Datepicker/#IInput"));
        var startHandler = ops.First(a => Is(a, "IScreenAction", "PeriodStartSelected"))["as"]!.ToString();
        Assert.Contains(ops, o => Sets(o, "Handler", ops.First(a => Is(a, "IScreenAction", "PeriodEndSelected"))["as"]!.ToString()));
        Assert.Equal(4, ops.Count(o => Is(o, "IRefreshDataNode") && o["parent"]?.ToString() == startHandler));
        Assert.Contains(ops, o => Is(o, "IInputParameter", "SelectedDateTime") && o["parent"]?.ToString() == startHandler);
        // repeaters and tables over the right lists, fields resolved against the row
        Assert.Contains(ops, o => Is(o, "IList", "StatusBars")); Assert.Contains(ops, o => Sets(o, "Source", "LoadDashboard.IncidentsByStatus"));
        Assert.Contains(ops, o => Sets(o, "Value", "LoadDashboard.IncidentsByStatus.Current.Label"));
        Assert.Contains(ops, o => Is(o, "IList", "PriorityItems")); Assert.Contains(ops, o => Sets(o, "Source", "LoadDashboard.IncidentsByPriority"));
        Assert.Contains(ops, o => Is(o, "ITableRecords", "Recent")); Assert.Contains(ops, o => Sets(o, "Source", "LoadRecent.Incidents"));
        Assert.Contains(ops, o => Sets(o, "Value", "LoadRecent.Incidents.Current.Title"));
        Assert.Contains(ops, o => Is(o, "ITableRecords", "Neardue")); Assert.Contains(ops, o => Is(o, "ITableRecords", "Mine"));
        // dynamic style expressions, client function, search/filter/refresh/navigation
        Assert.Contains(ops, o => Sets(o, "Property", "style"));
        Assert.Contains(ops, o => o["prop"]?.ToString() == "Value" && o["value"]!.ToString().StartsWith("\"width:\" + If(StatusMax = 0"));
        Assert.Contains(ops, o => Is(o, "IClientAction", "Dashboard_SlaCountdown")); Assert.Contains(ops, o => Sets(o, "Value", "Dashboard_SlaCountdown(LoadNearDue.Incidents.Current.SlaDueAt)"));
        Assert.Contains(ops, o => o["prop"]?.ToString() == "Function" && o["value"]!.GetValue<bool>());
        Assert.Contains(ops, o => Is(o, "IJavaScriptNode", "Run"));
        Assert.Contains(ops, o => Is(o, "IInput", "Search")); Assert.Contains(ops, o => Sets(o, "Variable", "SearchText"));
        Assert.Contains(ops, o => Is(o, "IDropdown", "FilterPriority")); Assert.Contains(ops, o => Sets(o, "Variable", "Filter_PriorityId"));
        Assert.Contains(ops, o => Is(o, "IScreenAction", "SearchChanged")); Assert.Contains(ops, o => Is(o, "IScreenAction", "FilterPriorityChanged")); Assert.Contains(ops, o => Is(o, "IScreenAction", "RefreshHandler"));
        Assert.Contains(ops, o => Is(o, "ILink", "OpenOverdue")); Assert.Contains(ops, o => o["target"]?.ToString().EndsWith("/OnClick/OnlyOverdue") == true && o["value"]?.ToString() == "True");
        Assert.Contains(ops, o => Is(o, "IButton", "New")); Assert.Contains(ops, o => Sets(o, "Destination", "IMobileScreen:IncidentCreate"));
        Assert.Contains(ops, o => Is(o, "IContainer", "Page")); Assert.Contains(ops, o => Sets(o, "Style", "\"av-dashboard\""));
        Assert.Contains(ops, o => Sets(o, "Tag", "header")); Assert.Contains(ops, o => Sets(o, "Tag", "h1"));
        Assert.DoesNotContain(ops, o => Sets(o, "Property", "id"));
        // report and scoped stylesheet
        var report = first.Report;
        Assert.Equal("create", report["mode"]!.ToString());
        Assert.Equal(72, report["keys"]!.AsArray().Count);
        Assert.Equal(new[] { "LoadDashboard", "LoadNearDue", "LoadMine", "LoadRecent" }, report["sources"]!.AsArray().Select(s => s!.ToString()).ToArray());
        Assert.False(report["stylesheet"]!["installed"]!.GetValue<bool>()); Assert.Equal(".av-dashboard", report["stylesheet"]!["scope"]!.ToString());
        Assert.NotNull(first.ScopedCss);
        Assert.StartsWith(".av-dashboard :where(.OSFillParent) { width: auto; }", first.ScopedCss);
        Assert.Contains(".av-dashboard {", first.ScopedCss);
        Assert.Contains(".av-dashboard .metric.warn .metric-value {", first.ScopedCss);
        Assert.Contains("@media(max-width:760px) {", first.ScopedCss);
        Assert.DoesNotContain("\n.metric", first.ScopedCss);
    }

    [Fact] public void AnExistingScreenIsUpdatedInPlaceKeepingItsVariables()
    {
        var existing = JsonNode.Parse("""{"key":"k6ppUFvdxkCWTmO_wD3P5A","variables":{"DashboardStartDate":"Date Time","DashboardEndDate":"Date Time","DashboardLastDatePickerId":"Text"}}""")!.AsObject();
        var compiled = Expand(Reference(), existing); var ops = compiled.Ops;
        Assert.DoesNotContain(ops, o => Is(o, "IMobileScreen"));
        Assert.DoesNotContain(ops, o => Is(o, "ILocalVariable", "DashboardStartDate"));
        Assert.Contains(ops, o => Is(o, "ILocalVariable", "LastDatePickerId"));
        Assert.Contains(ops, o => Is(o, "IDataAction", "LoadDashboard") && o["parent"]?.ToString() == "IMobileScreen:Dashboard");
        Assert.Equal("update", compiled.Report["mode"]!.ToString());
        Assert.Equal(new[] { "DashboardStartDate", "DashboardEndDate" }, compiled.Report["variables"]!["kept"]!.AsArray().Select(v => v!.ToString()).ToArray());
        var wrongType = JsonNode.Parse("""{"variables":{"DashboardStartDate":"Date"}}""")!.AsObject();
        Assert.Contains("exists as Date", Assert.Throws<InvalidOperationException>(() => Expand(Reference(), wrongType)).Message);
    }

    [Fact] public void TagsOrderClassesAndAttributesArePreserved()
    {
        var ops = Expand(Page("""<section class="metrics" aria-label="Indicadores"><h1 id="top">Título</h1><div class="metric warn" style="gap:4px"><span>x</span></div></section>""", null, false)).Ops;
        var section = ops.FindIndex(o => Sets(o, "Tag", "section")); var h1 = ops.FindIndex(o => Sets(o, "Tag", "h1"));
        var div = ops.FindIndex(o => Is(o, "IContainer") && o["name"] == null); var span = ops.FindIndex(o => Sets(o, "Tag", "span"));
        Assert.True(section >= 0 && section < h1 && h1 < div && div < span, Dump(ops));
        Assert.Contains(ops, o => Sets(o, "Property", "class")); Assert.Contains(ops, o => Sets(o, "Value", "\"metrics\""));
        Assert.Contains(ops, o => Sets(o, "Property", "aria-label")); Assert.Contains(ops, o => Sets(o, "Property", "style")); Assert.Contains(ops, o => Sets(o, "Value", "\"gap:4px\""));
        Assert.DoesNotContain(ops, o => Sets(o, "Property", "id"));
        Assert.Contains(ops, o => Sets(o, "Style", "\"metric warn\"")); Assert.Contains(ops, o => Sets(o, "Value", "\"Título\""));
        var h1Alias = ops[h1]["target"]!.ToString();
        Assert.Contains(ops, o => Is(o, "IExpression") && o["parent"]?.ToString() == h1Alias + "/Content");
        Assert.Equal(2, ops.Count(o => Is(o, "IExpression") && o["parent"]?.ToString().EndsWith("/Title") == false));
    }

    [Fact] public void DynamicClassAndStyleCombineWithTheStaticAttribute()
    {
        var ops = Expand(Page("""<div class="fill" data-av="f">x</div><span class="dot" data-av="d"></span>""",
            """{"f":{"kind":"class","value":"If(True, \"on\", \"\")"},"d":{"kind":"style","value":"\"background-color:red\""}}""", false)).Ops;
        Assert.Contains(ops, o => Sets(o, "Style", "\"fill \" + If(True, \"on\", \"\")"));
        var style = ops.FindIndex(o => Sets(o, "Value", "\"background-color:red\""));
        Assert.True(style > 0 && Sets(ops[style - 1], "Property", "style"), Dump(ops));
    }

    [Fact] public void NavigationAndCallsCheckTheirDestinationsAndArguments()
    {
        var ops = Expand(Page("""<a href="#" data-av="open">Ver lista</a><button data-av="close">Fechar</button>""",
            """{"open":{"kind":"navigate","destination":"IncidentList","args":{"PriorityId":"Filter_PriorityId"}},"close":{"kind":"call","action":"Incident_Close","args":{"IncidentId":"GetIncidents.List.Current.Incident.Id"}}}""")).Ops;
        Assert.Contains(ops, o => Is(o, "ILink", "Open")); Assert.Contains(ops, o => Sets(o, "Destination", "IMobileScreen:IncidentList"));
        Assert.Contains(ops, o => o["target"]?.ToString().EndsWith("/OnClick/PriorityId") == true && o["value"]?.ToString() == "Filter_PriorityId");
        Assert.Contains(ops, o => Is(o, "IExecuteServerActionNode", "Incident_Close")); Assert.Contains(ops, o => Is(o, "IRefreshDataNode"));
        Assert.Contains("unknown argument 'Missing'", Assert.Throws<InvalidOperationException>(() => Expand(Page("""<a data-av="open">Ver</a>""", """{"open":{"kind":"navigate","destination":"IncidentList","args":{"Missing":"1"}}}"""))).Message);
        Assert.Contains("missing required argument 'IncidentId'", Assert.Throws<InvalidOperationException>(() => Expand(Page("""<a data-av="open">Ver</a>""", """{"open":{"kind":"navigate","destination":"IncidentDetail"}}"""))).Message);
        Assert.Contains("reference not found", Assert.Throws<InvalidOperationException>(() => Expand(Page("""<a data-av="open">Ver</a>""", """{"open":{"kind":"navigate","destination":"Nowhere"}}"""))).Message);
    }

    [Fact] public void LabelsTargetTheControlsTheyDescribe()
    {
        var ops = Expand(Page("""<label for="q">Busca</label><input id="q" data-av="search">""")).Ops;
        var input = ops.FindIndex(o => Is(o, "IInput")); var target = ops.FindIndex(o => o["prop"]?.ToString() == "TargetWidget");
        Assert.True(input >= 0 && target > input, Dump(ops));
        Assert.Equal(ops[input]["as"]!.ToString(), ops[target]["value"]!.ToString());
    }

    [Theory]
    [InlineData("script", "<script>alert(1)</script>", null, "inline scripts are not compiled")]
    [InlineData("orphan-key", """<div data-av="ghost">x</div>""", null, "has no binding")]
    [InlineData("orphan-binding", "<div>x</div>", """{"ghost":{"kind":"text","value":"1"}}""", "matches no element")]
    [InlineData("duplicate-key", """<div data-av="a">x</div><p data-av="a">y</p>""", """{"a":{"kind":"text","value":"1"}}""", "used twice")]
    [InlineData("unknown-kind", """<div data-av="a">x</div>""", """{"a":{"kind":"magic"}}""", "unknown kind 'magic'")]
    [InlineData("unknown-binding-key", """<div data-av="a">x</div>""", """{"a":{"kind":"text","value":"1","colour":"red"}}""", "unknown keys: colour")]
    [InlineData("static-table", "<table><tr><td>x</td></tr></table>", null, "must be bound with kind list")]
    [InlineData("row-mismatch", """<table data-av="t"><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td data-av="f">x</td></tr></tbody></table>""", """{"t":{"kind":"list"},"f":{"kind":"field","field":"Title"}}""", "must match")]
    [InlineData("demo-rows", """<table data-av="t"><thead><tr><th>a</th></tr></thead><tbody><tr><td data-av="f">x</td></tr><tr><td>demo</td></tr></tbody></table>""", """{"t":{"kind":"list"},"f":{"kind":"field","field":"Title"}}""", "one template <tr>")]
    [InlineData("repeater-two-children", """<ul data-av="l"><li data-av="f">a</li><li>b</li></ul>""", """{"l":{"kind":"list"},"f":{"kind":"field","field":"Title"}}""", "exactly one child element")]
    [InlineData("repeater-wrong-tag", """<span data-av="l"><b data-av="f">a</b></span>""", """{"l":{"kind":"list"},"f":{"kind":"field","field":"Title"}}""", "kind list needs a <table>")]
    [InlineData("dead-button", "<button>Nada</button>", null, "needs a navigate, call, refresh or page binding")]
    [InlineData("unknown-attribute", """<div onclick="go()">x</div>""", null, "attribute 'onclick' is not compiled")]
    [InlineData("unclosed", "<div><p>x", null, "html: line")]
    [InlineData("bad-close", "<div></span>", null, "unexpected </span>")]
    [InlineData("field-outside-list", """<div data-av="a">x</div>""", """{"a":{"kind":"field","field":"Title"}}""", "only valid inside an element bound with kind list")]
    [InlineData("unknown-field", """<table data-av="t"><thead><tr><th>a</th></tr></thead><tbody><tr><td data-av="f">x</td></tr></tbody></table>""", """{"t":{"kind":"list"},"f":{"kind":"field","field":"Nope"}}""", "field 'Nope' does not exist")]
    [InlineData("unknown-tag", "<marquee>x</marquee>", null, "<marquee> is not compiled")]
    [InlineData("input-type", """<input type="email" data-av="search">""", null, "input type email is not compiled")]
    [InlineData("date-without-var", """<input type="date" data-av="d">""", """{"d":{"kind":"date","variable":"When"}}""", "is not declared in vars")]
    [InlineData("text-with-children", """<div data-av="a"><b>x</b></div>""", """{"a":{"kind":"text","value":"1"}}""", "must not contain child elements")]
    [InlineData("visible-on-element", """<section data-av="a">x</section>""", """{"a":{"kind":"visible","condition":"True"}}""", "kind visible needs a <div>")]
    [InlineData("form", "<form><input data-av='q'></form>", null, "forms need the native validation")]
    [InlineData("empty-link", """<a data-av="o"></a>""", """{"o":{"kind":"refresh"}}""", "needs visible content")]
    [InlineData("button-in-link", """<a data-av="o"><span>x</span><button data-av="c">y</button></a>""", """{"o":{"kind":"refresh"},"c":{"kind":"refresh"}}""", "cannot contain another Link/Button")]
    [InlineData("list-in-link", """<a data-av="o"><ul data-av="l"><li data-av="f">a</li></ul></a>""", """{"o":{"kind":"refresh"},"l":{"kind":"list"},"f":{"kind":"field","field":"Title"}}""", "<ul> (kind list) cannot be compiled inside <a> (line 1 col")]
    [InlineData("input-in-button", """<button data-av="o"><input data-av="search"></button>""", """{"o":{"kind":"refresh"}}""", "form controls do not belong inside a Link/Button")]
    [InlineData("bound-in-label", """<label>Total <span data-av="t">0</span></label>""", """{"t":{"kind":"text","value":"1"}}""", "inside a <label> is not compiled")]
    public void UnprovenConstructsAreRejectedWithTheirPosition(string _, string body, string? bindings, string message)
    {
        Assert.Contains(message, Assert.Throws<InvalidOperationException>(() => Expand(Page(body, bindings, source: true))).Message);
    }

    [Fact] public void ExistingScreensSourcesAndStylesheetsAreValidated()
    {
        var data = Page("<div>x</div>"); data["screen"] = "IncidentList";
        Assert.Contains("exists; the caller must describe it", Assert.Throws<InvalidOperationException>(() => Expand(data)).Message);
        var css = Page("<div>x</div>"); css["css"] = ".a{color:red";
        Assert.Contains("css: line", Assert.Throws<InvalidOperationException>(() => Expand(css)).Message);
        var idSelector = Page("<div>x</div>"); idSelector["css"] = "#status{color:red}";
        Assert.Contains("reserves the id attribute", Assert.Throws<InvalidOperationException>(() => Expand(idSelector)).Message);
        var import = Page("<div>x</div>"); import["css"] = "@import url(x.css);";
        Assert.Contains("must be self-contained", Assert.Throws<InvalidOperationException>(() => Expand(import)).Message);
        var noSource = Page("""<button data-av="r">Atualizar</button>""", """{"r":{"kind":"refresh"}}""", source: false);
        Assert.Contains("requires a source", Assert.Throws<InvalidOperationException>(() => Expand(noSource)).Message);
        var deadFilter = Reference(); deadFilter["sources"]![3]!["args"]!["Search"] = "\"\"";
        Assert.Contains("no source reads it", Assert.Throws<InvalidOperationException>(() => Expand(deadFilter)).Message);
        var ambiguous = Reference(); ambiguous["bindings"]!["status.bars"] = JsonNode.Parse("""{"kind":"list","source":"LoadDashboard"}""");
        Assert.Contains("name the output", Assert.Throws<InvalidOperationException>(() => Expand(ambiguous)).Message);
        var none = Reference(); none["stylesheet"] = "none";
        Assert.Null(Expand(none).ScopedCss);
    }

    [Fact] public void PreflightProvesWhatNeedsNoModule()
    {
        var report = HtmlExpander.Preflight(Reference());
        Assert.Equal(72, report["keys"]!.GetValue<int>()); Assert.True(report["cssRules"]!.GetValue<int>() > 50);
        var idSelector = Page("<div>x</div>"); idSelector["css"] = "#status{color:red}";
        Assert.Contains("reserves the id attribute", Assert.Throws<InvalidOperationException>(() => HtmlExpander.Preflight(idSelector)).Message);
        Assert.Contains("has no binding", Assert.Throws<InvalidOperationException>(() => HtmlExpander.Preflight(Page("""<div data-av="ghost">x</div>"""))).Message);
    }

    [Fact] public void HtmlParserHandlesOptionalEndTagsEntitiesCommentsAndPositions()
    {
        var root = HtmlSource.Parse("<!-- note --><ul class=list><li>a &amp; b<li>&#169; <b>c</b></ul><p>one<p>two");
        var ul = root.Elements.First(); Assert.Equal("ul", ul.Tag); Assert.Equal("list", ul.Attribute("class"));
        Assert.Equal(2, ul.Elements.Count()); Assert.Equal("a & b", ul.Elements.First().InnerText()); Assert.Equal("© c", ul.Elements.Last().InnerText());
        Assert.Equal(new[] { "ul", "p", "p" }, root.Elements.Select(e => e.Tag).ToArray());
        Assert.Equal("two", root.Elements.Last().InnerText());
        var error = Assert.Throws<InvalidOperationException>(() => HtmlSource.Parse("<div>\n  <span></div>"));
        Assert.Contains("line 2 col 9", error.Message); Assert.Contains("<span>", error.Message);
        Assert.Contains("duplicate attribute", Assert.Throws<InvalidOperationException>(() => HtmlSource.Parse("<div class=a class=b></div>")).Message);
        var style = HtmlSource.Parse("<style>a>b{c:d}</style>").Elements.Single();
        Assert.Equal("a>b{c:d}", style.Children.Single().Text);
    }

    [Fact] public void CssParserKeepsStringsNestedMediaClassNamesAndScopesRules()
    {
        var sheet = CssStylesheet.Parse("""
            @import url("x.css");
            .metric, .panel > .title { background: url("a;b}c.png"); margin: 0 !important }
            @media (max-width: 760px) { .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)) } }
            .field>label[data-x=".no"] { color: red }
            """);
        Assert.Single(sheet.Statements);
        Assert.Equal(3, sheet.Rules.Count);
        var first = sheet.Rules[0];
        Assert.Equal(".metric, .panel > .title", first.Selector);
        Assert.Equal("url(\"a;b}c.png\")", first.Declarations[0].Value);
        Assert.True(first.Declarations[1].Important); Assert.Equal("0", first.Declarations[1].Value);
        Assert.Equal("@media (max-width: 760px)", sheet.Rules[1].AtRule);
        Assert.Equal("repeat(2, minmax(0, 1fr))", sheet.Rules[1].Declarations[0].Value);
        Assert.Equal(new[] { "metric", "panel", "title", "metrics", "field" }, sheet.ClassNames());
        Assert.Contains("line 1", Assert.Throws<InvalidOperationException>(() => CssStylesheet.Parse(".a { color: red")).Message);
        Assert.Contains("expected ':'", Assert.Throws<InvalidOperationException>(() => CssStylesheet.Parse(".a { color red }")).Message);
        var scoped = CssStylesheet.Parse(":root{--a:1} body{margin:0} *{box-sizing:border-box} .x, .y>b{c:d} @media (max-width:5px){.z{e:f}}").Scoped(".av-p");
        Assert.Equal(".av-p { --a: 1; }\n.av-p { margin: 0; }\n.av-p * { box-sizing: border-box; }\n.av-p .x, .av-p .y>b { c: d; }\n@media (max-width:5px) {\n  .av-p .z { e: f; }\n}", scoped);
        Assert.Equal(new[] { "a", "b[x=\"1,2\"]", "c(1,2)" }, CssStylesheet.SplitSelectors("a, b[x=\"1,2\"], c(1,2)").ToArray());
    }
}
