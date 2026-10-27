namespace Anvil.Reading;

/// <summary>The schemas the kernel gives an expansion of the general language (R7): the base of a job (Preflight.IBaseFacts)
/// and the types of an apply (IFlowTypes). Kept apart from FlowGeneral.cs so the ODC builder, which shares FlowGeneral.cs
/// and FlowTextNormalize.cs with the kernel, compiles without the preflight (integration of 24/10/2026).</summary>
public static partial class FlowSchema
{
    public static IFlowSchema Of(Anvil.Core.Preflight.IBaseFacts facts) => new Base(facts);
    public static IFlowSchema Of(IFlowTypes types) => new Types(types);
    private sealed class Base(Anvil.Core.Preflight.IBaseFacts facts) : IFlowSchema
    {
        public IReadOnlyList<(string Name, string Type)>? Attributes(string record) =>
            facts.Attributes(record) is { Count: > 0 } found ? found.Where(a => a.Value.Length > 0).Select(a => (a.Key, a.Value)).ToList() : null;
        public IReadOnlyList<(string Name, string Type)>? Outputs(string callee)
        {
            try { return facts.Callee(callee, new System.Text.Json.Nodes.JsonObject())?.Outputs.Where(o => o.Type != null).Select(o => (o.Name, o.Type!)).ToList(); }
            catch { return null; }
        }
    }

    private sealed class Types(IFlowTypes types) : IFlowSchema
    {
        public IReadOnlyList<(string Name, string Type)>? Attributes(string record)
        {
            if (types.AttributesOf(record) is not { Count: > 0 } names) return null;
            var found = names.Select(n => (n, types.AttributeTypeOf(record, n))).ToList();
            return found.All(f => f.Item2 != null) ? found.Select(f => (f.n, f.Item2!)).ToList() : null;
        }
    }

}
