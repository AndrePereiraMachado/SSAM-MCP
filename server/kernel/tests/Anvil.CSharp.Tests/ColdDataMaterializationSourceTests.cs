using System.ComponentModel.DataAnnotations;
using System.Reflection;
using System.Runtime.Loader;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Authoring;
using Xunit;

namespace Anvil.CSharp.Tests;

/// <summary>Executes the unchanged cold source on the CLR. This baseline exercises
/// detached IDataSession semantics without compiling or executing a native graph.</summary>
public class ColdDataMaterializationSourceTests
{
    private const string SourceHash = "f927a785a9be46f768bc0fd9820e9be94bf9589ad926b55fc5dc77feabe17cfc";
    private const string InputsHash = "d1d755f9f666931bb6d7665c188e3d1911e488a217ee69e56d70c4a9548458da";
    private const string ExpectedHash = "ce1d854f521aebcb584ee6c20b316e4977756f4e155a1eb34c9ac26e85f94dd9";
    private static readonly Lazy<byte[]> AssemblyBytes = new(EmitSource);

    private static string Root
    {
        get
        {
            var directory = new DirectoryInfo(AppContext.BaseDirectory);
            while (directory != null && !File.Exists(Path.Combine(directory.FullName, "MANIFESTO.md")))
                directory = directory.Parent;
            return directory?.FullName ?? throw new InvalidOperationException("Anvil workspace root was not found.");
        }
    }

    private static string Verified(string name, string hash)
    {
        var fixtureName = name switch { "inputs.json" => "inputs.cases.json", "expected.json" => "expected.cases.json", _ => name };
        var path = Path.Combine(AppContext.BaseDirectory, "Cases", "cold-data-materialization", fixtureName);
        var bytes = File.ReadAllBytes(path);
        Assert.Equal(hash, Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant());
        return System.Text.Encoding.UTF8.GetString(bytes).TrimStart('\uFEFF');
    }

    public static IEnumerable<object[]> Cases()
    {
        var cases = JsonNode.Parse(Verified("expected.json", ExpectedHash))!["cases"]!.AsArray();
        Assert.Equal(13, cases.Count);
        return cases.Select(item => new object[] { item!["method"]!.ToString(), item.ToJsonString() }).ToArray();
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void FixedColdSourceMatchesItsDetachedClrOracle(string method, string expectedJson)
    {
        var inputs = JsonNode.Parse(Verified("inputs.json", InputsHash))!;
        var expected = JsonNode.Parse(expectedJson)!;
        using var oracle = new Oracle(inputs);
        var actual = oracle.Invoke(method);
        Assert.Equal(expected["value"]!.GetValue<bool>(), Assert.IsType<bool>(actual));

        var entityName = inputs["seed"]!.AsObject().Single().Key;
        var expectedRows = (JsonArray)inputs["seed"]![entityName]!.DeepClone();
        var expectedFirst = expectedRows.Single(row => row!["Id"]!.GetValue<long>() == 1)!;
        expectedFirst["Quantity"] = expected["storedQuantity1"]!.DeepClone();
        expectedFirst["Note"] = expected["storedNote1"]?.DeepClone();
        if (expected["inserted"] is { } inserted) expectedRows.Add(inserted.DeepClone());
        var persisted = oracle.PersistedRows(entityName);
        Assert.True(JsonNode.DeepEquals(expectedRows, persisted),
            method + " persisted state differs. Expected " + expectedRows.ToJsonString() + "; actual " + persisted.ToJsonString());

        var reports = Path.Combine(Root, ".local", "data-logic-translator", "cold-data-oracle-build", "reports");
        Directory.CreateDirectory(reports);
        var receipt = new JsonObject
        {
            ["method"] = method,
            ["sourceSha256"] = SourceHash,
            ["inputsSha256"] = InputsHash,
            ["expectedSha256"] = ExpectedHash,
            ["clrValue"] = (bool)actual!,
            ["persistedRows"] = persisted,
            ["passed"] = true,
            ["scope"] = "CLR source and detached session only; no generated graph, SQL Server, O11 Verify or Studio execution"
        };
        File.WriteAllText(Path.Combine(reports, method + ".json"), receipt.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
    }

    private static byte[] EmitSource()
    {
        var source = Verified("ColdDataMaterialization.cs.txt", SourceHash);
        using var stream = new MemoryStream();
        var emitted = SourceProgram.Parse(new Dictionary<string, string> { ["ColdDataMaterialization.cs"] = source })
            .Compilation.Emit(stream);
        Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics));
        return stream.ToArray();
    }

