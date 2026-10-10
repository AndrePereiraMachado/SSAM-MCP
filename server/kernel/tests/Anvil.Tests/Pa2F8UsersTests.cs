using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

/// <summary>Lane F8 of the atritos 2 package (A13): the session asked the user for the numeric id of a test user and for
/// an exception to open the Users app ("Users and roles are out of reach of Edit Data here", "Entity not found in this
/// module: Role"). UserDirectory reads User, Role and User_Role of (System) through the Studio's own Edit Data with a
/// closed attribute list; the password and its hash never leave the Studio. Synthetic rows only (a fake reader plays the
/// Studio side with UserDirectory.Read); Edit Data of (System) and Users stays refused for everything else.</summary>
public sealed class Pa2F8UsersTests
{
    // The platform constants and Edit Data types come from the Studio's assemblies (resolved by StudioAssemblies).
    public Pa2F8UsersTests() => StudioAssemblies.Bind(null);

    // Synthetic attribute keys (database form); the Password key is in the rows to prove it never comes out.
    private const string KId = "aaaaaaaaaaaaaaaaaaaaaa", KUsername = "bbbbbbbbbbbbbbbbbbbbbb", KName = "cccccccccccccccccccccc",
        KEmail = "dddddddddddddddddddddd", KActive = "eeeeeeeeeeeeeeeeeeeeee", KPassword = "ffffffffffffffffffffff",
        KRoleId = "gggggggggggggggggggggg", KRoleName = "hhhhhhhhhhhhhhhhhhhhhh", KLinkUser = "iiiiiiiiiiiiiiiiiiiiii", KLinkRole = "jjjjjjjjjjjjjjjjjjjjjj";
    private const string Hash = "pbkdf2$sha512$SYNTHETIC-HASH-VALUE";

    private static UserDirectory.DirectorySchema Schema() => new(UserDirectory.SystemModuleKey, new Dictionary<string, UserDirectory.EntitySchema>
    {
        ["User"] = new("User", UserDirectory.EntityKeys["User"], new Dictionary<string, string> { ["Id"] = KId, ["Username"] = KUsername, ["Name"] = KName, ["Email"] = KEmail, ["Is_Active"] = KActive }),
        ["Role"] = new("Role", UserDirectory.EntityKeys["Role"], new Dictionary<string, string> { ["Id"] = KRoleId, ["Name"] = KRoleName }),
        ["User_Role"] = new("User_Role", UserDirectory.EntityKeys["User_Role"], new Dictionary<string, string> { ["User_Id"] = KLinkUser, ["Role_Id"] = KLinkRole }),
    });

    private static EnvironmentData.Row User(string id, string username, string email, bool active = true) => new(id,
        [new(KId, id), new(KUsername, username), new(KName, username.ToUpperInvariant()), new(KEmail, email), new(KActive, active ? "True" : "False"), new(KPassword, Hash)]);
    private static readonly EnvironmentData.Row[] Users = [User("1", "admin", "admin@example.test"), User("7", "tester", "Tester@Example.test"), User("9", "old", "old@example.test", false)];
    private static readonly EnvironmentData.Row[] Roles = [new("10", [new(KRoleId, "10"), new(KRoleName, "Manager")]), new("11", [new(KRoleId, "11"), new(KRoleName, "Technician")])];
    private static readonly EnvironmentData.Row[] Links = [new("100", [new(KLinkUser, "7"), new(KLinkRole, "11")]), new("101", [new(KLinkUser, "1"), new(KLinkRole, "10")]),
        new("102", [new(KLinkUser, "9"), new(KLinkRole, "11")])];

    // The Studio side, faithfully: the same checks (Refusal) and the same projection and paging (Read), two rows per page.
    private static Func<JsonObject, JsonObject> Studio(List<JsonObject>? requests = null) => request =>
    {
        requests?.Add(request.DeepClone().AsObject());
        var entity = UserDirectory.EntityOf(request["entityKey"]!.ToString(), UserDirectory.EntityKeys);
        var attributes = request["attributes"]!.AsArray().Select(a => (a!["name"]!.ToString(), a["key"]!.ToString())).ToArray();
        var matchName = request["match"]?["name"]?.ToString();
        Assert.Null(UserDirectory.Refusal(entity, attributes, matchName));
        var source = entity switch { "User" => Users, "Role" => Roles, _ => Links };
        var read = UserDirectory.Read(offset => source.Skip(offset).Take(2).ToArray(), attributes, matchName,
            request["match"]?["values"]?.AsArray().Select(v => v!.ToString()).ToArray(), request["maxRows"]!.GetValue<int>());
        return new JsonObject { ["entity"] = entity, ["rows"] = new JsonArray(read.Rows.Select(r => (JsonNode)r).ToArray()), ["scanned"] = read.Scanned, ["complete"] = read.Complete };
    };

