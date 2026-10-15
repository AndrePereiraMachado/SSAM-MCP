using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// data.bind (docs/PROTOTIPO-NATIVO.md 2.12) without a Studio: the producer surface as a record (the shape of FolhaPonto_CS), the
/// binder's checks and rewrite, the deterministic proposal and the example outputs the read-back renders.
/// </summary>
public class PrototypeBindTests
{
    /// <summary>The surface of FolhaPonto_CS (2026-10-12) that the bindings read.</summary>
    internal static PrototypeProducer FolhaPontoCs()
    {
        var p = new PrototypeProducer { Name = "FolhaPonto_CS" };
        p.Actions["ObterResumoHoje"] = new("ObterResumoHoje", [], [new("Resumo", "ResumoDiaDTO", false)]);
        p.Actions["RegistrarBatida"] = new("RegistrarBatida", [new("RequestId", "Text", true)], [new("Batida", "BatidaPonto", false), new("Resumo", "ResumoDiaDTO", false), new("IsRepetida", "Boolean", false)]);
        p.Actions["ObterEspelhoMensal"] = new("ObterEspelhoMensal", [new("Ano", "Integer", true), new("Mes", "Integer", true)], [new("Espelho", "EspelhoMensalDTO", false)]);
        p.Actions["ObterDetalheDia"] = new("ObterDetalheDia", [new("Data", "Date", true)], [new("Dia", "DiaEspelhoDTO", false), new("ReferenciaUtc", "Date Time", false)]);
        p.Actions["GerarEspelhoPDF"] = new("GerarEspelhoPDF", [new("Ano", "Integer", true), new("Mes", "Integer", true)], [new("Arquivo", "Binary Data", false), new("NomeArquivo", "Text", false), new("MimeType", "Text", false)]);
        p.Types["ResumoDiaDTO"] = [new("NomeColaborador", "Text", false), new("ReferenciaUtc", "Date Time", false), new("OffsetMinutos", "Integer", false), new("Dia", "DiaEspelhoDTO", false)];
        p.Types["DiaEspelhoDTO"] = [new("Data", "Date", false), new("IsHoje", "Boolean", false), new("IsEmIntervalo", "Boolean", false), new("IsTrabalhando", "Boolean", false), new("IsEncerrado", "Boolean", false),
            new("HasProximaBatida", "Boolean", false), new("MinutosPrevistos", "Integer", false), new("SegundosTrabalhados", "Integer", false), new("MinutosTrabalhados", "Integer", false), new("SaldoMinutos", "Integer", false),
            new("ProximaTipoBatidaId", "TipoBatida Identifier", false), new("ProximoHorarioPrevisto", "Time", false), new("Etapas", "EtapaPontoDTO List", false), new("Batidas", "BatidaPonto List", false)];
        p.Types["EtapaPontoDTO"] = [new("TipoBatidaId", "TipoBatida Identifier", false), new("Ordem", "Integer", false), new("HorarioPrevisto", "Time", false), new("IsRegistrada", "Boolean", false),
            new("BatidaId", "BatidaPonto Identifier", false), new("DataHoraUtc", "Date Time", false), new("OffsetMinutos", "Integer", false)];
        p.Types["EspelhoMensalDTO"] = [new("Ano", "Integer", false), new("Mes", "Integer", false), new("NomeColaborador", "Text", false), new("MinutosPrevistosMes", "Integer", false), new("MinutosTrabalhados", "Integer", false),
            new("SaldoMinutos", "Integer", false), new("DiasPendentes", "Integer", false), new("Dias", "DiaEspelhoDTO List", false)];
        p.Types["BatidaPonto"] = [new("Id", "Long Integer", true), new("TipoBatidaId", "TipoBatida Identifier", true), new("DataHoraUtc", "Date Time", true), new("RequestId", "Text", true)];
        p.Types["TipoBatida"] = [new("Id", "Integer", true), new("Label", "Text", false), new("Order", "Integer", false)];
        p.Statics["TipoBatida"] = [new("Entrada", "1", "Entrada", 1), new("SaidaIntervalo", "2", "Saída para almoço", 2), new("RetornoIntervalo", "3", "Retorno do almoço", 3), new("Saida", "4", "Saída", 4)];
        return p;
    }

