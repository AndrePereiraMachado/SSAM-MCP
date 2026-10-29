using System.Text.Json.Nodes;
using Anvil.Reading;
using Anvil.Core;
using Anvil.Core.Preflight;
using Xunit;

namespace Anvil.Tests;

public sealed class ActionNameCollisionTests
{
    private static JsonArray Ops(string json) => JsonNode.Parse(json)!.AsArray();

    [Fact]
    public void EntityActionsAreKnownBeforeApplyAndOnlyUnambiguousCallsMove()
    {
        var ops = Ops("""
        [{"op":"spec","data":{"entities":[{"name":"Parcel","attributes":[]}]}},
         {"op":"logic","data":{"actions":[
           {"name":"CreateParcel","inputs":[{"name":"Payload","type":"Text"}],"steps":[]},
           {"name":"Caller","steps":[{"call":"CreateParcel","args":{"Payload":"\"x\""}},
             {"call":"CreateParcel","args":{"Source":"Row"}},
             {"call":"IEntityActionSignature:CreateParcel","args":{"Source":"Row"}}]}]}}]
        """);
        var problem = Assert.Single(ActionNameRules.Check(ops, "/ops", null));
        Assert.Equal("/ops/1/data/actions/0/name", problem["pointer"]!.ToString());
        Assert.Equal("IEntityActionSignature", problem["taken"]!["kind"]!.ToString());
        Assert.Equal(ActionNameRules.Fix, problem["fix"]!.ToString());
        var patch = problem["patch"]!.AsArray();
        Assert.Equal(2, patch.Count);
        Assert.Equal("CreateParcel2", patch[0]!["value"]!.ToString());
        Assert.Equal("/ops/1/data/actions/1/steps/0/call", patch[1]!["path"]!.ToString());
        Assert.Equal("CreateParcel2", patch[1]!["value"]!.ToString());
    }

    [Fact]
    public void ModulePassRunsWithAReferenceAndReturnsOneProblemPerNewName()
    {
        var ops = Ops("""
        [{"op":"reference","producer":"Utilities","elements":["IServerAction:Imported"]},
         {"op":"logic","data":{"actions":[{"name":"Existing","steps":[]},
           {"name":"Existing","replace":true,"steps":[]},{"name":"Free","steps":[]}]}}]
        """);
        var problem = Assert.Single(PreflightChecks.WithModule(ops, "/ops", "o11", new Base()).Problems);
        Assert.Equal("NAME_COLLISION", problem["code"]!.ToString());
        Assert.Equal("/ops/1/data/actions/0/name", problem["pointer"]!.ToString());
        Assert.NotNull(problem["patch"]);
        ops[1]!["data"]!["actions"]![0]!["name"] = "Imported";
        Assert.Single(ActionNameRules.Check(ops, "/ops", null));
    }

    [Fact]
    public void TextHeadersAndCallsShareOnePatchEvenWhenABodyDoesNotParse()
    {
        var ops = Ops("""
        [{"op":"logic","data":{"flow":[
         "server action Existing\n  in Payload: Text\n  nonsense\n  end\n",
         "server action Caller\n  Existing(Payload=\"x\")\n  Existing(Source=Row)\n  end\n"]}}]
        """);
        var problem = Assert.Single(ActionNameRules.Check(ops, "/ops", new Base()));
        Assert.Equal("/ops/0/data/flow/0", problem["pointer"]!.ToString());
        var patch = problem["patch"]!.AsArray();
        Assert.StartsWith("server action Existing2\n", patch[0]!["value"]!.ToString());
        Assert.Contains("  Existing2(Payload=\"x\")", patch[1]!["value"]!.ToString());
        Assert.Contains("  Existing(Source=Row)", patch[1]!["value"]!.ToString());
    }

