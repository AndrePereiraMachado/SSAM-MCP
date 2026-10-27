using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Anvil.Core;
using Anvil.Reading;
using OutSystems.Model;
using Xunit;
using Xunit.Abstractions;

namespace Anvil.Tests;

// Linked into both test projects. The way back of the data text on the real model: a value written in another form the set
// verb stores the same converges in one round (the documented `schedule "When Published"` of O11 never converged: it was set
// again on every round and refused DDL_NOT_CONVERGED), and a value written otherwise behaves exactly as the same value written
// in its stored form. The sweep is generated from the model: every property of every data element the text accounts for whose
// native type has another text form (a flag, an enum, a whole number).
public sealed class DdlValuesNativeTests(ITestOutputHelper output)
{
    private static (string Lane, string Kernel) Lane()
    {
        var odc = typeof(ModelHost).Assembly.GetType("Anvil.Core.StudioAssembliesOdc");
        var kernel = Path.GetDirectoryName(typeof(DdlValuesNativeTests).Assembly.Location)!;
        while (!File.Exists(Path.Combine(kernel, "MANIFESTO.md"))) kernel = Directory.GetParent(kernel)!.FullName;
        return (odc != null ? "odc" : "o11", kernel);
    }

    private static bool Bind()
    {
        try {
            var assembly = typeof(ModelHost).Assembly;
            var binder = assembly.GetType("Anvil.Core.StudioAssembliesOdc") ?? assembly.GetType("Anvil.Core.StudioAssemblies")!;
            var bind = binder.GetMethods().First(m => m.Name == "Bind");
            bind.Invoke(null, bind.GetParameters().Select(p => p.HasDefaultValue ? p.DefaultValue : null).ToArray());
            return true;
        } catch { return false; }
    }

    private static string Setup(string lane) => $$"""
        {{(lane == "odc" ? "" : "timer SweepTimer action none schedule \"03:00\"")}}

        {{(lane == "odc" ? "setting" : "site property")}} SweepFlag: Boolean

        create entity SweepEntity (
          Id Long Integer identifier auto required,
          Name Text(50),
          Amount Integer
        );

        create static entity SweepStatus (
          Id Integer identifier required,
          Label Text(50) required,
          Order Integer required
        )
        values
          Open (Id = 1, Label = "Open", Order = 1),
          Closed (Id = 2, Label = "Closed", Order = 2);

        type SweepType = {
          Code: Text(20);
          Count: Integer;
        }
        """;

