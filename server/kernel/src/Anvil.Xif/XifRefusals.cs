using System.Text.Json.Nodes;

namespace Anvil.Xif;

/// <summary>The codes of the headless extension lane (contract INTEGRACOES-GITSSAM.md, section 5, lane xif).</summary>
public static class XifCodes
{
    public const string SpecInvalid = "XIF_SPEC_INVALID";
    public const string PackageInvalid = "XIF_PACKAGE_INVALID";
    public const string CompileFailed = "XIF_COMPILE_FAILED";
    public const string DependencyOverride = "XIF_DEPENDENCY_OVERRIDE";
    public const string EngineUnavailable = "XIF_ENGINE_UNAVAILABLE";
    public const string EngineIncompatible = "XIF_ENGINE_INCOMPATIBLE";
    /// <summary>An unexpected exception in the engine host: a defect of SSAM, never of the spec.</summary>
    public const string EngineFailed = "XIF_ENGINE_FAILED";
    public const string VerifyFailed = "XIF_VERIFY_FAILED";
    public const string MergeFailed = "XIF_MERGE_FAILED";
}

/// <summary>One problem of a refusal (contract 1.6): code, where, what, and the exact fix. SsamRule marks a rule of SSAM
/// that the platform itself would not enforce.</summary>
public sealed record XifProblem(string Code, string? Path, string Message, string? Fix, string? Target = null, bool SsamRule = false,
    JsonObject? Detail = null)
{
    public JsonObject ToJson()
    {
        var o = new JsonObject { ["code"] = Code };
        if (Target != null) o["target"] = Target;
        if (Path != null) o["path"] = Path;
        o["message"] = Message;
        o["fix"] = Fix;
        if (SsamRule) o["ssamRule"] = true;
        if (Detail != null) foreach (var (name, value) in Detail) o[name] = value?.DeepClone();
        return o;
    }
}

/// <summary>A refusal before anything changed: every problem at once.</summary>
public sealed class XifRefusal(string code, string message, IReadOnlyList<XifProblem> problems, JsonObject? extra = null) : Exception(message)
{
    public string Code { get; } = code;
    public IReadOnlyList<XifProblem> Problems { get; } = problems;
    public JsonObject? Extra { get; } = extra;

    public JsonObject ToJson()
    {
        var o = new JsonObject
        {
            ["ok"] = false, ["code"] = Code, ["error"] = Message,
            ["problems"] = new JsonArray(Problems.Select(p => (JsonNode)p.ToJson()).ToArray()),
        };
        if (Extra != null) foreach (var (name, value) in Extra) o[name] = value?.DeepClone();
        return o;
    }

    public static XifRefusal Single(string code, string message, string? fix, string? path = null, JsonObject? extra = null) =>
        new(code, message, [new XifProblem(code, path, message, fix)], extra);
}