    [Fact]
    public void ReadHeadersAndLocalActionsAreNotNewModuleActions()
    {
        var ops = Ops("""
        [{"op":"logic","data":{"flow":["server action Existing @abcdefgh\n  end\n",
          "action Home.Existing\n  end\n"]}}]
        """);
        Assert.Empty(ActionNameRules.Check(ops, "/ops", new Base()));
    }

    [Fact]
    public void AllCollisionsOfOneTextCollectionCarryTheSameCompletePatch()
    {
        var ops = Ops("""
        [{"op":"logic","data":{"flow":["server action Existing\n  end\n",
          "server action ExistingOther\n  end\n"]}}]
        """);
        var problems = ActionNameRules.Check(ops, "/ops", new Base());
        Assert.Equal(2, problems.Count);
        Assert.Equal(problems[0]["patch"]!.ToJsonString(), problems[1]["patch"]!.ToJsonString());
        Assert.Equal(2, problems[0]["patch"]!.AsArray().Count);
    }

    [Fact]
    public void NumberedNamesUseTheNativeStemAndSkipOccupiedNames()
    {
        Assert.Equal("Action4", NameRules.Free("Action2", ["Action", "Action2", "Action3"]));
        Assert.Equal("Action10", NameRules.Free("Action9", ["Action9"]));
    }

    [Fact]
    public void ImportedClientAndServerActionsOccupyOnlyTheirNativeScope()
    {
        var ops = Ops("""
        [{"op":"reference","producer":"Library","elements":["IClientAction:Shared","IServerAction:Other"]},
          {"op":"logic","data":{"actions":[{"name":"Shared","kind":"server","steps":[]},
            {"name":"Other","kind":"client","steps":[]},{"name":"Shared","kind":"client","steps":[]},
            {"name":"Other","kind":"server","steps":[]}]}}]
        """);
        var problems = ActionNameRules.Check(ops, "/ops", null);
        Assert.Equal(2, problems.Count);
        Assert.Equal("/ops/1/data/actions/2/name", problems[0]["pointer"]!.ToString());
        Assert.Equal("/ops/1/data/actions/3/name", problems[1]["pointer"]!.ToString());
    }

    [Fact]
    public void FreeNamesIgnoreNamesTakenOnlyByTheOtherScope()
    {
        var ops = Ops("""
        [{"op":"reference","producer":"Library","elements":["IClientAction:Existing2"]},
          {"op":"logic","data":{"actions":[{"name":"Existing","kind":"server","steps":[]}]}}]
        """);
        var problem = Assert.Single(ActionNameRules.Check(ops, "/ops", new Base()));
        Assert.Equal("Existing2", Assert.Single(problem["patch"]!.AsArray())!["value"]!.ToString());
    }

    [Fact]
    public void TheBaseRefinesAPurePatchAndKeepsTheCompletePatchOnEveryCollision()
    {
        var ops = Ops("""
        [{"op":"spec","data":{"entities":[{"name":"Parcel","attributes":[]}]}},
         {"op":"logic","data":{"actions":[{"name":"CreateParcel","steps":[]},{"name":"Existing","steps":[]}]}}]
        """);
        var pure = Assert.Single(ActionNameRules.Check(ops, "/ops", null));
        var preflight = new JsonObject { ["problems"] = new JsonArray(pure), ["errors"] = new JsonArray(JobPreflight.Text(pure)) };
        var withBase = ActionNameRules.Check(ops, "/ops", new Base("CreateParcel2", "Existing"));
        Assert.Equal(2, withBase.Count);
        Assert.Equal(withBase[0]["patch"]!.ToJsonString(), withBase[1]["patch"]!.ToJsonString());
        Assert.True(ActionNameRules.EnrichPreflight(preflight, withBase[0], withBase[0]["pointer"]!.ToString()));
        Assert.False(ActionNameRules.EnrichPreflight(preflight, withBase[1], withBase[1]["pointer"]!.ToString()));
        Assert.Single(preflight["problems"]!.AsArray());
        Assert.Equal("CreateParcel3", pure["patch"]![0]!["value"]!.ToString());
        Assert.Equal(withBase[1]["patch"]!.ToJsonString(), pure["patch"]!.ToJsonString());
        Assert.Contains("CreateParcel3", preflight["errors"]![0]!.ToString());
    }