    // A module with one data element of each kind the text declares, built from the lane's blank fixture.
    private (ModelHost Host, string Oml, string Lane)? Module()
    {
        var (lane, kernel) = Lane();
        if (!Bind()) { output.WriteLine("SKIPPED: no Studio to bind"); return null; }
        var fixture = Path.Combine(kernel, "tests", "fixtures", lane == "odc" ? Path.Combine("odc", "blank-mobile.oml") : "blank-service.oml");
        var work = Path.Combine(kernel, ".local", lane == "odc" ? "lane-odc" : "", "ddl-values-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var host = new ModelHost(work);
        var espace = host.Load(File.ReadAllBytes(fixture));
        try {
            new ModelSession(espace) { BaseSha256 = "setup" }.Apply(new JsonArray(new JsonObject { ["op"] = "spec", ["data"] = new JsonObject { ["ddl"] = Setup(lane) } }));
            var oml = Path.Combine(work, "setup.oml");
            File.WriteAllBytes(oml, host.Save(espace));
            return (host, oml, lane);
        }
        finally { ModelHost.Release(espace); }
    }

    private static int Rounds(JsonObject answer) => answer["result"]?["rounds"] is JsonArray rounds ? rounds.Count : -1;

    private static string Line(string text, string key) => text.Split('\n').First(l => l.EndsWith(" -- @" + key, StringComparison.Ordinal));

    // ---- the timer's schedule and its words -------------------------------------------------------------------------------

    [Theory]
    [InlineData("When Published", "WhenPublished")]
    [InlineData("WhenPublished", "WhenPublished")]
    [InlineData(" 03:00 ", "03:00")]
    [InlineData("08:00   Mon Fri", "08:00 Mon Fri")]
    [InlineData("00:00 12:00", "00:00 12:00")]
    public void EachScheduleFormOfANewAndOfAKeptTimerConvergesInOneRound(string written, string stored)
    {
        // The legacy schedule of O11 (an ODC timer is written by its cron).
        if (Lane().Lane != "o11") return;
        if (Module() is not { } module) return;
        var (host, oml, lane) = module;
        var created = DdlBattery.Apply(host, oml, lane, before => before + "\n\ntimer SweepNew action none schedule \"" + written + "\"\n");
        Assert.True(created["error"] == null, created["error"]?.ToString());
        Assert.Equal(1, Rounds(created.AsObject()));
        Assert.Contains("timer SweepNew action none schedule \"" + stored + "\"", created["after"]!.ToString());
        var kept = DdlBattery.Apply(host, oml, lane, before => {
            var line = before.Split('\n').First(l => l.StartsWith("timer SweepTimer ", StringComparison.Ordinal));
            return before.Replace(line, line.Replace("schedule \"03:00\"", "schedule \"" + written + "\""));
        });
        Assert.True(kept["error"] == null, kept["error"]?.ToString());
        Assert.Equal(stored == "03:00" ? 0 : 1, Rounds(kept.AsObject()));
        Assert.Contains("timer SweepTimer action none schedule \"" + stored + "\"", kept["after"]!.ToString());
    }

    [Fact]
    public void TheTimerWordsInAnotherFormOfTheirTypeConvergeAndAnUnknownPriorityIsRefusedByName()
    {
        // O11 (a new ODC timer written by its cron does not converge yet: CronSchedule is kept in another form, not covered here).
        if (Lane().Lane != "o11") return;
        if (Module() is not { } module) return;
        var (host, oml, lane) = module;
        // The priority names of this Studio, from the model's own type, each written in lower case, and the timeout with zeros.
        var espace = host.Load(File.ReadAllBytes(oml));
        string[] names;
        try {
            var timer = new KernelModelReader().Walk((IObjectSignature)espace).First(n => n is OutSystems.Model.Processes.ITimer);
            names = Enum.GetNames(DdlModel.Raw(new KernelModelReader(), timer, "Priority")!.GetType());
        }
        finally { ModelHost.Release(espace); }
        foreach (var clause in names.Select(n => " priority " + n.ToLowerInvariant()).Append(" timeout 005").Append(" timeout 0020")) {
            var answer = DdlBattery.Apply(host, oml, lane, before => {
                var line = before.Split('\n').First(l => l.StartsWith("timer SweepTimer ", StringComparison.Ordinal));
                return before.Replace(line, line.Replace(" -- @", clause + " -- @"));
            });
            Assert.True(answer["error"] == null, clause + ": " + answer["error"]);
            Assert.True(Rounds(answer.AsObject()) <= 1, clause + ": " + answer["result"]!.ToJsonString());
        }
        // A value no name of the type is: refused, naming the line, the timer and the property, with what the type takes.
        var refused = DdlBattery.Apply(host, oml, lane, before => {
            var line = before.Split('\n').First(l => l.StartsWith("timer SweepTimer ", StringComparison.Ordinal));
            return before.Replace(line, line.Replace(" -- @", " priority Urgent -- @"));
        });
        var error = refused["error"]!.ToString();
        Assert.Contains("SweepTimer", error);
        Assert.Contains("Priority", error);
        Assert.Contains("Urgent", error);
        Assert.Contains(names[0], error);
        Assert.DoesNotContain("DDL_NOT_CONVERGED", error);
    }

    [Fact]
    public void TheDocumentedTimerJobIsAcceptedWithItsDataInOneRound()
    {
        var (lane, kernel) = Lane();
        if (lane != "o11" || !Bind()) return;
        var work = Path.Combine(kernel, ".local", "ddl-values-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(work);
        var job = Path.Combine(work, "timer-when-published.json");
        File.WriteAllText(job, """
            {"base":"tests/fixtures/blank-service.oml","expectValid":true,"ops":[
              {"op":"create","parent":"@espace","type":"IServerAction","name":"Seed_Categories","as":"$a"},
              {"op":"set","target":"$a","prop":"Description","value":"Seeds the categories once after each publication"},
              {"op":"create","parent":"$a","type":"IStartNode","as":"$s"},
              {"op":"create","parent":"$a","type":"IEndNode","as":"$e"},
              {"op":"link","from":"$s","to":"$e"},
              {"op":"spec","data":{"ddl":"/// Seeds the categories after each publication.\ntimer Seed_CategoriesTimer action Seed_Categories schedule \"When Published\" timeout 5\n"}}]}
            """);
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(work), null, job, Path.Combine(work, "candidate.oml")))!;
        Assert.True(result["accepted"]!.GetValue<bool>(), result["policyMessages"]?.ToJsonString());
        Assert.True(result["isValid"]!.GetValue<bool>());
        var spec = result["results"]!.AsArray().Single(r => r!["op"]!.ToString() == "spec")!["result"]!;
        Assert.Single(spec["rounds"]!.AsArray());
    }

    // ---- the sweep, generated from the model -------------------------------------------------------------------------------