    private sealed class Oracle : IDisposable
    {
        private readonly AssemblyLoadContext context = new("cold-data-clr-" + Guid.NewGuid(), isCollectible: true);
        private readonly Assembly assembly;
        private readonly Type rules;
        private readonly DetachedSession session;

        public Oracle(JsonNode inputs)
        {
            using var stream = new MemoryStream(AssemblyBytes.Value, writable: false);
            assembly = context.LoadFromStream(stream);
            rules = assembly.GetType(inputs["class"]!.ToString(), throwOnError: true)!;
            session = new DetachedSession(inputs["nextGeneratedId"]!.GetValue<long>());
            foreach (var entity in inputs["seed"]!.AsObject())
                session.Seed(assembly.GetType(entity.Key, throwOnError: true)!, entity.Value!.AsArray());
        }

        public object? Invoke(string method)
        {
            try { return rules.GetMethod(method, BindingFlags.Public | BindingFlags.Static)!.Invoke(null, [session]); }
            catch (TargetInvocationException error) when (error.InnerException != null)
            {
                System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(error.InnerException).Throw();
                throw;
            }
        }

        public JsonArray PersistedRows(string entityName) => session.Snapshot(assembly.GetType(entityName, throwOnError: true)!);
        public void Dispose() => context.Unload();
    }

    private sealed class DetachedSession(long firstGeneratedId) : IDataSession
    {
        private readonly Dictionary<Type, List<object>> rows = [];
        private long next = firstGeneratedId - 1;
        private List<object> Rows(Type type) => rows.TryGetValue(type, out var values) ? values : rows[type] = [];
        private static PropertyInfo Key(Type type) => type.GetProperty("Id") ?? throw new InvalidOperationException("Entity has no Id property.");
        private static object Clone(object value) => JsonSerializer.Deserialize(JsonSerializer.Serialize(value, value.GetType()), value.GetType())!;
        private static long Identity(object value)
        {
            var key = Key(value.GetType()).GetValue(value)!;
            return key is long number ? number : (long)key.GetType().GetProperty("Value")!.GetValue(key)!;
        }

        public void Seed(Type type, JsonArray seed)
        {
            rows[type] = seed.Select(row => JsonSerializer.Deserialize(row!.ToJsonString(), type)!).ToList();
        }

        public JsonArray Snapshot(Type type) => new(Rows(type).OrderBy(Identity)
            .Select(row => JsonSerializer.SerializeToNode(row, type)).ToArray());

        public IQueryable<T> Query<T>() where T : class => Rows(typeof(T)).Select(row => (T)Clone(row)).ToArray().AsQueryable();

        public Id<T> Insert<T>(T record) where T : class
        {
            Validator.ValidateObject(record, new ValidationContext(record), validateAllProperties: true);
            if (Identity(record) != 0) throw new ArgumentException("New records require an empty generated identity.");
            var id = new Id<T>(++next);
            var copy = Clone(record);
            var key = Key(typeof(T));
            if (key.PropertyType == typeof(long)) key.SetValue(copy, id.Value);
            else if (key.PropertyType == typeof(Id<T>)) key.SetValue(copy, id);
            else throw new InvalidOperationException("The source oracle supports long and Id<T> keys.");
            Rows(typeof(T)).Add(copy);
            return id;
        }

        public void Update<T>(T record) where T : class
        {
            Validator.ValidateObject(record, new ValidationContext(record), validateAllProperties: true);
            var values = Rows(typeof(T));
            var id = Identity(record);
            var index = values.FindIndex(row => Identity(row) == id);
            if (index < 0) throw new InvalidOperationException("Record does not exist.");
            values[index] = Clone(record);
        }

        public void Delete<T>(Id<T> id) where T : class
        {
            var values = Rows(typeof(T));
            var index = values.FindIndex(row => Identity(row) == id.Value);
            if (index < 0) throw new InvalidOperationException("Record does not exist.");
            values.RemoveAt(index);
        }
    }
}
