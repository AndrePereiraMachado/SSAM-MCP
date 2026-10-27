namespace Anvil.Reading;

// The contract of an action without its body (S10, ModuleFlow.BuildSignatures): the header (kind, key, name, owner and the
// action's own properties) and its inputs and outputs, read as Action reads them (same Listed order, same Parameter
// items); locals, nodes and events are never walked. A producer whose body has opaque nodes still has a readable contract.
internal sealed partial class FlowExtractor<T> where T : class
{
    public FlowItem Signature(T action, out List<string> found)
    {
        claimed.Clear(); problems = []; nodeProblems.Clear(); itemOf.Clear(); scope = null;
        actionOwner = reader.ParentOf(action);
        var item = new FlowItem("action", reader.KindOf(action), reader.KeyOf(action), reader.DisplayOf(action));
        if (item.Kind == "Preparation") item.Name = "Preparation";
        if (FlowOwners.Owned(item.Kind) && actionOwner is { } holder && !ReferenceEquals(holder, root)) item.Owner = FlowOwners.Text(reader, root, holder);
        claimed.Add(action);
        Capture(action, item);
        Same(item, "IsFunction", "Function");
        Same(item, "Shareable", "Public");
        foreach (var parameter in Listed(action, "InputParameters", c => reader.KindOf(c) == "InputParameter")) item.Items.Add(Parameter(parameter, "in"));
        foreach (var parameter in Listed(action, "OutputParameters", c => reader.KindOf(c) == "OutputParameter")) item.Items.Add(Parameter(parameter, "out"));
        itemOf.Clear();
        found = problems;
        return item;
    }
}