    private sealed record Probe(string Key, string Kind, string Name, string Property, Type Type, string? Value, Type SetType);

    private static readonly HashSet<string> Kinds = new(StringComparer.Ordinal)
        { "Timer", "SiteProperty", "ServerEntity", "StaticEntity", "Structure", "EntityAttribute", "StructureAttribute", "Record", "StaticEntityRecord" };

    private static List<Probe> Probes(ModelHost host, string oml, string lane)
    {
        var espace = host.Load(File.ReadAllBytes(oml));
        try {
            var reader = new KernelModelReader();
            var text = DataDdl.Build((IObjectSignature)espace, reader, lane, "", 0).Text;
            var parsed = DdlParser.Parse(text).All().Where(e => e.Key.Length > 0).ToDictionary(e => e.Key, StringComparer.Ordinal);
            // The type the set verb converts the value to (the session's, as the way back reads it), else the model value's own.
            var session = new ModelSession(espace);
            var probes = new List<Probe>();
            foreach (var node in reader.Walk((IObjectSignature)espace)) {
                var key = reader.KeyOf(node);
                if (!parsed.TryGetValue(key, out var element) || !Kinds.Contains(element.Kind)) continue;
                foreach (var (property, value) in DdlModel.Compared(reader, node)) {
                    // A property the line already writes (by its word or os:) is that clause's; the others are free to write as os:.
                    if (element.Props.ContainsKey(property) || !reader.IsWritable(node, property)) continue;
                    var type = DdlModel.Raw(reader, node, property)?.GetType();
                    if (type == null || !(type == typeof(bool) || type == typeof(int) || type == typeof(long) || type.IsEnum)) continue;
                    probes.Add(new(key, element.Kind, element.Name, property, type, value, session.DataTextPropertyType(element, property) is { } set ? Nullable.GetUnderlyingType(set) ?? set : type));
                }
            }
            return probes;
        }
        finally { ModelHost.Release(espace); }
    }

    // The text with ` os:<property>=<value>` on the element's line, where its statement takes it.
    private static string With(string text, Probe probe, string value)
    {
        var line = Line(text, probe.Key);
        var clause = " os:" + probe.Property + "=" + value;
        string edited;
        if (line.StartsWith("create ", StringComparison.Ordinal)) edited = Insert(line, " ( -- @", clause);
        else if (line.StartsWith("type ", StringComparison.Ordinal)) edited = Insert(line, " = { -- @", clause);
        else if (probe.Kind is "Timer" or "SiteProperty") edited = line.Contains(" = ", StringComparison.Ordinal) ? Insert(line, " = ", clause) : Insert(line, " -- @", clause);
        else if (probe.Kind is "Record" or "StaticEntityRecord") edited = Regex.Replace(line, @"([,;]) -- @", clause + "$1 -- @");
        else if (line.Contains(" default ", StringComparison.Ordinal)) edited = Insert(line, " default ", clause);
        else edited = Regex.Replace(line, @"([,;]?) -- @", clause + "$1 -- @");
        return text.Replace(line, edited);
        static string Insert(string line, string before, string clause) { var at = line.IndexOf(before, StringComparison.Ordinal); return line[..at] + clause + line[at..]; }
    }

    // The same value in another text form of its type; a different value, in its stored form and in another form.
    private static string? SameOtherwise(Probe p) => p.Value == null ? null
        : p.Type == typeof(bool) || p.Type.IsEnum ? (p.Value.ToLowerInvariant() is var lower && lower != p.Value ? lower : p.Value.ToUpperInvariant())
        : "00" + p.Value;

    private static (string Stored, string Otherwise)? Different(Probe p)
    {
        if (p.Type == typeof(bool)) return p.Value == "True" ? ("False", "false") : ("True", "TRUE");
        if (p.Type.IsEnum) return Enum.GetNames(p.Type).FirstOrDefault(n => n != p.Value) is { } other ? (other, other.ToLowerInvariant() == other ? other.ToUpperInvariant() : other.ToLowerInvariant()) : null;
        var next = (long.TryParse(p.Value, out var n) ? n : 0) + 1;
        return (next.ToString(), "0" + next);
    }

