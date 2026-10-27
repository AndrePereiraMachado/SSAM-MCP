using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

/// <summary>LogicLint over the text form of the logic op (lab/batch-speed, R5): the expression-typed values of every text that
/// parses are the job's expressions (the checks of unknown functions read them before any build), never SQL, JavaScript or
/// comments; a text that does not parse hides nothing of another; a call of an action another text of the job declares is
/// no unknown function.</summary>
public sealed class FlowTextLintTests
{
    private static JsonArray Job(params string[] texts) =>
        new(new JsonObject { ["op"] = "logic", ["data"] = new JsonObject { ["flow"] = new JsonArray(texts.Select(t => (JsonNode)JsonValue.Create(t)!).ToArray()) } });

    [Fact]
    public void TheTextFormsExpressionsAreReadFromTheirParse()
    {
        var ops = Job(
            "server action Totals\n  in Name: Text\n  out Upper: Text\n  // Lower(Comment) is not read\n  assign Upper = Lowr(Name)\n"
                + "  Rows = sql -> Row max 10\n    | SELECT Lower({Row}.[Name]) FROM {Row}\n  if Length(Name) > Mystery(1):\n    end\n  end\n",
            "server action Broken\n  assign X = (1\n  end\n",
            "server action Other\n  out Y: Integer\n  assign Y = Unknown2(3)\n  end\n");
        var found = LogicLint.AllExpressions(ops).Select(e => e.Text).ToList();
        Assert.Contains("Lowr(Name)", found);
        Assert.Contains("Length(Name) > Mystery(1)", found);
        Assert.Contains("Unknown2(3)", found);
        Assert.DoesNotContain(found, e => e.Contains("Lower(", StringComparison.Ordinal));
        Assert.All(LogicLint.AllExpressions(ops), e => Assert.Equal(0, e.Op));
    }

    [Fact]
    public void ACallOfAnActionAnotherTextDeclaresIsNoUnknownFunction()
    {
        var ops = Job(
            "server action Twice function\n  in N: Integer\n  out R: Integer\n  assign R = N*2\n  end\n",
            "server action UseIt\n  out Y: Integer\n  assign Y = Twice(3) + Unknown(1)\n  end\n");
        var found = LogicLint.AllExpressions(ops).Select(e => e.Text).ToList();
        Assert.Contains("(3) + Unknown(1)", found);
        Assert.DoesNotContain(found, e => e.Contains("Twice(", StringComparison.Ordinal));
    }
}
