namespace Anvil.Bridge.Thin.Tests.FakeMerge;

// Review A5 of REVISAO-PREFER-FOREIGN: a merge namespace with the Studio's selection API (MergeUtils.SetIsChecked, MergeUnitCheck
// Foreign and Both) but without MatchTree.HasUnresolvedConflicts. PreferForeign.Find must refuse it, never read the missing
// member as false.
public sealed class MatchTree
{
    public System.Collections.IEnumerable Roots => System.Array.Empty<object>();
    public bool HasConflicts => false;
    public bool IsProgrammaticMerge { get; set; }
}

public sealed class Match { }

public sealed class PropertyPair { }

public enum MergeUnitCheck { None, Local, Foreign, Both }

public static class MergeUtils
{
    public static void SetIsChecked(Match match, MergeUnitCheck check, bool checkDependencies, bool checkAllChildren) { }
}