    private static JsonObject Text(string k, string x, JsonObject? expr = null) { var t = new JsonObject { ["k"] = k, ["x"] = x }; if (expr != null) t["expr"] = expr; return t; }
    private static JsonObject El(string k, string tag, params JsonNode[] children) => new() { ["k"] = k, ["t"] = tag, ["c"] = new JsonArray(children) };
    private static JsonObject Styled(JsonObject el, string style) { el["a"] = new JsonArray(new JsonArray("style", style)); return el; }
    private static JsonObject Field(string f) => new() { ["fmt"] = "text", ["value"] = new JsonObject { ["field"] = f } };

    private static readonly string[] Labels = ["Entrada", "Saída almoço", "Retorno", "Saída"];
    private static readonly string[] Times = ["08:58", "12:00", "13:00", "18:00"];

    /// <summary>The Bater view of FolhaPonto as the capture holds it (the rows of window.SCHEDULE as the store's Data), with its
    /// canonical rendering.</summary>
    internal static JsonObject BaterCapture()
    {
        JsonObject Row(string k, string label, string time, bool done, bool last = false) => Styled(El(k, "div",
            Styled(El(k + "/0", "div"), done ? "background: green;" : "background: transparent;"),
            El(k + "/1", "div", Text(k + "/1/0", label, k.EndsWith("*") ? Field("Label") : null)),
            El(k + "/2", "div", Text(k + "/2/0", time, k.EndsWith("*") ? Field("Div") : null))), last ? "padding: 12px; border: 0;" : "padding: 12px;");
        JsonObject View(bool template)
        {
            var list = El("v:bater/2", "div");
            if (template) list["list"] = new JsonObject { ["collection"] = "Data", ["mode"] = "self", ["items"] = 4, ["template"] = Row("v:bater/2/*", "Entrada", "08:58", true) };
            else list["c"] = new JsonArray(Enumerable.Range(0, 4).Select(i => (JsonNode)Row("v:bater/2/" + i, Labels[i], Times[i], i == 0, i == 3)).ToArray());
            var cta = El("v:bater/1", "div", El("v:bater/1/0", "button", El("v:bater/1/0/0", "div", Text("v:bater/1/0/0/0", "Bater ponto")),
                El("v:bater/1/0/1", "div", Text("v:bater/1/0/1/0", "Saída almoço")), El("v:bater/1/0/2", "div", Text("v:bater/1/0/2/0", "previsto 12:00"))));
            if (template) cta["c"]![0]!["events"] = new JsonArray("bater:click:cta");
            var tabs = El("v:bater/3", "div", El("v:bater/3/0", "button", Text("v:bater/3/0/0", "Bater")), El("v:bater/3/1", "button", Text("v:bater/3/1/0", "Espelho")));
            if (template) tabs["c"]![1]!["events"] = new JsonArray("bater:click:espelho");
            var hero = El("v:bater/4", "div", El("v:bater/4/0", "div", Text("v:bater/4/0/0", "Trabalhando há")), El("v:bater/4/1", "div", Text("v:bater/4/1/0", "02:49")));
            return El("v:bater", "div", El("v:bater/0", "div", Text("v:bater/0/0", "Carla")), cta, list, tabs, hero);
        }
        var rows = new JsonArray(Enumerable.Range(0, 4).Select(i => (JsonNode)new JsonObject { ["Id"] = new[] { "in", "lunch", "back", "out" }[i], ["Label"] = Labels[i], ["Plan"] = new[] { 540, 720, 780, 1080 }[i], ["Div"] = Times[i] }).ToArray());
        return new JsonObject
        {
            ["schema"] = "ssam-prototype-capture/1", ["clock"] = "2026-05-07T11:47:00Z", ["app"] = new JsonObject { ["prefix"] = "FolhaDePonto", ["lang"] = "pt-BR" },
            ["views"] = new JsonArray(new JsonObject { ["key"] = "bater", ["name"] = "Bater", ["default"] = true, ["root"] = View(true) }),
            ["modals"] = new JsonArray(),
            ["store"] = new JsonObject { ["collections"] = new JsonArray(new JsonObject { ["name"] = "Data", ["key"] = "Id", ["mutated"] = false,
                ["fields"] = new JsonArray(new JsonObject { ["name"] = "Id", ["type"] = "Text" }, new JsonObject { ["name"] = "Label", ["type"] = "Text" }, new JsonObject { ["name"] = "Plan", ["type"] = "Integer" }, new JsonObject { ["name"] = "Div", ["type"] = "Text" }),
                ["rows"] = rows }) },
            ["events"] = new JsonArray(
                new JsonObject { ["key"] = "bater:click:cta", ["view"] = "bater", ["on"] = "click", ["effects"] = new JsonArray(), ["params"] = new JsonArray() },
                new JsonObject { ["key"] = "bater:click:espelho", ["view"] = "bater", ["on"] = "click", ["effects"] = new JsonArray(), ["params"] = new JsonArray() }),
            ["explored"] = new JsonArray(new JsonObject { ["id"] = "v:bater@canonical", ["view"] = "bater", ["tree"] = "t" }),
            ["trees"] = new JsonObject { ["t"] = View(false) },
        };
    }

