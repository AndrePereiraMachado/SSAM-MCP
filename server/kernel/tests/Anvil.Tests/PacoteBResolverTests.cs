using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Reading;
using Xunit;

namespace Anvil.Tests;

/// <summary>
/// Lane B, C21 and the C19 part: jobs and inspect resolve elements by the same rules (the Label of an element without a name,
/// a descendant by name, @espace, True/False under an If), and a property clipped at 400 characters says how to read it in
/// full.
/// </summary>
public sealed class PacoteBResolverTests
{
    private static readonly string Root = PacoteBPolicyTests.FindRoot();

    private sealed class Node(string key, string kind, string name = "", string? label = null)
    {
        public string Key = key, Kind = kind, Name = name;
        public string? Label = label;
        public Node? Parent;
        public List<Node> Children = [];
        public Dictionary<string, object?> Props = [];
        public Node Add(Node child) { child.Parent = this; Children.Add(child); return child; }
    }
    private sealed class Reader : ModelReader<Node>
    {
        protected override IEnumerable<Node> Referrers(Node n) => [];
        protected override IEnumerable<Node> Children(Node n) => n.Children;
        protected override Node? Parent(Node n) => n.Parent;
        protected override string Key(Node n) => n.Key;
        protected override string Kind(Node n) => n.Kind;
        protected override string Name(Node n) => n.Name;
        protected override string? Label(Node n) => n.Label;
        protected override IReadOnlySet<string> KindNames(Node n) => new HashSet<string> { n.Kind, "I" + n.Kind };
        protected override string? Expression(object value) => null;
        protected override IEnumerable<(string Name, Func<object?> Read)> Properties(Node n) => n.Props.Select(p => (p.Key, (Func<object?>)(() => p.Value)));
    }

    private static (Node Root, Node If, Node Yes, Node No) Model()
    {
        var root = new Node("m", "ESpace", "Module");
        var action = root.Add(new Node("a", "ServerAction", "Pay"));
        var decision = action.Add(new Node("i", "IfNode", "", "Has balance"));
        var yes = action.Add(new Node("y", "AssignNode", "", "Debit"));
        var no = action.Add(new Node("n", "RaiseExceptionNode", "RaiseNoFunds"));
        decision.Props["TrueTarget"] = yes; decision.Props["FalseTarget"] = no;
        action.Props["Description"] = new string('d', 450);
        return (root, decision, yes, no);
    }

    [Fact]
    public void InspectTakesTheModuleAliasAndTheBranchesOfAnIf()
    {
        var (root, decision, yes, no) = Model();
        var reader = new Reader();
        Assert.Same(root, reader.Resolve(root, "@espace"));
        Assert.Same(decision, reader.Resolve(root, "@espace/ServerAction:Pay/Has balance"));
        Assert.Same(yes, reader.Resolve(root, "ServerAction:Pay/Has balance/True"));
        Assert.Same(no, reader.Resolve(root, "ServerAction:Pay/Has balance/False"));
        // A descendant by name or label, as in jobs.
        Assert.Same(yes, reader.Resolve(root, "Debit"));
    }

    [Fact]
    public void AClippedPropertyNamesTheExactContinuation()
    {
        var (root, _, _, _) = Model();
        var tree = JsonSerializer.SerializeToNode(new Reader().Read(root, "ServerAction:Pay", new ReadingOptions(Depth: 0)))!["tree"]!;
        var omitted = tree["propertiesOmitted"]!["Description:text"]!;
        Assert.Equal(450, omitted["total"]!.GetValue<int>());
        Assert.Equal("@a", omitted["continuation"]!["path"]!.GetValue<string>());
        Assert.Equal("Description", omitted["continuation"]!["properties"]!.GetValue<string>());
        Assert.True(omitted["continuation"]!["full"]!.GetValue<bool>());
    }

    [Fact]
    public void JobsResolveAnElementWithoutANameByItsLabelAndAnIfByItsBranches()
    {
        if (!PacoteBPolicyTests.StudioAvailable()) return;
        var dir = Path.Combine(Root, ".local", "pacote-b-tests", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(dir);
        var job = Path.Combine(dir, "labels.json");
        File.WriteAllText(job, """
        {"base":"blank-service.oml","ops":[
          {"op":"logic","data":{"actions":[{"name":"PacoteBLabels","public":true,"inputs":[{"name":"N","type":"Integer"}],"outputs":[{"name":"Out","type":"Integer"}],"steps":[
            {"if":"N > 0","label":"Positive","then":[{"assign":{"Out":"N"}}],"else":[{"assign":{"Out":"0"}}]}]}]}},
          {"op":"get","target":"IServerAction:PacoteBLabels/Positive"},
          {"op":"get","target":"IServerAction:PacoteBLabels/Positive/True"},
          {"op":"get","target":"@espace/PacoteBLabels"}]}
        """);
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(new ModelHost(Path.Combine(dir, "work")), null, job, Path.Combine(dir, "labels.oml")))!;
        Assert.True(result["isValid"]!.GetValue<bool>(), result["details"]!.ToJsonString());
        Assert.Contains("IfNode", result["results"]![1]!["result"]!["type"]!.GetValue<string>());
        Assert.Contains("AssignNode", result["results"]![2]!["result"]!["type"]!.GetValue<string>());
        Assert.Contains("ServerAction", result["results"]![3]!["result"]!["type"]!.GetValue<string>());
    }
}
