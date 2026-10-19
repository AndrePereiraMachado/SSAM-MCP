using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Preflight;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// lentidao 2026-10-12 (causes 2 and 3 of the owner's production test, FolhaPonto): the deterministic shape errors of one batch
/// of seven actions were 19 problems of one refusal, every one of them with a single reading. The engine now rewrites them in
/// place and lists each in <c>normalizations</c> ({rule, path, from, to, message}): a comma-separated sort, `NullDateTime()` and
/// `NullTime()` (the null of the target type), the entity segment of a list of records (`V.Current.T.X`, `V[i].T.X`) and a
/// documentation property the type cannot write (IUserException.Description, dropped with a warning). What is ambiguous stays
/// a refusal with its fix. Synthetic names; the owner's jobs are replayed offline only.
/// </summary>
public sealed class JobNormalizerTests
{
    private static readonly string Root = PacoteBPolicyTests.FindRoot();

    public JobNormalizerTests() { try { StudioAssemblies.Bind(); } catch { /* no Studio: the checked-in catalogs answer */ } }

    private static string Dir()
    {
        var dir = Path.Combine(Root, ".local", "vel-motor-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static (JsonNode? Job, JsonObject Result) Analyze(string json)
    {
        var job = JsonNode.Parse(json)!;
        return (job, JobPreflight.Analyze(job["ops"]!.AsArray(), job, []));
    }

    private static JsonObject[] Problems(JsonObject result, string code)
        => result["problems"]!.AsArray().OfType<JsonObject>().Where(p => p["code"]!.GetValue<string>() == code).ToArray();

    private static JsonObject[] Normalizations(JsonNode? result, string? rule = null)
        => (result?["normalizations"] as JsonArray ?? new JsonArray()).OfType<JsonObject>()
            .Where(n => rule == null || n["rule"]!.GetValue<string>().Split('+').Contains(rule)).ToArray();

    private static (JsonNode? Result, Exception? Error, string Output) Run(string dir, string name, string job, string? output = null)
    {
        var path = Path.Combine(dir, name + ".json");
        File.WriteAllText(path, job);
        output ??= Path.Combine(dir, name + ".oml");
        try { return (JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), null, path, output)), null, output); }
        catch (Exception ex) { return (null, ex, output); }
    }

    private const string Spec = """{"entities":[{"name":"VmPonto","attributes":[{"name":"Quando","type":"Date Time"},{"name":"Dia","type":"Date"},{"name":"Ordem","type":"Integer"}]}]}""";

    private static string Logic(string actions, string? spec = Spec)
        => "{\"ops\":[" + (spec == null ? "" : "{\"op\":\"spec\",\"data\":" + spec + "},") + "{\"op\":\"logic\",\"data\":{\"actions\":[" + actions + "]}}]}";

    // ---- SORT_KEYS_SPLIT --------------------------------------------------------------------------------------------------

    [Fact]
    public void ACommaSeparatedSortIsTheListOfItsKeysWithEveryTieBreak()
    {
        var (job, result) = Analyze(Logic("""{"name":"VmListar","outputs":[{"name":"N","type":"Integer"}],"steps":[{"get":"VmPonto","as":"GetPontos","sort":"VmPonto.Dia, VmPonto.Quando DESC, VmPonto.Id","max":10},{"assign":{"N":"GetPontos.List.Length"}}]}"""));
        Assert.Empty(Problems(result, "EXPRESSION_SYNTAX"));
        var entry = Assert.Single(Normalizations(result, JobNormalizer.SortKeysSplit));
        Assert.Equal("/ops/1/data/actions/0/steps/0/sort", entry["path"]!.GetValue<string>());
        Assert.Equal("VmPonto.Dia, VmPonto.Quando DESC, VmPonto.Id", entry["from"]!.GetValue<string>());
        // The job's own sort is now the list the compiler reads, in order, the tie-break kept.
        var sort = job!["ops"]![1]!["data"]!["actions"]![0]!["steps"]![0]!["sort"]!.AsArray();
        Assert.Equal(new[] { "VmPonto.Dia", "VmPonto.Quando DESC", "VmPonto.Id" }, sort.Select(s => s!.GetValue<string>()));
        Assert.Equal(3, LogicExpander.SortKeys(sort).Count);
        // A key of a list written with commas is several keys too.
        var (listed, listResult) = Analyze(Logic("""{"name":"VmListar","outputs":[{"name":"N","type":"Integer"}],"steps":[{"get":"VmPonto","as":"GetPontos","sort":["VmPonto.Dia, VmPonto.Quando","-VmPonto.Id"],"max":10},{"assign":{"N":"GetPontos.List.Length"}}]}"""));
        Assert.Single(Normalizations(listResult, JobNormalizer.SortKeysSplit));
        Assert.Equal(new[] { "VmPonto.Dia", "VmPonto.Quando", "-VmPonto.Id" },
            listed!["ops"]![1]!["data"]!["actions"]![0]!["steps"]![0]!["sort"]!.AsArray().Select(s => s!.GetValue<string>()));
    }

    [Fact]
    public void ASortWithoutATopLevelCommaIsLeftAsWrittenAndAnEmptyKeyStaysARefusal()
    {
        // No comma, or commas only inside a call: nothing to split.
        Assert.Null(JobNormalizer.SplitKeys("VmPonto.Dia DESC"));
        Assert.Null(JobNormalizer.SplitKeys("Substr(VmPonto.Nome, 0, 3)"));
        Assert.Null(JobNormalizer.SplitKeys("\"a, b\""));
        Assert.Equal(new[] { "Substr(A.Nome, 0, 3)", "A.Id DESC" }, JobNormalizer.SplitKeys("Substr(A.Nome, 0, 3), A.Id DESC"));
        // Ambiguous: an empty key, a key that is no attribute expression, a direction before any key.
        Assert.Null(JobNormalizer.SplitKeys("A.Dia,, A.Id"));
        Assert.Null(JobNormalizer.SplitKeys("A.Dia, A.Id +"));
        Assert.Null(JobNormalizer.SplitKeys("DESC, A.Id"));
        var (job, result) = Analyze(Logic("""{"name":"VmListar","outputs":[{"name":"N","type":"Integer"}],"steps":[{"get":"VmPonto","as":"GetPontos","sort":"VmPonto.Dia,, VmPonto.Id","max":10},{"assign":{"N":"GetPontos.List.Length"}}]}"""));
        Assert.Single(Problems(result, "EXPRESSION_SYNTAX"));
        Assert.Empty(Normalizations(result));
        Assert.Equal("VmPonto.Dia,, VmPonto.Id", job!["ops"]![1]!["data"]!["actions"]![0]!["steps"]![0]!["sort"]!.GetValue<string>());
    }

    // ---- LIST_ENTITY_SEGMENT_DROPPED ----------------------------------------------------------------------------------------

    [Fact]
    public void TheEntitySegmentOfAListOfRecordsIsDroppedForCurrentAndForAnIndex()
    {
        var (job, result) = Analyze(Logic("""{"name":"VmUltimo","inputs":[{"name":"Pontos","type":"VmPonto List"}],"outputs":[{"name":"Quando","type":"Date Time"},{"name":"Dia","type":"Date"}],"steps":[{"if":"not Pontos.Empty","then":[{"assign":{"Quando":"Pontos.Current.VmPonto.Quando","Dia":"Pontos[Pontos.Length - 1].VmPonto.Dia"}}]}]}"""));
        Assert.Empty(Problems(result, "EXPR_UNKNOWN_IDENTIFIER"));
        var entries = Normalizations(result, JobNormalizer.ListEntitySegment);
        Assert.Equal(2, entries.Length);
        var assign = job!["ops"]![1]!["data"]!["actions"]![0]!["steps"]![0]!["then"]![0]!["assign"]!;
        Assert.Equal("Pontos.Current.Quando", assign["Quando"]!.GetValue<string>());
        Assert.Equal("Pontos[Pontos.Length - 1].Dia", assign["Dia"]!.GetValue<string>());
        Assert.Contains(entries, e => e["path"]!.GetValue<string>() == "/ops/1/data/actions/0/steps/0/then/0/assign/Dia" && e["from"]!.GetValue<string>() == "Pontos[Pontos.Length - 1].VmPonto.Dia");
    }

    [Fact]
    public void TheRowsOfAnAggregateKeepTheirSourceAndAnUncertainSegmentStaysARefusal()
    {
        // An aggregate's rows have one record per source: GetPontos.List.Current.VmPonto.Dia is right, never rewritten.
        var (job, rows) = Analyze(Logic("""{"name":"VmPrimeiro","outputs":[{"name":"Dia","type":"Date"},{"name":"Outro","type":"Date"}],"steps":[{"get":"VmPonto","as":"GetPontos","max":2},{"if":"GetPontos.List.Length > 1","then":[{"assign":{"Dia":"GetPontos.List.Current.VmPonto.Dia","Outro":"GetPontos.List[1].VmPonto.Dia"}}]}]}"""));
        Assert.Empty(Normalizations(rows));
        Assert.Equal("GetPontos.List[1].VmPonto.Dia", job!["ops"]![1]!["data"]!["actions"]![0]!["steps"]![1]!["then"]![0]!["assign"]!["Outro"]!.GetValue<string>());
        // The segment is the entity but what follows is no attribute of it: the patch is not certain, the refusal stays.
        var (_, unknown) = Analyze(Logic("""{"name":"VmUltimo","inputs":[{"name":"Pontos","type":"VmPonto List"}],"outputs":[{"name":"Dia","type":"Date"}],"steps":[{"if":"not Pontos.Empty","then":[{"assign":{"Dia":"Pontos.Current.VmPonto.Data"}}]}]}"""));
        Assert.Empty(Normalizations(unknown));
        Assert.Null(Assert.Single(Problems(unknown, "EXPR_UNKNOWN_IDENTIFIER"))["patch"]);
        // A record with an attribute named like the record: the segment may be that attribute, nothing is rewritten.
        var (_, named) = Analyze(Logic("""{"name":"VmItens","inputs":[{"name":"Itens","type":"VmItem List"}],"outputs":[{"name":"N","type":"Integer"}],"steps":[{"if":"not Itens.Empty","then":[{"assign":{"N":"Itens.Current.VmItem.Ordem"}}]}]}""",
            """{"entities":[{"name":"VmItem","attributes":[{"name":"VmItem","type":"Integer"},{"name":"Ordem","type":"Integer"}]}]}"""));
        Assert.Empty(Normalizations(named));
    }

    // ---- PROPERTY_SET_DROPPED (pure) ---------------------------------------------------------------------------------------

    [Fact]
    public void ADescriptionTheTypeCannotWriteIsDroppedWithAWarningAndATypoStaysARefusal()
    {
        var (_, result) = Analyze("""{"ops":[{"op":"create","parent":"@espace","type":"IUserException","name":"VmFalha","as":"$e"},{"op":"set","target":"$e","prop":"Description","value":"Explica a falha."}]}""");
        if (ModelTypes.Of("IUserException", "o11") == null) return;   // no Model API facts in this host
        Assert.True(result["valid"]!.GetValue<bool>(), result["errors"]!.ToJsonString());
        Assert.Empty(Problems(result, "PROPERTY_NOT_WRITABLE"));
        var warning = Assert.Single(result["warnings"]!.AsArray().OfType<JsonObject>(), w => w["code"]!.GetValue<string>() == JobNormalizer.PropertyDropped);
        Assert.Equal("/ops/1/prop", warning["pointer"]!.GetValue<string>());
        Assert.Null(warning["_normalization"]);
        var entry = Assert.Single(Normalizations(result, JobNormalizer.PropertyDropped));
        Assert.Equal("set Description on $e", entry["from"]!.GetValue<string>());
        // A name that is no documentation property (a typo of Name, a reference) is still refused with the closest ones.
        var (_, typo) = Analyze("""{"ops":[{"op":"create","parent":"@espace","type":"IUserException","name":"VmFalha","as":"$e"},{"op":"set","target":"$e","prop":"Nmae","value":"x"}]}""");
        Assert.Single(Problems(typo, "PROPERTY_NOT_WRITABLE"));
        Assert.Empty(Normalizations(typo));
    }

    // ---- with the base: NULL_FUNCTION_REWRITTEN, the segment of a module entity, the dropped set at apply -------------------

    private static string BuildBase(string dir)
    {
        var (built, error, output) = Run(dir, "base", """
        {"base":"blank-service.oml","ops":[{"op":"spec","data":{
          "entities":[{"name":"VmPonto","attributes":[{"name":"Quando","type":"Date Time"},{"name":"Dia","type":"Date"},{"name":"Ordem","type":"Integer"}]}],
          "structures":[{"name":"VmResumo","attributes":[{"name":"Hora","type":"Time"},{"name":"Dia","type":"Date"},{"name":"Inicio","type":"Date Time"}]}]}},
          {"op":"create","parent":"@espace","type":"IUserException","name":"VmFalha"}]}
        """, Path.Combine(dir, "work", "base.oml"));
        Assert.True(error == null, error?.ToString());
        Assert.True(built!["isValid"]!.GetValue<bool>());
        return output.Replace('\\', '/');
    }

    [Fact]
    public void TheNullOfTheTargetTypeAndTheModuleEntitySegmentAreRewrittenAndTheJobIsAcceptedInOnePass()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Dir();
        var basePath = BuildBase(dir);
        var (result, error, output) = Run(dir, "one-pass", $$$"""
        {"base":"{{{basePath}}}","ops":[
          {"op":"logic","data":{"actions":[
            {"name":"VmResumir","inputs":[{"name":"Pontos","type":"VmPonto List"}],
             "outputs":[{"name":"Resumo","type":"VmResumo"},{"name":"Ultimo","type":"Date Time"},{"name":"Primeiro","type":"Date"}],
             "vars":[{"name":"Hora","type":"Time"}],
             "steps":[
               {"assign":{"Resumo.Hora":"NullTime()","Resumo.Dia":"NullDateTime()","Ultimo":"NullDateTime()","Hora":"If(True, NullTime(), CurrTime())"}},
               {"get":"VmPonto","as":"GetPontos","sort":"VmPonto.Dia, VmPonto.Ordem DESC","max":10},
               {"if":"not Pontos.Empty and Ultimo = NullDateTime()","then":[
                 {"assign":{"Ultimo":"Pontos.Current.VmPonto.Quando","Primeiro":"Pontos[0].VmPonto.Dia","Resumo.Inicio":"GetPontos.List.Current.VmPonto.Quando"}}]}]}]}},
          {"op":"set","target":"IUserException:VmFalha","prop":"Description","value":"Interrompe o registro."}]}
        """);
        Assert.True(error == null, error?.ToString());
        Assert.True(result!["accepted"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString());
        Assert.True(File.Exists(output));
        string To(string path) => Assert.Single(Normalizations(result), n => n["path"]!.GetValue<string>() == path)["to"]!.GetValue<string>();
        const string at = "/ops/0/data/actions/0/steps";
        Assert.Equal("NewTime(0, 0, 0)", To(at + "/0/assign/Resumo.Hora"));
        Assert.Equal("NullDate()", To(at + "/0/assign/Resumo.Dia"));
        Assert.Equal("DateToDateTime(NullDate())", To(at + "/0/assign/Ultimo"));
        // NullTime() whose target type is unknown (inside an If) is the one null Time.
        Assert.Equal("If(True, NewTime(0, 0, 0), CurrTime())", To(at + "/0/assign/Hora"));
        Assert.Equal("not Pontos.Empty and Ultimo = DateToDateTime(NullDate())", To(at + "/2/if"));
        Assert.Equal("Pontos.Current.Quando", To(at + "/2/then/0/assign/Ultimo"));
        Assert.Equal("Pontos[0].Dia", To(at + "/2/then/0/assign/Primeiro"));
        Assert.Single(Normalizations(result, JobNormalizer.SortKeysSplit));
        // The aggregate's row keeps its source.
        Assert.DoesNotContain(Normalizations(result), n => n["path"]!.GetValue<string>().EndsWith("/assign/Resumo.Inicio", StringComparison.Ordinal));
        // The Description of the exception of the base: dropped by the apply, listed once, never refused.
        var dropped = Assert.Single(Normalizations(result, JobNormalizer.PropertyDropped));
        Assert.Equal("/ops/1/prop", dropped["path"]!.GetValue<string>());
        Assert.True(result["results"]![1]!["result"]!["dropped"]!.GetValue<bool>());
    }

    [Fact]
    public void ANullWhoseTargetTypeIsAmbiguousStaysARefusalAndTheRefusalCarriesTheNormalizations()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Dir();
        var basePath = BuildBase(dir);
        var (_, error, output) = Run(dir, "ambiguous", $$$"""
        {"base":"{{{basePath}}}","autoPatch":false,"ops":[
          {"op":"logic","data":{"actions":[
            {"name":"VmTexto","outputs":[{"name":"Texto","type":"Text"},{"name":"Quando","type":"Date Time"}],"steps":[
              {"assign":{"Texto":"NullDateTime()","Quando":"If(True, NullDateTime(), CurrDateTime())"}},
              {"get":"VmPonto","as":"GetPontos","sort":"VmPonto.Dia, VmPonto.Ordem","max":1}]}]}}]}
        """);
        var refused = Assert.IsType<JobPreflightException>(Errors.FindCoded(error!));
        // A Text target has no null date, an If hides the type: both stay FUNCTION_UNKNOWN, with the certain rename as before.
        var unknown = Assert.Single(refused.Problems.OfType<JsonObject>(), p => p["code"]!.GetValue<string>() == "FUNCTION_UNKNOWN");
        Assert.Contains("NullDateTime", unknown["message"]!.GetValue<string>());
        Assert.False(File.Exists(output));
        // What was rewritten comes with the refusal of what stayed (the sort), in the envelope too.
        var envelope = Errors.Envelope("apply", error!, 1);
        var sort = Assert.Single(envelope["normalizations"]!.AsArray().OfType<JsonObject>());
        Assert.Equal(JobNormalizer.SortKeysSplit, sort["rule"]!.GetValue<string>());
        Assert.DoesNotContain(envelope["normalizations"]!.AsArray().OfType<JsonObject>(), n => n["rule"]!.GetValue<string>().Contains(JobNormalizer.NullFunction));
    }

    [Fact]
    public void AFunctionOfTheJobNamedLikeTheNullIsNeverRewritten()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Dir();
        var basePath = BuildBase(dir);
        var (result, error, _) = Run(dir, "own-function", $$$"""
        {"base":"{{{basePath}}}","ops":[
          {"op":"logic","data":{"actions":[
            {"name":"NullTime","function":true,"outputs":[{"name":"Hora","type":"Time"}],"steps":[{"assign":{"Hora":"NewTime(12, 0, 0)"}}]},
            {"name":"VmMeioDia","outputs":[{"name":"Hora","type":"Time"}],"steps":[{"assign":{"Hora":"NullTime()"}}]}]}}]}
        """);
        Assert.True(error == null, error?.ToString());
        Assert.True(result!["accepted"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString());
        Assert.Empty(Normalizations(result));
    }

    [Fact]
    public void ADescriptionOnAnExceptionCreatedByTheJobIsDroppedOnceAndTheJobIsAccepted()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Dir();
        var (result, error, _) = Run(dir, "exception-description", """
        {"base":"blank-service.oml","ops":[
          {"op":"create","parent":"@espace","type":"IUserException","name":"VmFalha","as":"$erro"},
          {"op":"set","target":"$erro","prop":"Description","value":"Interrompe operações que violam o vínculo."}]}
        """);
        Assert.True(error == null, error?.ToString());
        Assert.True(result!["accepted"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString());
        // The preflight's warning and the apply's drop are the same normalization: listed once.
        var dropped = Assert.Single(Normalizations(result));
        Assert.Equal(JobNormalizer.PropertyDropped, dropped["rule"]!.GetValue<string>());
        Assert.Equal("/ops/1/prop", dropped["path"]!.GetValue<string>());
        Assert.True(result["results"]![1]!["result"]!["dropped"]!.GetValue<bool>());
    }

    [Fact]
    public void TheNullOfEachTypeIsAKnownBuiltin()
    {
        Assert.Equal("NullDate()", JobNormalizer.NullOf("NullDateTime", "Date"));
        Assert.Equal("DateToDateTime(NullDate())", JobNormalizer.NullOf("NullDateTime", "Date Time"));
        Assert.Equal("NewTime(0, 0, 0)", JobNormalizer.NullOf("NullDateTime", "Time"));
        Assert.Equal("NewTime(0, 0, 0)", JobNormalizer.NullOf("NullTime", null));
        Assert.Null(JobNormalizer.NullOf("NullDateTime", null));
        Assert.Null(JobNormalizer.NullOf("NullDateTime", "Text"));
        // The O11 catalog has no NullTime nor NullDateTime, and has every function the rewrites write.
        if (Builtins.For("o11") is not { } builtins) return;
        Assert.False(builtins.ContainsKey("NullTime"));
        Assert.False(builtins.ContainsKey("NullDateTime"));
        Assert.True(builtins.ContainsKey("NullDate") && builtins.ContainsKey("DateToDateTime") && builtins.ContainsKey("NewTime"));
    }

    // VisitaCerta 2026-10-12: the ssam-flow/1 texts of a logic op (one text, a list, {text, basedOn}) are normalized in place
    // by the preflight (Anvil.Reading.FlowTextNormalizer) and every edit is listed with its text's pointer and line; a text
    // with another error is left as written and every one of its errors is a FLOW_SYNTAX problem of the same refusal.
    [Fact]
    public void TheFlowTextsOfALogicOpAreNormalizedInPlaceAndListed()
    {
        // The true branch falls through to the end of the flow: going on after the block is its only reading (the end either way).
        var falls = "server action Falls\n  in A: Boolean\n  out N: Integer\n  if A:\n    assign # Done\n      N = 2\n  end\n";
        var broken = "server action Broken\n  out N: Integer\n  assign N = (1\n  X = Call(P=1\n  end\n";
        var job = new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "logic", ["data"] = new JsonObject {
            ["flow"] = new JsonArray(JsonValue.Create(falls), new JsonObject { ["text"] = broken }) } }) };
        var (_, result) = Analyze(job.ToJsonString());
        var normalized = Normalizations(result);
        Assert.Contains(normalized, n => n["rule"]!.GetValue<string>() == Anvil.Reading.FlowTextEdit.FallsThrough && n["path"]!.GetValue<string>() == "/ops/0/data/flow/0" && n["line"]!.GetValue<int>() == 7);
        Assert.Contains(normalized, n => n["rule"]!.GetValue<string>() == Anvil.Reading.FlowTextEdit.LabelSpacing && n["path"]!.GetValue<string>() == "/ops/0/data/flow/0");
        Assert.DoesNotContain(normalized, n => n["path"]!.GetValue<string>().StartsWith("/ops/0/data/flow/1", StringComparison.Ordinal));
        var syntax = Problems(result, "FLOW_SYNTAX");
        Assert.Equal(2, syntax.Length);
        Assert.All(syntax, p => Assert.Equal("/ops/0/data/flow/1", p["pointer"]!.GetValue<string>()));
        // In place: the op holds the normalized text, which the grammar reads; the broken one is as it was sent.
        var ops = JsonNode.Parse(job.ToJsonString())!["ops"]!.AsArray();
        JobNormalizer.Pure(ops, "/ops", "o11");
        var text = ops[0]!["data"]!["flow"]![0]!.GetValue<string>();
        Assert.Contains("    assign  # Done\n      N = 2\n    -> @j1\n  end @j1\n", text);
        Assert.Equal("Falls", Anvil.Reading.ModuleFlow.Read(text).Name);
        Assert.Equal(broken, ops[0]!["data"]!["flow"]![1]!["text"]!.GetValue<string>());
        // Twice is the same job: nothing more to normalize.
        Assert.Empty(JobNormalizer.Pure(ops, "/ops", "o11"));
    }

    // A text with a certain slip and another error is not normalized (it is refused anyway): every error is named, and the
    // errors the certain edit removes carry the op's patch, the text with that edit, verified by reading it again.
    [Fact]
    public void ACertainEditOfATextWithAnotherErrorIsThePatchOfTheErrorsItRemoves()
    {
        // The fall-through is certain (the end either way), the call on line 4 is the other error.
        var text = "server action Mixed\n  in A: Boolean\n  out N: Integer\n  X = Call(P=1\n  if A:\n    assign N = 1\n  end\n";
        var job = new JsonObject { ["ops"] = new JsonArray(new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray(JsonValue.Create(text)) } }) };
        var (_, result) = Analyze(job.ToJsonString());
        Assert.Empty(Normalizations(result));
        var syntax = Problems(result, "FLOW_SYNTAX");
        Assert.Equal(2, syntax.Length);
        var falls = Assert.Single(syntax, p => p["message"]!.GetValue<string>().StartsWith("logic: line 7: ", StringComparison.Ordinal));
        var other = Assert.Single(syntax, p => p["message"]!.GetValue<string>().StartsWith("logic: line 4: ", StringComparison.Ordinal));
        Assert.Null(other["patch"]);
        var written = Patched(job, Assert.IsType<JsonArray>(falls["patch"]));
        Assert.Contains("    assign N = 1\n    -> @j1\n  end @j1\n", written);
        // Only the other error is left in the patched text.
        var left = Assert.IsType<Anvil.Reading.FlowSyntaxException>(Assert.ThrowsAny<FormatException>(() => Anvil.Reading.ModuleFlow.Read(written)));
        Assert.StartsWith("line 4: ", Assert.Single(left.Errors));
    }

    // The first text of the op after a patch of the preflight (replace /ops/0/data/flow).
    private static string Patched(JsonObject job, JsonArray patch)
    {
        var patched = JsonNode.Parse(job.ToJsonString())!;
        foreach (var step in patch.OfType<JsonObject>())
        {
            Assert.Equal("replace", step["op"]!.GetValue<string>());
            Assert.Equal("/ops/0/data/flow", step["path"]!.GetValue<string>());
            patched["ops"]![0]!["data"]!["flow"] = step["value"]!.DeepClone();
        }
        return patched["ops"]![0]!["data"]!["flow"]![0]!.GetValue<string>();
    }

    private static JsonObject FlowJob(params string[] texts) => new() { ["ops"] = new JsonArray(new JsonObject { ["op"] = "logic", ["data"] = new JsonObject {
        ["flow"] = new JsonArray(texts.Select(t => (JsonNode)JsonValue.Create(t)!).ToArray()) } }) };

    // Review of 2026-10-12 (probe 13): an if/else whose true branch forgot its terminator reads two ways (the false branch after
    // it, or the end). Nothing is normalized; the FLOW_SYNTAX of the line names both readings and carries the patch of each
    // (candidates), each a text the grammar reads; the engine never picks one (no patch of its own).
    [Fact]
    public void AFallThroughWithTwoReadingsIsRefusedWithBothVerifiedNeverChosen()
    {
        var text = "server action IfElse\n  in Found: Boolean\n  out Result: Text\n  if Found:\n    assign Result = \"yes\"\n  assign Result = \"no\"\n  end\n";
        var job = FlowJob(text);
        var (_, result) = Analyze(job.ToJsonString());
        Assert.Empty(Normalizations(result));
        var problem = Assert.Single(Problems(result, "FLOW_SYNTAX"));
        Assert.StartsWith("logic: line 6: ", problem["message"]!.GetValue<string>());
        Assert.Null(problem["patch"]);
        var fix = problem["fix"]!.GetValue<string>();
        Assert.Contains("does not choose", fix);
        Assert.Contains("-> @j1", fix);
        Assert.Contains("`    end` before line 6", fix);
        var candidates = problem["candidates"]!.AsArray().OfType<JsonObject>().ToList();
        Assert.Equal(2, candidates.Count);
        var through = Patched(job, candidates[0]["patch"]!.AsArray());
        var ends = Patched(job, candidates[1]["patch"]!.AsArray());
        Assert.Contains("    -> @j1\n  assign Result = \"no\" @j1\n", through);
        Assert.Contains("    end\n  assign Result = \"no\"\n", ends);
        Assert.Equal("IfElse", Anvil.Reading.ModuleFlow.Read(through).Name);
        Assert.Equal("IfElse", Anvil.Reading.ModuleFlow.Read(ends).Name);

        // Re-check of 2026-10-12 (probe N26, the GetWeatherForPlace shape): a true branch that ends on an If with no false step,
        // whose true branch does a step and ends, then the outer If's false branch: two readings too, never a normalization.
        var nested = "server action Nested\n  in A: Boolean\n  in B: Boolean\n  out R: Text\n  if A:\n    assign R = \"a\"\n    if B:\n      assign R = \"b\"\n      end\n  assign R = \"c\"\n  end\n";
        var nestedJob = FlowJob(nested);
        var (_, nestedResult) = Analyze(nestedJob.ToJsonString());
        Assert.Empty(Normalizations(nestedResult));
        var two = Assert.Single(Problems(nestedResult, "FLOW_SYNTAX"));
        Assert.StartsWith("logic: line 10: ", two["message"]!.GetValue<string>());
        Assert.Null(two["patch"]);
        var readings = two["candidates"]!.AsArray().OfType<JsonObject>().ToList();
        Assert.Equal(2, readings.Count);
        Assert.Contains("    -> @j1\n  assign R = \"c\" @j1\n", Patched(nestedJob, readings[0]["patch"]!.AsArray()));
        Assert.Contains("      end\n    end\n  assign R = \"c\"\n", Patched(nestedJob, readings[1]["patch"]!.AsArray()));
    }

    // Review of 2026-10-12 (probes 14 and 15): a call with a space before its parenthesis and an aggregate with a typo after an
    // assign block stay FLOW_SYNTAX (never indented into the block as assignments, which would change what the line means).
    [Fact]
    public void AMalformedNodeLineIsNeverIndentedIntoTheAssignBlockAbove()
    {
        var call = "server action SlipCall\n  out Saved: Rec Identifier\n  local P: Rec\n  assign\n    P.Name = \"a\"\n  Created = CreateRec (Source=P)\n  assign Saved = Created.Id\n  end\n";
        var aggregate = "server action SlipAggregate\n  out N: Integer\n  local P: Rec\n  assign\n    P.Name = \"a\"\n  R = aggregate FROM Rec WHER (Rec.Name <> \"\") MAX 5\n  assign N = R.Count\n  end\n";
        // Re-check of 2026-10-12 (probes N21, N22, pure P1, P2, P2b): spaces around the named argument's `=`, the keywords of
        // an aggregate in another case.
        var spaced = call.Replace("(Source=P)", "(Source = P)");
        var lower = aggregate.Replace("aggregate FROM Rec WHER", "aggregate from Rec WHERE");
        var upper = aggregate.Replace("aggregate FROM Rec WHER", "Aggregate FROM Rec WHERE");
        var (normalizedJob, result) = Analyze(FlowJob(call, aggregate, spaced, lower, upper).ToJsonString());
        Assert.DoesNotContain(Normalizations(result), n => n["rule"]!.GetValue<string>() == Anvil.Reading.FlowTextEdit.AssignmentIndent);
        var syntax = Problems(result, "FLOW_SYNTAX");
        for (var i = 0; i < 3; i++)
            Assert.Contains(syntax, p => p["pointer"]!.GetValue<string>() == "/ops/0/data/flow/" + i && p["message"]!.GetValue<string>().StartsWith("logic: line 6: ", StringComparison.Ordinal));
        Assert.All(syntax, p => Assert.Null(p["patch"]));
        // CX3: keyword casing has one reading and is now explicitly normalized; the malformed cases above still refuse.
        var shapes = Normalizations(result, Anvil.Reading.FlowTextEdit.AggregateSqlShape);
        Assert.Equal(2, shapes.Length);
        foreach (var i in new[] { 3, 4 }) {
            Assert.DoesNotContain(syntax, p => p["pointer"]!.GetValue<string>() == "/ops/0/data/flow/" + i);
            Assert.Contains(shapes, n => n["path"]!.GetValue<string>() == "/ops/0/data/flow/" + i);
            _ = Anvil.Reading.ModuleFlow.Read(normalizedJob!["ops"]![0]!["data"]!["flow"]![i]!.GetValue<string>());
        }
        // Pure probe P3: a built-in function whose first argument is a comparison is no named argument: the line is a slipped
        // assignment (its one reading), indented into the block.
        var slip = "server action SlipIf\n  in A: Integer\n  out T: Text\n  assign\n    T = \"a\"\n  T = If(A=1, \"x\", \"y\")\n  end\n";
        var (_, slipped) = Analyze(FlowJob(slip).ToJsonString());
        Assert.Empty(Problems(slipped, "FLOW_SYNTAX"));
        Assert.Single(Normalizations(slipped, Anvil.Reading.FlowTextEdit.AssignmentIndent));
    }

    // Review of 2026-10-12 (probes 5 and 6): every L.Current of a mapping over L is written relative to the item, on every line;
    // a value that reads the item whole is FLOW_MAPPING_CURSOR, never delivered as the list's cursor.
    [Fact]
    public void AMappingThatReadsItsListsCurrentIsRelativeOnEveryLineOrRefused()
    {
        var mapping = "Q.List mapTo { Name: Q.List.Current.Ent.Name, Code: Trim(Q.List.Current.Ent.City) }";
        var twice = "server action Twice\n  out Rows: Row List\n  out Rows2: Row List\n  Q = aggregate FROM Ent MAX 10\n  assign Rows = " + mapping + "\n  assign Rows2 = " + mapping + "\n  end\n";
        var whole = "server action Whole\n  out Wraps: Wrap List\n  Q = aggregate FROM Ent MAX 10\n  assign Wraps = Q.List mapTo { Place: Q.List.Current, Note: \"x\" }\n  end\n";
        var job = FlowJob(twice, whole);
        var (parsed, result) = Analyze(job.ToJsonString());
        Assert.Equal(2, Normalizations(result, Anvil.Reading.FlowTextEdit.MappingRelative).Length);
        var written = parsed!["ops"]![0]!["data"]!["flow"]![0]!.GetValue<string>();
        Assert.Equal(2, written.Split("Q.List mapTo { Name: Ent.Name, Code: Trim(Ent.City) }").Length - 1);
        Assert.DoesNotContain(".Current", written);
        var cursor = Assert.Single(Problems(result, "FLOW_MAPPING_CURSOR"));
        Assert.Equal("/ops/0/data/flow/1", cursor["pointer"]!.GetValue<string>());
        Assert.Contains("line 4", cursor["message"]!.GetValue<string>());
    }
}
