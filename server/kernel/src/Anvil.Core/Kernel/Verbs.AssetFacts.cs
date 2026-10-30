using System.Reflection;
using System.Text.Json.Nodes;

namespace Anvil.Core;

/// <summary>R3-B (PlatformLimits asset.format, KERNEL K6): the facts of an image's bytes at the create, the same reading the
/// preflight lists (Preflight/PlatformLimitRules.ImageFacts) for the raw ops, here for every create, the ones a compact op
/// expands into included (the prototype's images are created with their binary alone).</summary>
public sealed partial class ModelSession
{
    private static readonly string[] ImageFactArgs = ["format", "width", "height"];

    /// <summary>The Create forms of <paramref name="forms"/> that take the binary and its facts (`Byte[] binary`,
    /// `ImageFormat format`, `Int32 width`, `Int32 height`): when <paramref name="args"/> has the binary and leaves a fact out,
    /// it is read from the bytes and written into the args (IMAGE_FACTS_FROM_BYTES); a fact written that the bytes contradict
    /// is refused with both (IMAGE_FACTS_MISMATCH); bytes of no format the Studio's ImageFormat has are refused with the formats
    /// it has (IMAGE_FORMAT_UNKNOWN). A binary that is not base64 is left to the conversion, which says so.</summary>
    private void ImageFactsFromBytes(JsonObject args, IReadOnlyList<MethodInfo> forms, string typeName)
    {
        // The one rule of declared facts (AssetFacts.Declared, the preflight's too): all three written win, nothing judged here.
        if (args["binary"] is not JsonValue binary || !binary.TryGetValue<string>(out var base64) || AssetFacts.Declared(args)) return;
        var form = forms.FirstOrDefault(m => m.GetParameters() is var ps && ps.Any(p => p.Name == "binary" && p.ParameterType == typeof(byte[]))
            && ps.Any(p => p.Name == "format" && p.ParameterType.IsEnum) && ps.Any(p => p.Name == "width" && p.ParameterType == typeof(int))
            && ps.Any(p => p.Name == "height" && p.ParameterType == typeof(int)));
        if (form == null) return;
        byte[] bytes;
        try { bytes = System.Convert.FromBase64String(base64); } catch (FormatException) { return; }
        var formats = Enum.GetNames(form.GetParameters().First(p => p.Name == "format").ParameterType).Where(n => !n.Equals("Unknown", StringComparison.OrdinalIgnoreCase)).ToList();
        var shown = typeName.Split('.').Last();
        var problem = Preflight.PlatformLimitRules.JudgeImage(args, bytes, formats, shown);
        if (problem is { Refused: true } refused)
            throw new KernelRefusalException(refused.Code, refused.Message, new JsonArray(JobPreflight.PublicProblem(
                JobPreflight.Problem(null, null, refused.Code, "error", refused.Message, refused.Fix, null, "create"))));
        var facts = AssetFacts.FromBytes(bytes)!;
        var filled = new List<string>();
        foreach (var (name, value) in Preflight.PlatformLimitRules.FactValues(facts, formats))
            if (!args.ContainsKey(name)) { args[name] = value.DeepClone(); filled.Add($"{name} {value}"); }
        if (filled.Count > 0)
            Normalized([Preflight.JobNormalizer.Entry(AssetFacts.FactsRule, $"/ops/{_applyIndex}/args", "binary without " + string.Join(", ", ImageFactArgs.Where(f => filled.Any(x => x.StartsWith(f + " ", StringComparison.Ordinal)))),
                string.Join(", ", filled), $"create {shown}: the bytes are a {facts.Format.ToUpperInvariant()} image of {facts.Width}x{facts.Height}: {string.Join(", ", filled)} read from them")]);
    }
}
