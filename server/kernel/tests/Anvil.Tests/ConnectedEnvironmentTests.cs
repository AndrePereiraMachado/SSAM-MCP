using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Xunit;

namespace Anvil.Tests;

public sealed class ConnectedEnvironmentTests
{
    public ConnectedEnvironmentTests() => StudioAssemblies.Bind();

    [Fact]
    public void SessionPinsSelectionAndKeepsReadOnlyWithoutCredentialMaterial()
    {
        var bridge = new Stub();
        using var session = new ConnectedEnvironment(bridge, "lab.example", "Records_CS", true);
        Assert.Equal("lab.example", session.Host);
        Assert.True(session.ReadOnly);
        var connect = bridge.Requests.Single();
        Assert.Equal("Records_CS", connect["module"]!.GetValue<string>());
        Assert.True(connect["readOnly"]!.GetValue<bool>());
        Assert.DoesNotContain("password", connect.ToJsonString(), StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("secret", connect.ToJsonString(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void UnknownWriteOutcomeIsNotReplayedAndLeaseDisposalDoesNotMaskIt()
    {
        var bridge = new Stub { FailOperation = "publish-start" };
        using var session = new ConnectedEnvironment(bridge, null, null, false);
        Assert.Throws<IOException>(() => session.Call<object>("publish-start", new { oml = new byte[] { 1, 2 } }));
        Assert.Single(bridge.Requests, r => r["operation"]!.ToString() == "publish-start");
    }

    [Fact]
    public void BinaryTuplesAndServerErrorsSurviveTheWire()
    {
        var bridge = new Stub {
            Value = JsonSerializer.SerializeToNode((new byte[] { 0, 128, 255 }, "FreshModule"), ConnectedEnvironment.Wire)
        };
        using var session = new ConnectedEnvironment(bridge, null, null, false);
        var value = session.Call<(byte[] Oml, string Name)>("template-module", new { templateKey = "producer-key" });
        Assert.Equal(new byte[] { 0, 128, 255 }, value.Oml);
        Assert.Equal("FreshModule", value.Name);
        bridge.FailOperation = "application-save";
        Assert.Throws<IOException>(() => session.Call<object>("application-save"));
    }

    [Fact]
    public void ClientCallsWithoutAStudioOperationFailExplicitly()
    {
        // The stand-in client is reached only when a code path has no environment operation. Reflection keeps this
        // test free of a compile-time reference to the Studio communication assembly.
        var client = typeof(ConnectedOnlyClient).GetMethod(nameof(ConnectedOnlyClient.Create))!.Invoke(null, null)!;
        var method = client.GetType().GetInterfaces().SelectMany(i => i.GetMethods()).First(m => m.Name == "ListApplications");
        var call = Assert.Throws<System.Reflection.TargetInvocationException>(() =>
            method.Invoke(client, method.GetParameters().Select(p => p.ParameterType.IsValueType ? Activator.CreateInstance(p.ParameterType) : null).ToArray()));
        var error = Assert.IsType<NotSupportedException>(call.InnerException);
        Assert.Contains("no connected-Studio operation", error.Message);
        Assert.Contains("--credentials", error.Message);
    }

    [Fact]
    public void ConnectedHeadlessSessionUsesTheTransportForInventoryAndDownload()
    {
        var bridge = new Stub { Value = new JsonArray() };
        using var session = HeadlessSession.ConnectStudio(bridge, "lab.example", null, true);
        Assert.Empty(session.ListApplications());
        Assert.Empty(session.ListModules());
        Assert.Empty(session.ListCatalogs());
        Assert.Empty(session.ListReferenceable());
        Assert.True(session.IsReadOnly);
        Assert.Throws<InvalidOperationException>(() => session.RequireWrite("CreateOrUpdateApplication"));
        Assert.Equal(new[] { "connect", "applications", "modules", "catalogs", "referenceable" },
            bridge.Requests.Select(r => r["operation"]!.ToString()));
    }

    [Fact]
    public void ReferenceSignatureSerializationPreservesItsNativeContract()
    {
        var type = System.Reflection.Assembly.Load("OutSystems.Communication")
            .GetType("OutSystems.Communication.ServiceCenter.ReferenceInfo", throwOnError: true)!;
        var signature = Activator.CreateInstance(type)!;
        Set("Key", "producer-key"); Set("Name", "Producer"); Set("Kind", "eSpace");
        var hash = Guid.NewGuid(); Set("SignatureHash", hash); Set("SignatureBinary", new byte[] { 1, 7, 255 });
        var wire = JsonSerializer.SerializeToNode(signature, type, ConnectedEnvironment.Wire)!;
        var roundtrip = wire.Deserialize(type, ConnectedEnvironment.Wire)!;
        Assert.Equal("producer-key", Get(roundtrip, "Key"));
        Assert.Equal(hash, Get(roundtrip, "SignatureHash"));
        Assert.Equal(new byte[] { 1, 7, 255 }, (byte[])Get(roundtrip, "SignatureBinary")!);
        void Set(string name, object value)
        {
            if (type.GetProperty(name) is { } property) property.SetValue(signature, value);
            else type.GetField(name)!.SetValue(signature, value);
        }
        object? Get(object target, string name) => type.GetProperty(name)?.GetValue(target) ?? type.GetField(name)?.GetValue(target);
    }

    [Theory]
    [InlineData("application-save")]
    [InlineData("module-associate")]
    [InlineData("application-delete")]
    [InlineData("module-delete")]
    [InlineData("publish-start")]
    public void ReadOnlyLeaseRefusesEveryWriteOperationBeforeSubmission(string operation)
    {
        // The signature capture opens this lease; a write on it must never reach the Studio, even when called directly.
        var bridge = new Stub();
        using var session = new ConnectedEnvironment(bridge, "lab.example", null, true);
        var error = Assert.Throws<InvalidOperationException>(() => session.Call<object>(operation, new { oml = new byte[] { 1 } }));
        Assert.Contains("read-only environment", error.Message);
        Assert.Equal(new[] { "connect" }, bridge.Requests.Select(r => r["operation"]!.ToString()));
        Assert.Equal(EnvironmentOperations.Names.Where(ConnectedEnvironment.WriteOperations.Contains).OrderBy(n => n),
            ConnectedEnvironment.WriteOperations.OrderBy(n => n));
    }

    [Theory]
    [InlineData("CreateOrUpdateApplication")]
    [InlineData("AddModuleToApplication")]
    [InlineData("DeleteApplication")]
    [InlineData("DeleteModule")]
    [InlineData("StartPublish")]
    public void EveryRemoteWritePreservesReadOnlyBeforeSubmission(string operation)
    {
        var bridge = new Stub();
        using var session = HeadlessSession.ConnectStudio(bridge, "lab.example", null, true);
        var method = typeof(Publisher).GetMethods().Single(m => m.Name == operation);
        var arguments = method.GetParameters().Select(p => p.ParameterType == typeof(HeadlessSession) ? (object)session
            : p.ParameterType == typeof(string) ? "fictional-test-value"
            : p.ParameterType == typeof(byte[]) ? Array.Empty<byte>()
            : p.HasDefaultValue ? p.DefaultValue
            : p.ParameterType.IsValueType ? Activator.CreateInstance(p.ParameterType) : null).ToArray();
        var error = Assert.Throws<System.Reflection.TargetInvocationException>(() => method.Invoke(null, arguments));
        Assert.IsType<InvalidOperationException>(error.InnerException);
        Assert.Contains("read-only environment", error.InnerException!.Message);
        Assert.Single(bridge.Requests);
    }

    private sealed class Stub : IBridgeClient
    {
        public readonly List<JsonObject> Requests = [];
        public JsonNode? Value;
        public string? FailOperation;
        public JsonObject Call(string method, JsonObject? parameters = null)
        {
            Assert.Equal("environment_session", method);
            var request = parameters!.DeepClone().AsObject(); Requests.Add(request);
            var op = request["operation"]!.ToString();
            if (op == FailOperation) throw new IOException("Response lost after submission");
            if (op == "connect") return new JsonObject { ["lease"] = "test-lease", ["host"] = "lab.example",
                ["username"] = "test-user", ["ideVersion"] = "11.55.69", ["serverVersion"] = "11.41.0.46924" };
            if (op == "close") return new JsonObject { ["closed"] = true };
            Assert.Equal("test-lease", request["lease"]!.ToString());
            return new JsonObject { ["value"] = Value?.DeepClone() };
        }
    }
}
