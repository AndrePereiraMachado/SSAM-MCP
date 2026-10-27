using System.Text.Json.Nodes;

namespace Anvil.Core;

/// <summary>The prototype import is turned off (owner decision of 2026-10-22). A job with the op <c>prototype</c> is refused
/// before anything is loaded or applied, with ONE refusal: PROTOTYPE_IMPORT_DISABLED, one problem per op, and the supported
/// path for screens (the html op written through ssam_code part html, ssam_map view html, ssam_discover). The facade refuses
/// it the same way before any Studio or kernel work (platforms/odc/facade/prototype-disabled.mjs, the same texts word for
/// word). The rest of the Prototype code stays compiled: the html op shares its builder, data table, render and widget
/// defaults (PrototypeBuilder, RuntimeDomTable, PrototypeRender, PrototypeWidgetDefaults).</summary>
public static class PrototypeImport
{
    public const string Op = "prototype";
    public const string DisabledCode = "PROTOTYPE_IMPORT_DISABLED";
    public const string Message = "The prototype import is turned off: the op prototype is no longer supported, and nothing ran (no Studio, build or kernel work).";
    public const string Fix = "Remove the op prototype and build each screen with the html op: write it as ssam-html/1 text with ssam_code (part html, action write; "
        + "action grammar gives the syntax and an example), read an existing screen with ssam_map view html, and ask ssam_discover for anything else.";

    public static bool IsPrototypeOp(JsonNode? op)
        => op is JsonObject o && o["op"] is JsonValue v && v.TryGetValue<string>(out var kind) && kind == Op;

    /// <summary>The problem of one op, in the form of the preflight's (I2).</summary>
    public static JsonObject Problem(int? index, string? pointer)
        => JobPreflight.Problem(index, pointer, DisabledCode, "error", "op #" + (index?.ToString() ?? "?") + " (prototype): " + Message, Fix, null, Op);

    /// <summary>The refusal of the ops (as collected from the job, composite parts included), or null when none is a prototype op.
    /// <paramref name="opsPointer"/>: the pointer of the ops in the job ("" for an array job, "/ops", null for a composite job).</summary>
    public static KernelRefusalException? Refusal(JsonArray ops, string? opsPointer)
    {
        var problems = new JsonArray();
        for (var i = 0; i < ops.Count; i++)
            if (IsPrototypeOp(ops[i])) problems.Add(JobPreflight.PublicProblem(Problem(i, opsPointer == null ? null : opsPointer + "/" + i)));
        return problems.Count == 0 ? null : new KernelRefusalException(DisabledCode, Message + " " + Fix, problems);
    }

    /// <summary>The refusal of one op reached by another path (a session applying ops one by one).</summary>
    public static KernelRefusalException Refusal(int? index)
        => new(DisabledCode, Message + " " + Fix, new JsonArray(JobPreflight.PublicProblem(Problem(index, null))));
}
