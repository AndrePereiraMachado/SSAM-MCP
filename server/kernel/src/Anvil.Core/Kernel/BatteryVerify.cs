using OutSystems.Model;
using ESpace = ServiceStudio.Model.ESpace;

namespace Anvil.Core;

/// <summary>
/// The Verify of the batteries of the logic text (review of the third junction: they judged only the text, so a case that read
/// back as its text in a module the Verify refuses counted as exact: a hidden empty mapping, a record literal the platform kept
/// as text it could not parse). One case in every <see cref="Every"/> is checked: it is exact only if the Verify has no parser
/// error (Parser*: an expression the platform reads otherwise than the text, or not at all) under the action the case wrote
/// that the action did not have before (by message id and the kind of element it is on; the errors the module already had stay
/// out). Only the parser's errors: the other errors a case can bring are what its synthetic edit says (a removed step that set a
/// data action's output), the same with or without the engine. FLOW_BATTERY_VERIFY=N sets the rate (0 turns it off; 25 by
/// default). The Verify is of the whole module (the Model API has no other), so it is sampled, never run on every case.
/// </summary>
public sealed class BatteryVerify
{
    /// <summary>The module the battery has loaded now (set again when it loads the module again).</summary>
    public ESpace? Module { get; set; }

    public static int Every => int.TryParse(Environment.GetEnvironmentVariable("FLOW_BATTERY_VERIFY"), out var every) ? Math.Max(0, every) : 25;

    private readonly int every = Every;
    private int seen;
    // The errors each action had before its cases (by its key): an undone case leaves the action as it was read.
    private readonly Dictionary<string, List<string>> before = new(StringComparer.Ordinal);

    public int Verified { get; private set; }
    public int Refused { get; private set; }

    /// <summary>Whether this case is one the Verify checks (one in every N, in the order the battery runs them).</summary>
    public bool Sample() => every > 0 && seen++ % every == 0;

    /// <summary>The errors under the action before its first checked case (kept for its later cases).</summary>
    public void Before(IObjectSignature action, IObjectSignature? template = null)
    {
        var key = action.ObjectKey?.ToString() ?? "";
        if (!before.ContainsKey(key)) before[key] = Errors(template ?? action);
    }

    /// <summary>The errors the case added under the action (empty when none): the case is not exact when there is one.
    /// template: the action whose errors a new action copied (the creation battery), else the action as it was before.</summary>
    public List<string> Added(IObjectSignature action, IObjectSignature? template = null)
    {
        Verified++;
        var was = before.TryGetValue(action.ObjectKey?.ToString() ?? "", out var known) ? known : template != null ? Errors(template) : [];
        var now = Errors(action);
        var left = was.GroupBy(e => e).ToDictionary(g => g.Key, g => g.Count(), StringComparer.Ordinal);
        var added = new List<string>();
        foreach (var error in now) {
            if (left.TryGetValue(error, out var count) && count > 0) { left[error] = count - 1; continue; }
            added.Add(error);
        }
        if (added.Count > 0) Refused++;
        return added;
    }

    // The Verify's parser errors whose element is the action or lies under it: message id and the kind of the element.
    private List<string> Errors(IObjectSignature action)
    {
        var errors = new List<string>();
        if (Module == null) return errors;
        foreach (var message in Module.Verify()) {
            if (!message.Type.ToString().Contains("Error", StringComparison.Ordinal) || !message.Id.StartsWith("Parser", StringComparison.Ordinal)) continue;
            var owner = message.ObjectIdentifier?.TryGetAbstractObject() as IObjectSignature;
            for (var at = owner; at != null; at = at.Parent as IObjectSignature)
                if (ReferenceEquals(at, action)) {
                    errors.Add(message.Id + " on " + owner!.GetType().Name);
                    break;
                }
        }
        return errors;
    }
}
