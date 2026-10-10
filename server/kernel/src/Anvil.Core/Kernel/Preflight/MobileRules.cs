using System.Text.Json.Nodes;

namespace Anvil.Core.Preflight;

/// <summary>
/// A04 MOBILE_BLOCK_WITH_NAVIGATION: in a Mobile app the Studio refuses a block that navigates to a screen ("You can't use
/// Block 'X' in a Mobile module because the Block contains navigation to other Screens"). A screen action of a block of the
/// job with a Destination node is refused before the apply, with the platform's own pattern as the fix: the block triggers
/// an event and the screen that uses it navigates. Needs the module type, so it runs with the base.
/// </summary>
public static class MobileRules
{
    public static List<JsonObject> Check(JsonArray ops, string? prefix, JobFacts job, IBaseFacts? model)
    {
        var problems = new List<JsonObject>();
        if (model?.ModuleType is not "Mobile") return problems;
        foreach (var action in job.Actions.Where(a => a.IsScreen && a.Owner.StartsWith("IMobileBlock:", StringComparison.Ordinal)))
        {
            var at = prefix == null ? null : $"{prefix}/{action.Op}/data/actions/{action.Index}";
            foreach (var (step, pointer) in LogicScan.Of(action.Declaration).Steps)
            {
                if (step["node"]?.ToString() != "IDestinationNode") continue;
                var block = action.Owner["IMobileBlock:".Length..];
                var destination = step["properties"]?["Destination"]?.ToString() ?? "the screen";
                problems.Add(JobPreflight.Problem(action.Op, at == null ? null : at + pointer, "MOBILE_BLOCK_WITH_NAVIGATION", "error",
                    $"screen action {action.Name} of block {block} navigates to {destination}, and this is a Mobile app: the Studio refuses a block with navigation to other screens in a Mobile module",
                    $"declare an event on {block} (e.g. OnNavigate), trigger it here instead of the Destination (a Trigger Event node), and handle it in the screen that uses {block} with the Destination to {destination}", null, "logic"));
            }
        }
        return problems;
    }
}
