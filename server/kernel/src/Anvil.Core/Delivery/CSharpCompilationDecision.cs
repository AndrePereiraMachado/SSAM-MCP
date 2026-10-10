using System.Text.Json.Nodes;
using Anvil.CSharp;

namespace Anvil.Core.Delivery;

public static partial class Delivery
{
    private static FrozenCSharpCompilation? ReadCompilation(DeliveryTask task, DeliveryRequest request, string? environment, string moduleKey)
    {
        var decision = task.State["csharpCompilation"]?.AsObject();
        if (request.Specification?["csharpSource"] is not { } source)
        {
            if (decision != null) throw new InvalidOperationException("Frozen C# compilation requires the original authored source");
            return null;
        }
        if (decision == null)
        {
            if (task.State["writeState"]?.ToString() != "not-sent" || task.State["hasAppliedWrites"]?.GetValue<bool>() == true)
                throw new InvalidOperationException("The original C# compilation was not frozen before writing; no replacement or merge was replayed");
            return null;
        }
        var path = Path.Combine(task.DirectoryPath, "csharp-compilation.json");
        if (decision["path"]?.ToString() != path || decision["fingerprint"] == null || decision["decision"]?.ToString() is not ("freezing" or "frozen"))
            throw new InvalidOperationException("Invalid frozen C# compilation decision");
        var freezing = decision["decision"]!.ToString() == "freezing";
        var frozen = freezing
            ? FrozenCSharpCompilation.FromJson(decision["plan"]?.AsObject() ?? throw new InvalidOperationException("Interrupted C# freeze has no recorded plan"), decision["fingerprint"]!.ToString())
            : FrozenCSharpCompilation.Read(path, decision["fingerprint"]!.ToString());
        frozen.ValidateInputs(source, environment ?? "", moduleKey);
        if (frozen.SourceHash != decision["sourceHash"]?.ToString()) throw new InvalidOperationException("Frozen C# source hash changed");
        if (!freezing) RequireCompilationSource(task.State, path);
        return frozen;
    }

    private static FrozenCSharpCompilation? FreezeCompilation(DeliveryTask task, DeliveryRequest request, string? environment,
        string moduleKey, CompilationResult? compiled, FrozenFrameworkDependencies? runtime, FrozenCSharpCompilation? frozen)
    {
        if (compiled == null) return null;
        var source = request.Specification!["csharpSource"]!;
        var path = Path.Combine(task.DirectoryPath, "csharp-compilation.json");
        if (frozen != null)
        {
            frozen.ValidateReuse(source, environment ?? "", moduleKey, runtime);
            if (task.State["csharpCompilation"]!["decision"]!.ToString() == "freezing") Complete();
            return frozen;
        }
        if (File.Exists(path)) throw new InvalidOperationException("An unrecorded C# compilation lock exists; reconcile the original freeze");
        frozen = FrozenCSharpCompilation.Capture(source, compiled, FrozenCSharpCompilation.PublicProfile, environment ?? "", moduleKey, runtime);
        task.State["csharpCompilation"] = Decision("freezing");
        task.State["csharpCompilation"]!["plan"] = frozen.ToJson();
        task.Save("csharp-compilation-freezing"); Complete(); return frozen;

        JsonObject Decision(string state) => new() { ["decision"] = state, ["path"] = path,
            ["fingerprint"] = frozen!.Fingerprint, ["sourceHash"] = frozen.SourceHash, ["profile"] = frozen.Profile };
        void Complete()
        {
            frozen!.Write(path);
            var sources = task.State["sources"]!.AsArray();
            if (sources.OfType<JsonObject>().Any(item => item["path"]?.ToString() == path)) RequireCompilationSource(task.State, path);
            else sources.Add(new JsonObject { ["path"] = path, ["sha256"] = DeliveryReceipt.Hash(path) });
            task.State["csharpCompilation"] = Decision("frozen"); task.Save("csharp-compilation-frozen");
        }
    }
    private static void RequireCompilationSource(JsonObject state, string path)
    {
        var entries = state["sources"]!.AsArray().OfType<JsonObject>().Where(item => item["path"]?.ToString() == path).ToArray();
        if (entries.Length != 1 || entries[0]["sha256"]?.ToString() != DeliveryReceipt.Hash(path))
            throw new InvalidOperationException("Frozen C# compilation is absent from the original receipt hashes");
    }
}