    [Fact]
    public void ALookupByEmailAnswersTheUserAndItsRolesWithoutAnyPasswordField()
    {
        var requests = new List<JsonObject>();
        var answer = UserDirectory.Lookup(Schema(), Studio(requests), new UserDirectory.UsersQuery("tester@example.test", null, null));
        var user = Assert.Single(answer["users"]!.AsArray())!;
        Assert.Equal("7", user["id"]!.ToString());
        Assert.Equal("tester", user["username"]!.ToString());
        Assert.Equal("Tester@Example.test", user["email"]!.ToString());
        Assert.True(user["isActive"]!.GetValue<bool>());
        Assert.Equal(new[] { "Technician" }, user["roles"]!.AsArray().Select(r => r!.ToString()));
        Assert.Equal(new[] { "id", "username", "name", "email", "isActive", "roles" }, user.AsObject().Select(p => p.Key));
        Assert.Equal(1, answer["total"]!.GetValue<int>());
        var text = answer.ToJsonString() + string.Join("", requests.Select(r => r.ToJsonString()));
        Assert.DoesNotContain(Hash, text);
        Assert.DoesNotContain(KPassword, text);
        Assert.DoesNotContain("assword", text);
    }

    [Fact]
    public void ALookupByRoleAnswersItsUsersAndAnUnknownRoleListsTheKnownOnes()
    {
        var byRole = UserDirectory.Lookup(Schema(), Studio(), new UserDirectory.UsersQuery(null, null, "technician"));
        Assert.Equal(new[] { "7", "9" }, byRole["users"]!.AsArray().Select(u => u!["id"]!.ToString()).Order());
        Assert.Equal(2, byRole["total"]!.GetValue<int>());
        Assert.False(byRole["users"]!.AsArray().Single(u => u!["id"]!.ToString() == "9")!["isActive"]!.GetValue<bool>());
        var unknown = UserDirectory.Lookup(Schema(), Studio(), new UserDirectory.UsersQuery(null, null, "Auditor"));
        Assert.Empty(unknown["users"]!.AsArray());
        Assert.Equal("Auditor", unknown["unknownRole"]!.ToString());
        Assert.Equal(new[] { "Manager", "Technician" }, unknown["roles"]!.AsArray().Select(r => r!.ToString()));
        var first = UserDirectory.Lookup(Schema(), Studio(), new UserDirectory.UsersQuery(null, null, null, Max: 2));
        Assert.Equal(2, first["users"]!.AsArray().Count);
        Assert.True(first["more"]!.GetValue<bool>());
        Assert.Equal(100, new UserDirectory.UsersQuery(null, null, null, Max: 500).Bounded);
    }

    [Fact]
    public void TheStudioSideRefusesEverythingOutsideTheClosedListBeforeAnyRead()
    {
        var keys = UserDirectory.EntityKeys;
        Assert.NotNull(UserDirectory.Refusal("User", [("Password", KPassword)], null));
        Assert.NotNull(UserDirectory.Refusal("User", [("Id", KId), ("Password_Hash", KPassword)], null));
        Assert.NotNull(UserDirectory.Refusal("Role", [("Email", KEmail)], null));
        Assert.NotNull(UserDirectory.Refusal("User", [("Id", KId), ("Id", KName)], null));
        Assert.NotNull(UserDirectory.Refusal("User", [("Id", KId), ("Name", KId)], null));
        Assert.NotNull(UserDirectory.Refusal("User", [("Id", KId)], "Email"));
        Assert.NotNull(UserDirectory.Refusal(null, [("Id", KId)], null));
        Assert.Null(UserDirectory.Refusal("User", [("Id", KId), ("Email", KEmail)], "Email"));
        // The request is checked in the Studio before the provider: a lease without the Studio provider still refuses it.
        using var session = HeadlessSession.ConnectStudio(new Stub(), "lab.example", null, readOnly: true);
        var refused = Assert.Throws<KernelRefusalException>(() => UserDirectory.Execute(session, new JsonObject
        {
            ["entityKey"] = keys["User"], ["attributes"] = new JsonArray(new JsonObject { ["name"] = "Password", ["key"] = KPassword }),
        }));
        Assert.Equal("USERS_READ_REFUSED", refused.Code);
        Assert.Equal("USERS_READ_REFUSED", Assert.Throws<KernelRefusalException>(() => UserDirectory.Execute(session, new JsonObject
        {
            ["entityKey"] = "QQQQQQQQQQQQQQQQQQQQQQ", ["attributes"] = new JsonArray(new JsonObject { ["name"] = "Id", ["key"] = KId }),
        })).Code);
    }