    private static PrototypeCapture Capture(JsonObject json)
    {
        var dir = Path.Combine(Path.GetTempPath(), "ssam-bind-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var file = Path.Combine(dir, "capture.json");
        File.WriteAllText(file, json.ToJsonString());
        var problems = new List<PrototypeCapture.Problem>();
        var capture = PrototypeCapture.Load(new JsonObject { ["source"] = dir, ["capture"] = file }, problems);
        Assert.NotNull(capture);
        return capture!;
    }

    [Fact]
    public void TheShapeOfBindIsClosedAtEveryLevel()
    {
        var problems = PrototypeBind.Shape(new JsonObject
        {
            ["bind"] = new JsonObject
            {
                ["producer"] = "FolhaPonto_CS", ["screnes"] = new JsonObject(),
                ["screens"] = new JsonObject { ["bater"] = new JsonObject { ["source"] = new JsonObject { ["action"] = "ObterResumoHoje", ["argz"] = new JsonObject() } } },
                ["events"] = new JsonObject { ["x"] = new JsonObject { ["call"] = "RegistrarBatida", ["then"] = new JsonArray("refresh Resumo", "toast now") } },
                ["slots"] = new JsonObject { ["v:bater/0/0"] = 3 },
            },
        });
        Assert.Contains(problems, p => p.Pointer == "/bind/screnes" && p.Message.Contains("closest: screens"));
        Assert.Contains(problems, p => p.Pointer == "/bind/screens/bater/source/argz" && p.Message.Contains("closest: args"));
        Assert.Contains(problems, p => p.Pointer == "/bind/events/x/then/1");
        Assert.Contains(problems, p => p.Pointer == "/bind/slots/v:bater~10~10");
        Assert.All(problems, p => Assert.Equal("INPUT_INVALID", p.Code));
    }

    [Fact]
    public void NamesAreCheckedAgainstTheProducerWithTheClosestOnes()
    {
        var capture = Capture(BaterCapture());
        var bind = new JsonObject
        {
            ["producer"] = "FolhaPonto_CS",
            ["screens"] = new JsonObject { ["bater"] = new JsonObject { ["source"] = new JsonObject { ["action"] = "ObterResumoHj" } } },
            ["events"] = new JsonObject { ["bater:click:cta"] = new JsonObject { ["call"] = "RegistrarBatida" } },
        };
        var result = PrototypeBind.Apply(capture, bind, FolhaPontoCs(), null);
        var action = Assert.Single(result.Problems, p => p.Pointer == "/bind/screens/bater/source/action");
        Assert.Contains("closest: ObterResumoHoje", action.Message);
        Assert.Equal("ObterResumoHoje", action.Patch![0]!["value"]!.ToString());
        var input = Assert.Single(result.Problems, p => p.Pointer == "/bind/events/bater:click:cta/args/RequestId");
        Assert.Equal(PrototypeBind.RequestKey, input.Patch![0]!["value"]!.ToString());
    }

    [Fact]
    public void ABoundListIteratesTheOutputListAndItsCollectionLeavesTheStore()
    {
        var capture = Capture(BaterCapture());
        var bind = new JsonObject
        {
            ["producer"] = "FolhaPonto_CS",
            ["screens"] = new JsonObject { ["bater"] = new JsonObject { ["source"] = new JsonObject { ["action"] = "ObterResumoHoje", ["as"] = "Resumo" } } },
            // the shorthand of a single-output data action: Resumo.Dia.Etapas is Resumo.Resumo.Dia.Etapas
            ["lists"] = new JsonObject { ["v:bater/2"] = "Resumo.Dia.Etapas" },
            ["slots"] = new JsonObject { ["v:bater/2/*/1/0"] = "IntegerToText(Resumo.Dia.Etapas.Current.Ordem)", ["v:bater/2/*/2/0"] = "FormatDateTime(Resumo.Dia.Etapas.Current.HorarioPrevisto, \"HH:mm\")" },
            ["events"] = new JsonObject { ["bater:click:cta"] = new JsonObject { ["call"] = "RegistrarBatida", ["args"] = new JsonObject { ["RequestId"] = PrototypeBind.RequestKey }, ["then"] = new JsonArray("refresh Resumo", "message Ponto registrado") }, ["bater:click:espelho"] = null },
        };
        var result = PrototypeBind.Apply(capture, bind, FolhaPontoCs(), null);
        Assert.Empty(result.Problems);
        Assert.Empty(result.Unbound);
        var list = PrototypeBind.FindNode(result.Json, "v:bater/2")!["list"]!;
        Assert.Equal("Resumo.Resumo.Dia.Etapas", list["source"]!.ToString());
        Assert.Null(list["collection"]);
        Assert.DoesNotContain(PrototypeCapture.Objects(result.Json["store"]!["collections"]), c => c["name"]?.ToString() == "Data");
        Assert.Contains("Data", result.Plan.BoundCollections);
        Assert.Equal("IntegerToText(Resumo.Resumo.Dia.Etapas.Current.Ordem)", PrototypeBind.FindNode(result.Json, "v:bater/2/*/1/0")!["expr"]!["value"]!["os"]!.ToString());
        var cta = PrototypeCapture.Objects(result.Json["events"]).Single(e => e["key"]!.ToString() == "bater:click:cta");
        Assert.Equal("call", cta["effects"]![0]!["kind"]!.ToString());
        Assert.Equal(new[] { "IServerAction:ObterResumoHoje", "IServerAction:RegistrarBatida" }, result.Plan.Elements);
        var source = Assert.Single(result.Plan.Sources);
        Assert.Equal(("v:bater", "Resumo", "ObterResumoHoje"), (source.Owner, source.As, source.Action));
    }

    [Fact]
    public void WithOnlyItsProducerTheBindingIsProposedFromTheCapturedValues()
    {
        var capture = Capture(BaterCapture());
        var bind = new JsonObject { ["producer"] = "FolhaPonto_CS" };
        var producer = FolhaPontoCs();
        var applied = PrototypeBind.Apply(capture, bind, producer, null);
        Assert.Contains(applied.Unbound, u => u.Kind == "list" && u.Key == "v:bater/2");
        Assert.Contains(applied.Unbound, u => u.Kind == "event" && u.Key == "bater:click:cta" && u.View == "v:bater");
        var proposal = PrototypeBindDiscovery.Propose(capture, bind, producer, applied);
        string? Value(string section, string key) => proposal.Items.FirstOrDefault(i => i.Section == section && i.Key == key && !i.Unresolved)?.Value?.ToJsonString();
        string? Text(string section, string key) => proposal.Items.FirstOrDefault(i => i.Section == section && i.Key == key && !i.Unresolved)?.Value?.ToString();
        Assert.Equal("{\"source\":{\"action\":\"ObterResumoHoje\"}}", Value("screens", "bater"));
        Assert.Equal("\"ObterResumoHoje.Resumo.Dia.Etapas\"", Value("lists", "v:bater/2"));
        // the prototype's labels are the records of TipoBatida, each with its own text
        var label = proposal.Bind["slots"]!["v:bater/2/*/1/0"]!.ToString();
        Assert.Contains("= Entities.TipoBatida.SaidaIntervalo, \"Saída almoço\"", label);
        Assert.Contains("= Entities.TipoBatida.RetornoIntervalo, \"Retorno\"", label);
        Assert.Equal("FormatDateTime(ObterResumoHoje.Resumo.Dia.Etapas.Current.HorarioPrevisto, \"HH:mm\")", proposal.Bind["slots"]!["v:bater/2/*/2/0"]!.ToString());
        // the row variant: the only Boolean of the row
        Assert.StartsWith("If(ObterResumoHoje.Resumo.Dia.Etapas.Current.IsRegistrada, \"background: green;\"", proposal.Bind["slots"]!["v:bater/2/*/0@style"]!.ToString());
        // the last row alone: its position
        Assert.Equal("If(ObterResumoHoje.Resumo.Dia.Etapas.CurrentRowNumber = ObterResumoHoje.Resumo.Dia.Etapas.Length - 1, \"padding: 12px; border: 0;\", \"padding: 12px;\")", proposal.Bind["slots"]!["v:bater/2/*@style"]!.ToString());
        // texts outside lists: the name, the next punch, the time beside "previsto", the duration beside "Trabalhando"
        Assert.Equal("ObterResumoHoje.Resumo.NomeColaborador", proposal.Bind["slots"]!["v:bater/0/0"]!.ToString());
        Assert.StartsWith("If(ObterResumoHoje.Resumo.Dia.ProximaTipoBatidaId = Entities.TipoBatida.Entrada", proposal.Bind["slots"]!["v:bater/1/0/1/0"]!.ToString());
        Assert.Equal("\"previsto \" + FormatDateTime(ObterResumoHoje.Resumo.Dia.ProximoHorarioPrevisto, \"HH:mm\")", proposal.Bind["slots"]!["v:bater/1/0/2/0"]!.ToString());
        Assert.Contains("ObterResumoHoje.Resumo.Dia.SegundosTrabalhados", proposal.Bind["slots"]!["v:bater/4/1/0"]!.ToString());
        // the CTA writes; the tab names a view the capture does not have
        Assert.Equal("{\"call\":\"RegistrarBatida\",\"args\":{\"RequestId\":" + System.Text.Json.JsonSerializer.Serialize(PrototypeBind.RequestKey) + "},\"then\":[\"refresh ObterResumoHoje\"]}", Value("events", "bater:click:cta"));
        Assert.Contains(proposal.Items, i => i.Key == "bater:click:espelho" && i.Unresolved && i.Why.Contains("no view \"Espelho\""));
    }

    private static string FolhaPontoFixture => Path.Combine(PrototypeFakes.Fixtures, "folhaponto-bind.capture.json");

    /// <summary>The proposal over the fixture of V1 (both views and the DaySheet popup, as the JSX capture delivers them), with every
    /// unresolved item kept as the prototype's (null), applied: the binding the call would carry after the refusal.</summary>
    private static (PrototypeCapture Capture, PrototypeBindDiscovery.Proposal Proposal, PrototypeBind.Result Bound) FolhaPontoBound()
    {
        var capture = PrototypeFakes.Load(FolhaPontoFixture);
        var producer = FolhaPontoCs();
        var only = new JsonObject { ["producer"] = "FolhaPonto_CS" };
        var proposal = PrototypeBindDiscovery.Propose(capture, only, producer, PrototypeBind.Apply(capture, only, producer, null));
        var bind = proposal.Bind.DeepClone().AsObject();
        foreach (var item in proposal.Items.Where(i => i.Unresolved && i.Kind != "source"))
        {
            if (bind[item.Section] is not JsonObject section) bind[item.Section] = section = new JsonObject();
            section[item.Key] = null;
        }
        return (capture, proposal, PrototypeBind.Apply(capture, bind, producer, "C:\\fixture\\FolhaPonto_CS.oml"));
    }

    [Fact]
    public void TheFolhaPontoProposalBindsBothViewsThePopupThePdfAndTheTabs()
    {
        var (_, proposal, bound) = FolhaPontoBound();
        string? Value(string section, string key) => proposal.Items.FirstOrDefault(i => i.Section == section && i.Key == key && !i.Unresolved)?.Value?.ToJsonString();
        string? Text(string section, string key) => proposal.Items.FirstOrDefault(i => i.Section == section && i.Key == key && !i.Unresolved)?.Value?.ToString();
        Assert.Equal("{\"source\":{\"action\":\"ObterResumoHoje\"}}", Value("screens", "bater"));
        Assert.Equal("{\"source\":{\"action\":\"ObterEspelhoMensal\",\"args\":{\"Ano\":\"Year(CurrDate())\",\"Mes\":\"Month(CurrDate())\"}}}", Value("screens", "espelho"));
        Assert.Equal("{\"source\":{\"action\":\"ObterDetalheDia\",\"args\":{\"Data\":\"NewDate(Year(CurrDate()), Month(CurrDate()), Dia)\"}}}", Value("modals", "day-sheet"));
        Assert.Equal("ObterEspelhoMensal.Espelho.Dias", Text("lists", "v:espelho/3"));
        Assert.Equal("IntegerToText(Day(ObterEspelhoMensal.Espelho.Dias.Current.Data))", Text("slots", "v:espelho/3/*/0/0"));
        Assert.Equal("ObterDetalheDia.Dia.Etapas", Text("lists", "m:day-sheet/0/1"));
        Assert.Contains("ObterEspelhoMensal.Espelho.MinutosTrabalhados", Text("slots", "v:espelho/1/0/1/0"));
        Assert.StartsWith("If(ObterEspelhoMensal.Espelho.SaldoMinutos < 0, \"-\", \"+\")", Text("slots", "v:espelho/1/1/1/0"));
        // the view's title is the interface's own word, never a name
        Assert.Null(Text("slots", "v:espelho/0/0/0"));
        // "de 176:00" would read the hours worked again: one leaf explains one text, so it stays the prototype's
        Assert.Null(Text("slots", "v:espelho/1/0/2/0"));
        Assert.Equal("{\"call\":\"GerarEspelhoPDF\",\"args\":{\"Ano\":\"Year(CurrDate())\",\"Mes\":\"Month(CurrDate())\"},\"then\":[\"download\"]}", Value("events", "espelho:click:pdf"));
        Assert.Equal("{\"navigate\":\"espelho\"}", Value("events", "bater:click:tab-espelho"));
        Assert.Equal("{\"navigate\":\"bater\"}", Value("events", "espelho:click:tab-bater"));
        Assert.StartsWith("{\"call\":\"RegistrarBatida\"", Value("events", "bater:click:cta"));
        Assert.Empty(bound.Problems);
        Assert.Empty(bound.Unbound);
        // a bound collection gets no entity, no seed and no snapshot entity
        Assert.Empty(PrototypeCapture.Objects(bound.Json["store"]!["collections"]));
        Assert.Equal(["Batidas", "Dias", "Etapas"], bound.Plan.BoundCollections.Order(StringComparer.Ordinal));
    }

    [Fact]
    public void TheFolhaPontoBindingCompilesDataActionsCallsTheDownloadAndThePopupRefresh()
    {
        if (!PrototypeFakes.Studio()) return;
        Compile();
    }

    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static void Compile()
    {
        var (capture, _, bound) = FolhaPontoBound();
        var samples = PrototypeBindSamples.Build(bound.Json, bound.Plan, FolhaPontoCs(), "2026-05-07T11:47:00Z");
        foreach (var (owner, value) in samples.Samples) bound.Plan.Samples[owner] = value?.DeepClone();
        var plan = PrototypeExpander.Plan(capture.Rebound(bound.Json, bound.Plan), PrototypeModule.Empty("o11", "FolhaPonto_UI"), PrototypeFakes.Seams);
        Assert.Empty(plan.Problems);
        var ops = PrototypeFakes.Ops(plan).ToList();
        // the producer referenced first (an .oml binding), then no entity of the prototype's collections
        var reference = plan.Steps[0].Ops!.Single();
        Assert.Equal("reference", reference["op"]!.ToString());
        Assert.Equal(["IServerAction:GerarEspelhoPDF", "IServerAction:ObterDetalheDia", "IServerAction:ObterEspelhoMensal", "IServerAction:ObterResumoHoje", "IServerAction:RegistrarBatida", "IStaticEntity:TipoBatida"],
            reference["elements"]!.AsArray().Select(e => e!.ToString()).Order(StringComparer.Ordinal));
        Assert.DoesNotContain(ops, o => o["op"]?.ToString() == "create" && o["type"]?.ToString() is "IStaticEntity" or "IServerEntity");
        // one Data Action per source, as HtmlExpander.ActionSource builds it; the popup's is fetched on demand
        var dataActions = ops.Where(o => o["op"]?.ToString() == "create" && o["type"]?.ToString() == "IDataAction").ToDictionary(o => o["name"]!.ToString(), o => o["as"]!.ToString());
        Assert.Equal(["ObterDetalheDia", "ObterEspelhoMensal", "ObterResumoHoje"], dataActions.Keys.Order(StringComparer.Ordinal));
        string Set(string target, string prop) => ops.Last(o => o["op"]?.ToString() == "set" && o["target"]?.ToString() == target && o["prop"]?.ToString() == prop)["value"]!.ToString();
        Assert.Equal("OnDemand", Set(dataActions["ObterDetalheDia"], "Fetch"));
        Assert.Equal("Year(CurrDate())", Set(dataActions["ObterEspelhoMensal"] + ".call/Ano", "Value"));
        Assert.Equal("NewDate(Year(CurrDate()), Month(CurrDate()), DaySheetDia)", Set(dataActions["ObterDetalheDia"] + ".call/Data", "Value"));
        Assert.Equal("IServerAction:ObterResumoHoje", Set(dataActions["ObterResumoHoje"] + ".call", "Action"));
        // the punch: the producer's action, the view's source again; the PDF: the action and its download
        var actions = PrototypeFakes.Actions(plan, "screen").ToList();
        var punch = actions.Single(a => PrototypeFakes.AllSteps(a).Any(s => s["call"]?.ToString() == "IServerAction:RegistrarBatida"));
        Assert.Contains(PrototypeFakes.AllSteps(punch), s => s["node"]?.ToString() == "IRefreshDataNode" && s["properties"]!["DataSource"]!.ToString() == dataActions["ObterResumoHoje"]);
        var pdf = actions.Single(a => PrototypeFakes.AllSteps(a).Any(s => s["call"]?.ToString() == "IServerAction:GerarEspelhoPDF"));
        var download = PrototypeFakes.AllSteps(pdf).Single(s => s["node"]?.ToString() == "IDownloadNode")["properties"]!;
        Assert.Equal(("GerarEspelhoPDF.Arquivo", "GerarEspelhoPDF.NomeArquivo", "GerarEspelhoPDF.MimeType"), (download["FileContent"]!.ToString(), download["FileName"]!.ToString(), download["MimeType"]!.ToString()));
        // the day opens the popup and fetches its source with the day just assigned
        var open = actions.Single(a => PrototypeFakes.AllSteps(a).Any(s => s["assign"]?["DaySheetIsOpen"]?.ToString() == "True"));
        var steps = PrototypeFakes.AllSteps(open).ToList();
        Assert.True(steps.FindIndex(s => s["assign"]?["DaySheetIsOpen"]?.ToString() == "True") < steps.FindIndex(s => s["node"]?.ToString() == "IRefreshDataNode" && s["properties"]!["DataSource"]!.ToString() == dataActions["ObterDetalheDia"]));
        // the lists iterate the outputs; the tabs navigate between the two screens without an action
        var widgets = PrototypeFakes.Widgets(plan).ToList();
        Assert.Contains(widgets, w => w.Node.W == "IList" && PrototypeFakes.Prop(w.Spec, "Source") == "ObterEspelhoMensal.Espelho.Dias");
        Assert.Contains(widgets, w => w.Node.W == "IList" && PrototypeFakes.Prop(w.Spec, "Source") == "ObterResumoHoje.Resumo.Dia.Etapas");
        Assert.Contains(widgets, w => w.Spec.Handler is { Screen: "Espelho", Action: null } && w.Owner == "Bater");
        Assert.Equal(1, plan.Report["events"]!["byEffect"]!["call"]!.GetValue<int>() >= 1 ? 1 : 0);
    }

    [Fact]
    public void TheExampleOutputsRenderEveryCapturedValueOfTheBoundExpressions()
    {
        var capture = Capture(BaterCapture());
        var producer = FolhaPontoCs();
        var proposal = PrototypeBindDiscovery.Propose(capture, new JsonObject { ["producer"] = "FolhaPonto_CS" }, producer, PrototypeBind.Apply(capture, new JsonObject { ["producer"] = "FolhaPonto_CS" }, producer, null));
        var bind = proposal.Bind;
        foreach (var item in proposal.Items.Where(i => i.Unresolved)) if (item.Section == "events") ((JsonObject)bind["events"]!)[item.Key] = null;
        var bound = PrototypeBind.Apply(capture, bind, producer, null);
        Assert.Empty(bound.Problems);
        Assert.Empty(bound.Unbound);
        var samples = PrototypeBindSamples.Build(bound.Json, bound.Plan, producer, "2026-05-07T11:47:00Z");
        Assert.Empty(samples.Unexplained);
        var etapas = samples.Samples["v:bater"]!["ObterResumoHoje"]!["Resumo"]!["Dia"]!["Etapas"]!.AsArray();
        Assert.Equal(4, etapas.Count);
        Assert.Equal(new long[] { 1, 2, 3, 4 }, etapas.Select(e => e!["TipoBatidaId"]!.GetValue<long>()));
        Assert.Equal(new[] { true, false, false, false }, etapas.Select(e => e!["IsRegistrada"]!.GetValue<bool>()));
        Assert.Equal("08:58:00", etapas[0]!["HorarioPrevisto"]!.ToString());
        Assert.Equal("Carla", samples.Samples["v:bater"]!["ObterResumoHoje"]!["Resumo"]!["NomeColaborador"]!.ToString());
        Assert.Equal(2, samples.Samples["v:bater"]!["ObterResumoHoje"]!["Resumo"]!["Dia"]!["ProximaTipoBatidaId"]!.GetValue<long>());
        Assert.Equal(10140, samples.Samples["v:bater"]!["ObterResumoHoje"]!["Resumo"]!["Dia"]!["SegundosTrabalhados"]!.GetValue<long>());
    }

    [Fact]
    public void TheReadBackOfAViewUsesItsOwnSamplesOverAPopupsOfTheSameName()
    {
        // the real FolhaPonto capture (zip, V1): Bater's ObterResumoHoje and the DaySheet's (hosted on Espelho) share the name
        var samples = new JsonObject
        {
            ["v:bater"] = new JsonObject { ["ObterResumoHoje"] = new JsonObject { ["Resumo"] = new JsonObject { ["NomeColaborador"] = "Carla" } } },
            ["m:day-sheet"] = new JsonObject { ["ObterResumoHoje"] = new JsonObject { ["Resumo"] = new JsonObject { ["NomeColaborador"] = "" } }, ["ObterDetalheDia"] = new JsonObject() },
            ["@entities"] = new JsonObject(),
        };
        var owners = PrototypeRender.StateSampleOwners(samples, "bater");
        Assert.Equal(["m:day-sheet", "v:bater"], owners);
        var vars = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach (var (name, value) in PrototypeRender.SampleVars(samples, owners)) vars[name] = value;
        var resumo = (PrototypeRender.RecordValue)((PrototypeRender.RecordValue)vars["ObterResumoHoje"]!).Fields["Resumo"]!;
        Assert.Equal("Carla", resumo.Fields["NomeColaborador"]);
        // a popup's own Data Action stays in the scope (the popup is rendered over its host's state)
        Assert.True(vars.ContainsKey("ObterDetalheDia"));
    }
}
