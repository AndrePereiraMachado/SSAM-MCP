using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// `Tipo:Nome` with several candidates (2026-09-23, platform-events-lifecycle on ODC): an extended event named
/// 'onclick' and a button's builtin event 'OnClick' both implement IEvent, and the first in traversal order changed
/// between processes. The precedence is now exact-case name, then exact kind, then traversal order — and it never
/// picks nothing when a candidate exists.
/// </summary>
public class ReferencePrecedenceTests
{
    private sealed record Obj(string Name, string Kind);

    [Fact]
    public void ExactCaseNameWinsOverCaseInsensitiveMatchWhateverTheTraversalOrder()
    {
        var builtin = new Obj("OnClick", "IBuiltinEvent"); var extended = new Obj("onclick", "IEvent");
        Assert.Same(extended, ReferencePrecedence.Prefer(new[] { builtin, extended }, o => o.Name, o => o.Kind, "IEvent", "onclick"));
        Assert.Same(extended, ReferencePrecedence.Prefer(new[] { extended, builtin }, o => o.Name, o => o.Kind, "IEvent", "onclick"));
        Assert.Same(builtin, ReferencePrecedence.Prefer(new[] { extended, builtin }, o => o.Name, o => o.Kind, "IEvent", "OnClick"));
    }

    [Fact]
    public void ExactKindBreaksTiesAndTraversalOrderBreaksTheRest()
    {
        var a = new Obj("Body", "IEntityAttribute"); var b = new Obj("Body", "IStructureAttribute"); var c = new Obj("Body", "IEntityAttribute");
        Assert.Same(b, ReferencePrecedence.Prefer(new[] { a, b, c }, o => o.Name, o => o.Kind, "IStructureAttribute", "Body"));
        Assert.Same(a, ReferencePrecedence.Prefer(new[] { a, b, c }, o => o.Name, o => o.Kind, "IEntityAttribute", "Body"));
        // no exact kind: the first in traversal order
        Assert.Same(a, ReferencePrecedence.Prefer(new[] { a, c }, o => o.Name, o => o.Kind, "IAttribute", "Body"));
        Assert.Null(ReferencePrecedence.Prefer(Array.Empty<Obj>(), o => o.Name, o => o.Kind, "IAttribute", "Body"));
    }
}