    [Fact]
    public void TheProjectionDropsEveryCellNotRequestedAndPagesUntilTheEnd()
    {
        var projected = UserDirectory.Project(Users, [("Id", KId), ("Email", KEmail)]).ToArray();
        Assert.All(projected, row => Assert.Equal(new[] { "Id", "Email" }, row["values"]!.AsObject().Select(p => p.Key)));
        var read = UserDirectory.Read(offset => Users.Skip(offset).Take(2).ToArray(), [("Id", KId)], null, null, 50);
        Assert.Equal((3, 3, true), (read.Rows.Count, read.Scanned, read.Complete));
        var capped = UserDirectory.Read(offset => Users.Skip(offset).Take(2).ToArray(), [("Id", KId)], null, null, 1);
        Assert.Equal((1, false), (capped.Rows.Count, capped.Complete));
    }

    [Fact]
    public void TheEntityKeysAreThePlatformConstantsAndASchemaWithOtherKeysIsRefused()
    {
        Assert.Equal(new[] { "Role", "User", "User_Role" }, UserDirectory.EntityKeys.Keys.Order());
        Assert.Equal("User", UserDirectory.EntityOf(Keys.ToStudio(UserDirectory.EntityKeys["User"]), UserDirectory.EntityKeys));
        Assert.Empty(UserDirectory.Check(Schema(), UserDirectory.EntityKeys));
        var wrong = Schema() with { Entities = new Dictionary<string, UserDirectory.EntitySchema>(Schema().Entities) { ["Role"] = new("Role", "QQQQQQQQQQQQQQQQQQQQQQ", new Dictionary<string, string> { ["Id"] = KRoleId }) } };
        var problems = UserDirectory.Check(wrong, UserDirectory.EntityKeys);
        Assert.Contains(problems, p => p.Contains("not the platform's own"));
        Assert.Contains(problems, p => p.Contains("Role.Name"));
    }

    [Fact]
    public void TheSystemReferenceOfARealModuleCarriesThePlatformKeyOfUser()
    {
        // reactive-ui.oml (a Reactive module from the template) references (System) User: its reference key is the platform
        // constant, the base of FromModel on the published Users module. Role and User_Role it does not reference.
        var root = JobRunner.RepoRoot(Path.GetDirectoryName(typeof(Pa2F8UsersTests).Assembly.Location)!)!;
        var work = Path.Combine(root, ".local", "pa2-f8", "users"); Directory.CreateDirectory(work);
        var found = UserDirectory.SystemEntitiesOfOml(new ModelHost(work), Path.Combine(root, "tests", "fixtures", "reactive-ui.oml"));
        Assert.True(found.ContainsKey("User"), "entities: " + string.Join(", ", found.Keys));
        Assert.Equal("User", UserDirectory.EntityOf(found["User"].Key, UserDirectory.EntityKeys));
        // The reference carries every User attribute (Password, MobilePhone, External_Id...): only the closed list is kept.
        Assert.Equal(new[] { "Email", "Id", "Is_Active", "Name", "Username" }, found["User"].AttributeKeys.Keys.Order());
        Assert.DoesNotContain("Password", found["User"].AttributeKeys.Keys);
        // Role is referenced with its hidden Id only: Id is never required (Edit Data answers the record id with each row).
        Assert.Equal("Role", UserDirectory.EntityOf(found["Role"].Key, UserDirectory.EntityKeys));
        Assert.Empty(found["Role"].AttributeKeys);
    }

    [Fact]
    public void UsersReadIsANewEnvironmentOperationAndEditDataOfSystemAndUsersStaysRefused()
    {
        Assert.Contains(UserDirectory.Operation, EnvironmentOperations.Names);
        Assert.Equal("environment_session:users-read", UserDirectory.Capability);
        Assert.DoesNotContain(UserDirectory.Operation, ConnectedEnvironment.WriteOperations);
        // o11_data keeps refusing (System) (the ServiceCenter eSpace) and Users for every read and write.
        Assert.True(EnvironmentData.IsRefusedModule(UserDirectory.SystemModuleKey));
        Assert.True(EnvironmentData.IsRefusedModule(UserDirectory.UsersModuleKey));
        // A lease says whether its bridge serves the operation (an older bridge: no users lookup, refused in the CLI).
        using (var old = HeadlessSession.ConnectStudio(new Stub(), "lab.example", null, readOnly: true)) Assert.False(old.Serves(UserDirectory.Operation));
        using var current = HeadlessSession.ConnectStudio(new Stub { Operations = ["download", UserDirectory.Operation] }, "lab.example", null, readOnly: true);
        Assert.True(current.Serves(UserDirectory.Operation));
    }

    private sealed class Stub : IBridgeClient
    {
        public string[]? Operations;
        public JsonObject Call(string method, JsonObject? parameters = null)
        {
            var op = parameters!["operation"]!.ToString();
            if (op != "connect") return new JsonObject { ["value"] = null };
            var answer = new JsonObject { ["lease"] = "l", ["host"] = "lab.example", ["username"] = "u", ["ideVersion"] = "11.55.69", ["serverVersion"] = "11.41.0.1" };
            if (Operations != null) answer["operations"] = new JsonArray(Operations.Select(o => (JsonNode)o).ToArray());
            return answer;
        }
    }
}