    /// <summary>R1 item 4 (2026-10-28): a model sent the texts of 83 actions of the module again without @key; NAME_COLLISION
    /// offered each one a derived name (X2) and the actions were deleted and created again. A declaration named after the
    /// module's own action of the same kind is the edit of that action: FLOW_ACTION_NAME_TAKEN with its key, its current text
    /// and the op rename, for every such declaration at once, and no derived name anywhere. A name taken by an element of
    /// another kind keeps its numbered free name.</summary>
    [Fact]
    public void ADeclarationNamedAfterAnOwnActionOfTheSameKindIsItsEditPathNeverADerivedName()
    {
        var ops = Ops("""
        [{"op":"logic","data":{"flow":["server action Existing\n  in Amount: Integer\n  end\n","server action Caller\n  Existing(Amount=1)\n  end\n",
          "service action Other\n  end\n"]}},
         {"op":"logic","data":{"actions":[{"name":"ExistingJson","steps":[]},{"name":"Other","kind":"client","steps":[]}]}}]
        """);
        var problems = ActionNameRules.Check(ops, "/ops", new Own());
        Assert.DoesNotContain(problems.Select(p => p.ToJsonString()), json => json.Contains("Existing2", StringComparison.Ordinal) || json.Contains("ExistingJson2", StringComparison.Ordinal));
        var text = Assert.Single(problems, p => p["pointer"]!.ToString() == "/ops/0/data/flow/0");
        Assert.Equal("FLOW_ACTION_NAME_TAKEN", text["code"]!.ToString());
        Assert.Null(text["patch"]);
        Assert.Equal("kExisting", text["id"]!.ToString());
        Assert.Equal(Own.TextOf("Existing"), text["text"]!.ToString());
        Assert.Equal(ModuleFlow.TextSha(Own.TextOf("Existing")), text["textSha"]!.ToString());
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse("""{"op":"rename","target":"@kExisting","name":"<new name>"}"""), text["rename"]));
        Assert.Contains("@kExisting", text["message"]!.ToString());
        var json = Assert.Single(problems, p => p["pointer"]!.ToString() == "/ops/1/data/actions/0/name");
        Assert.Equal("FLOW_ACTION_NAME_TAKEN", json["code"]!.ToString());
        Assert.Equal("@kExistingJson", json["rename"]!["target"]!.ToString());
        // A service action named after a server action of the module is another kind of element in the same scope: the Studio
        // would rename it, so that one keeps NAME_COLLISION and its free name. A client action is in another scope: nothing.
        var other = Assert.Single(problems, p => p["pointer"]!.ToString() == "/ops/0/data/flow/2");
        Assert.Equal("NAME_COLLISION", other["code"]!.ToString());
        Assert.Contains("Other2", other["patch"]!.ToJsonString());
        Assert.Equal(3, problems.Count);
    }

    [Fact]
    public void CorpusCollisionContractDistinguishesOwnEntityAndImportedActionsWithoutCaptures()
    {
        var own = Assert.Single(ActionNameRules.Check(Ops("""[{"op":"logic","data":{"actions":[{"name":"Existing","steps":[]}]}}]"""), "/ops", new Own()));
        PatchCertaintyCorpusTests.AssertCollision(own, true);
        var entity = Assert.Single(ActionNameRules.Check(Ops("""[{"op":"logic","data":{"actions":[{"name":"Existing","steps":[]}]}}]"""), "/ops", new Base()));
        PatchCertaintyCorpusTests.AssertCollision(entity, false);
        var imported = Assert.Single(ActionNameRules.Check(Ops("""[{"op":"reference","producer":"Library","elements":["IServerAction:Imported"]},{"op":"logic","data":{"actions":[{"name":"Imported","steps":[]}]}}]"""), "/ops", null));
        PatchCertaintyCorpusTests.AssertCollision(imported, false);
    }

    [Fact]
    public void AnActionWhoseBodyCannotRoundTripRequiresLogicReplace()
    {
        var problem = Assert.Single(ActionNameRules.Check(Ops("""[{"op":"logic","data":{"flow":"server action Existing\n  end\n"}}]"""), "/ops", new Own(false)));
        Assert.Null(problem["text"]);
        Assert.Contains("not a fixed point", problem["fix"]!.ToString());
        Assert.Contains("logic op replace", problem["fix"]!.ToString());
        Assert.DoesNotContain("read the current text", problem["fix"]!.ToString());
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void AJsonRedeclarationOffersReplaceTrue(bool readable)
    {
        var problem = Assert.Single(ActionNameRules.Check(Ops("""[{"op":"logic","data":{"actions":[{"name":"Existing","steps":[]}]}}]"""), "/ops", new Own(readable)));
        var fix = problem["fix"]!.ToString();
        Assert.Contains("replace:true", fix);
        Assert.Contains("never delete it and create it again under the new name", fix);
        Assert.DoesNotContain("never delete and create it again", fix);
        if (readable)
        {
            Assert.Contains("alternatively, edit the current text (field text), keeping @kExisting", fix);
            Assert.Contains(problem["textSha"]!.ToString(), fix);
        }
        else Assert.DoesNotContain("alternatively", fix);
        Assert.Equal("@kExisting", problem["rename"]!["target"]!.ToString());
    }

    // The module of R1 item 4: server actions Existing, ExistingJson and Other of the module itself.
    private sealed class Own(bool readable = true) : IBaseFacts
    {
        public bool HasActionBodies => true;
        private static readonly string[] Actions = ["Existing", "ExistingJson", "Other"];
        public static string TextOf(string name) => $"server action {name} @k{name}\n  in Amount: Integer @kIn{name}\n  end\n";
        public ActionNameFact? ActionNameTaken(string name, string kind)
            => ActionNameRules.Scope(kind) == "server" && Actions.Contains(name, StringComparer.OrdinalIgnoreCase) ? new("IServerAction", name, "Mod", "server") : null;
        public (string Key, string? Text)? OwnAction(string name, string kind)
            => kind == "ServerAction" && Actions.FirstOrDefault(a => a.Equals(name, StringComparison.OrdinalIgnoreCase)) is { } found ? ("k" + found, readable ? TextOf(found) : null) : null;
        public CalleeFact? Callee(string target, JsonObject caller) => null;
        public IReadOnlyDictionary<string, string>? Attributes(string record) => null;
        public bool IsClientEntity(string name) => false;
        public bool HasName(string name) => false;
        public bool NamesOnlyTypes(string name) => false;
        public bool IsFunction(string name) => false;
        public string? ModuleType => null;
        public RawExpressionFact? RawExpression(string target, string prop) => null;
    }

    private sealed class Base(params string[] names) : IBaseFacts
    {
        public ActionNameFact? ActionNameTaken(string name) => (names.Length == 0 ? name is "Existing" or "ExistingOther" : names.Contains(name, StringComparer.OrdinalIgnoreCase))
            ? new("IEntityActionSignature", name, "Record") : null;
        public CalleeFact? Callee(string target, JsonObject caller) => new(target, [new("Source", "Record", true)], []);
        public IReadOnlyDictionary<string, string>? Attributes(string record) => null;
        public bool IsClientEntity(string name) => false;
        public bool HasName(string name) => false;
        public bool NamesOnlyTypes(string name) => false;
        public bool IsFunction(string name) => false;
        public string? ModuleType => null;
        public RawExpressionFact? RawExpression(string target, string prop) => null;
    }
}