    [Fact]
    public void EveryPropertyWithAnotherTextFormBehavesAsItsStoredForm()
    {
        if (Module() is not { } module) return;
        var (host, oml, lane) = module;
        var probes = Probes(host, oml, lane);
        output.WriteLine($"{lane}: {probes.Count} properties of {probes.Select(p => p.Key).Distinct().Count()} elements ({string.Join(", ", probes.GroupBy(p => p.Kind).Select(g => g.Key + " " + g.Count()))})");
        Assert.True(probes.Count >= 10, "the sweep found " + probes.Count + " properties");
        var failures = new List<string>();
        int same = 0, different = 0, family = 0;
        foreach (var probe in probes) {
            var what = $"{probe.Kind} {probe.Name}.{probe.Property} ({probe.Type.Name} {probe.Value ?? "none"})";
            if (SameOtherwise(probe) is { } otherwise && otherwise != probe.Value) {
                // The value the module has, written otherwise: no change at all.
                var answer = DdlBattery.Apply(host, oml, lane, before => With(before, probe, otherwise)).AsObject();
                if (answer["error"] != null || Rounds(answer) != 0) failures.Add($"{what} as '{otherwise}': {answer["error"] ?? answer["result"]!.ToJsonString()}");
                same++;
            }
            if (Different(probe) is { } change) {
                // Another value: written otherwise, it does what it does written as the module stores it.
                var stored = DdlBattery.Apply(host, oml, lane, before => With(before, probe, change.Stored)).AsObject();
                var written = DdlBattery.Apply(host, oml, lane, before => With(before, probe, change.Otherwise)).AsObject();
                if ((stored["error"] == null) != (written["error"] == null) || stored["error"] == null && (Rounds(stored) != Rounds(written) || stored["after"]!.ToString() != written["after"]!.ToString()))
                    failures.Add($"{what} to '{change.Stored}' / '{change.Otherwise}': {stored["error"] ?? Rounds(stored) + " rounds"} / {written["error"] ?? Rounds(written) + " rounds"}");
                if (written["error"]?.ToString() is { } error && error.Contains("DDL_NOT_CONVERGED", StringComparison.Ordinal) && stored["error"] == null)
                    failures.Add($"{what}: '{change.Otherwise}' did not converge");
                different++;
            }
            // The other word family of a flag (Yes/No of a Boolean, True/False of an enum of Yes and No): what the type takes is a
            // value like any other; what it does not take is refused, naming the element and the property, never a FormatException.
            foreach (var spelling in OtherFamily(probe)) {
                var answer = DdlBattery.Apply(host, oml, lane, before => With(before, probe, spelling)).AsObject();
                var error = answer["error"]?.ToString();
                if (DdlValues.Native(spelling, probe.SetType) is { } native) {
                    if (error != null || native == probe.Value && Rounds(answer) != 0) failures.Add($"{what} as '{spelling}' (taken): {error ?? Rounds(answer) + " rounds"}");
                }
                else if (error == null || !error.Contains(probe.Name, StringComparison.Ordinal) || !error.Contains(probe.Property, StringComparison.Ordinal)
                    || error.Contains("FormatException", StringComparison.Ordinal))
                    failures.Add($"{what} as '{spelling}' (not a value of {probe.SetType.Name}): {error ?? "accepted, " + Rounds(answer) + " rounds"}"
                        + $" [line: {Line(answer["text"]!.ToString(), probe.Key).Trim()}; ops without the session's types: {answer["ops"]!.ToJsonString()}]");
                family++;
            }
        }
        output.WriteLine($"{same} same values written otherwise, {different} different values in two forms, {family} spellings of the other word family");
        Assert.True(failures.Count == 0, string.Join("\n", failures.Take(20)));
    }

    private static IEnumerable<string> OtherFamily(Probe p)
    {
        if (p.Type == typeof(bool)) return ["yes", "Yes", "no", "NO"];
        if (p.Type.IsEnum && Enum.GetNames(p.Type) is var names && names.Contains("Yes") && names.Contains("No")) return ["true", "True", "false"];
        return [];
    }

    // A kept identifier written with its flag in any spelling: the identifier is required (the convention writes True when the
    // text's value is no Boolean), and nothing changes (0 rounds). On 930656b3 `yes` and `Yes` failed with a FormatException.
    [Theory]
    [InlineData("yes")]
    [InlineData("Yes")]
    [InlineData("true")]
    [InlineData("TRUE")]
    [InlineData("no")]
    public void AKeptIdentifierWrittenWithItsFlagInAnySpellingConvergesInNoRound(string spelling)
    {
        if (Module() is not { } module) return;
        var (host, oml, lane) = module;
        var answer = DdlBattery.Apply(host, oml, lane, before => {
            var line = before.Split('\n').First(l => l.StartsWith("  Id ", StringComparison.Ordinal) && l.Contains(" identifier", StringComparison.Ordinal) && l.Contains(" required", StringComparison.Ordinal));
            return before.Replace(line, line.Replace(" required", " os:IsMandatory=" + spelling));
        });
        Assert.True(answer["error"] == null, answer["error"]?.ToString());
        Assert.Equal(0, Rounds(answer.AsObject()));
    }
}
