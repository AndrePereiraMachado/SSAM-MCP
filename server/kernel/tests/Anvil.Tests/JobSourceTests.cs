using System.Text.Json;
using System.Text.Json.Nodes;
using Anvil.Core;
using Xunit;

namespace Anvil.Tests;

public sealed class JobSourceTests
{
    private static readonly string Root = FindRoot();
    private static readonly string JobDir = Path.Combine(Root, "tests", "jobs");

    [Theory]
    [InlineData("tests/fixtures/blank-service.oml")]
    [InlineData("../fixtures/blank-service.oml")]
    [InlineData("blank-service.oml")]
    public void FixturesResolveAgainstRepositoryOrJobDirectory(string spec)
        => Assert.Equal(Path.Combine(Root, "tests", "fixtures", "blank-service.oml"),
            JobSources.Resolve(spec, JobDir, "base").Path);

    /// <summary>A job kept outside the repository (a lab folder, a temporary directory) still resolves `tests/fixtures/...`
    /// against the fixtures of the kernel that is running: the repository root comes from the running kernel when the
    /// job folder has none above it. Absolute paths outside the fixtures stay refused.</summary>
    [Theory]
    [InlineData("tests/fixtures/blank-service.oml")]
    [InlineData("blank-service.oml")]
    public void FixturesResolveForJobsOutsideTheRepository(string spec)
    {
        var outside = Path.Combine(Path.GetTempPath(), "anvil-job-outside-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(outside);
        try
        {
            Assert.Null(JobRunner.RepoRoot(outside));
            Assert.Equal(Path.Combine(Root, "tests", "fixtures", "blank-service.oml"), JobSources.FixturePath(spec, outside, "base"));
            Assert.Contains("outside tests/fixtures", Assert.Throws<ArgumentException>(() => JobSources.FixturePath(Path.Combine(outside, "snapshot.oml"), outside, "base")).Message);
        }
        finally { Directory.Delete(outside, true); }
    }

    [Theory]
    [InlineData(".local/jobs/producer-public.oml")]
    [InlineData("tests/fixtures/../../.local/jobs/old.oml")]
    [InlineData("tests/fixtures-other/old.oml")]
    public void MutablePathsAreRejectedWithoutNeedingTheFile(string spec)
    {
        var error = Assert.Throws<ArgumentException>(() => JobSources.FixturePath(spec, JobDir, "producer"));
        Assert.Contains("outside tests/fixtures", error.Message);
        Assert.Contains("--producer <Name>=<oml>", error.Message);
    }

    [Fact]
    public void SnapshotRequiresExplicitNamedBinding()
    {
        var snapshot = Path.Combine(Root, ".local", "snapshot.oml");
        Assert.Throws<ArgumentException>(() => JobSources.FixturePath(snapshot, JobDir, "producer"));
        Assert.Contains("producer Headless_CS not bound", Assert.Throws<ArgumentException>(
            () => JobSources.Resolve("Headless_CS", JobDir, "producer")).Message);
        var fixture = Path.Combine(Root, "tests", "fixtures", "blank-service.oml");
        var bindings = JobSources.ParseBindings(new[] { "Headless_CS=" + fixture });
        Assert.Equal(fixture, JobSources.Resolve("headless_cs", JobDir, "producer", bindings).Path);
    }

    [Fact]
    public void BindingsPreserveEqualsInPathsAndRejectMalformedOrDuplicateValues()
    {
        Assert.EndsWith("a=b.oml", JobSources.ParseBindings(new[] { "Module=a=b.oml" })["Module"]);
        foreach (var invalid in new[] { "Module", "=file.oml", "Module=", "../Module=x.oml" })
            Assert.Throws<ArgumentException>(() => JobSources.ParseBindings(new[] { invalid }));
        Assert.Throws<ArgumentException>(() => JobSources.ParseBindings(new[] { "Module=a.oml", "module=b.oml" }));
    }

    [Fact]
    public void JobLookupPrefersSiblingAndFallsBackToOfficialJobs()
    {
        var dir = Scratch();
        var sibling = Path.Combine(dir, "producer-public.json");
        File.WriteAllText(sibling, "{}");
        Assert.Equal(sibling, JobSources.Resolve("job:producer-public", dir, "base").Path);
        Assert.Equal(Path.Combine(JobDir, "spec-data.json"), JobSources.Resolve("job:spec-data", dir, "base").Path);
    }

    [Fact]
    public void CompositeCyclesFailWithoutStudio()
    {
        var dir = Scratch();
        File.WriteAllText(Path.Combine(dir, "a.json"), """{"jobs":["job:b"]}""");
        File.WriteAllText(Path.Combine(dir, "b.json"), """{"jobs":["job:a"]}""");
        var error = Assert.Throws<ArgumentException>(() => JobRunner.CollectOps(
            JsonNode.Parse(File.ReadAllText(Path.Combine(dir, "a.json")))!, dir));
        Assert.Contains("cycle", error.Message);
    }

    [Fact]
    public void ChainedAndCompositeSourcesResolveInTheirOwnDirectoryAndUsePrivateWork()
    {
        if (!StudioAvailable()) return;
        var dir = Scratch();
        var nested = Path.Combine(dir, "nested");
        Directory.CreateDirectory(nested);
        var fixture = Path.Combine(Root, "tests", "fixtures", "blank-service.oml");
        File.Copy(fixture, Path.Combine(nested, "snapshot.oml"));
        var bindings = JobSources.ParseBindings(new[] { "Snapshot=" + Path.Combine(nested, "snapshot.oml") });
        // O mesmo nome no consumidor seria uma base errada; so o seed IRMAO e valido.
        File.WriteAllText(Path.Combine(dir, "seed.json"), """{"base":"WrongBinding","ops":[]}""");
        File.WriteAllText(Path.Combine(nested, "seed.json"), """{"base":"Snapshot","ops":[]}""");
        File.WriteAllText(Path.Combine(nested, "producer.json"), """
            {"base":"job:seed","ops":[{"op":"spec","data":{"structures":[{"name":"PortableRecord","public":true,"attributes":[{"name":"Title","type":"Text"}]}]}}]}
            """);
        File.WriteAllText(Path.Combine(nested, "part.json"), """
            {"base":"IgnoredBinding","ops":[{"op":"reference","producer":"job:producer","elements":["IStructure:PortableRecord"]}]}
            """);
        var job = Path.Combine(dir, "consumer.json");
        File.WriteAllText(job, """{"base":"Snapshot","jobs":["nested/part.json"]}""");
        var work = Path.Combine(dir, "work");
        var host = new ModelHost(work);
        var logs = new List<string>();
        var output = Path.Combine(dir, "consumer.oml");
        var result = JsonSerializer.SerializeToNode(JobRunner.Run(host, null, job, output, logs.Add, bindings))!;
        Assert.True(result["isValid"]!.GetValue<bool>(), result["details"]!.ToJsonString());
        Assert.True(host.Inspect(output).IsValid);
        Assert.Equal(2, Directory.GetFiles(Path.Combine(work, "producers"), "*.oml", SearchOption.AllDirectories).Length);
        var first = Directory.GetDirectories(Path.Combine(work, "producers")).Single();
        JobRunner.Run(host, null, job, Path.Combine(dir, "again.oml"), bindings: bindings);
        Assert.Equal(2, Directory.GetDirectories(Path.Combine(work, "producers")).Length);
        Assert.True(Directory.Exists(first));
        Assert.Equal(0, ModelHost.LoadedModules().Count);
    }

    [Fact]
    public void ExplicitBaseOverridesJsonAndDependencyCyclesFailWithoutSavingConsumer()
    {
        if (!StudioAvailable()) return;
        var dir = Scratch();
        var host = new ModelHost(Path.Combine(dir, "work"));
        var job = Path.Combine(dir, "consumer.json");
        var fixture = Path.Combine(Root, "tests", "fixtures", "blank-service.oml");
        File.WriteAllText(job, """{"base":".local/forbidden.oml","ops":[]}""");
        var output = Path.Combine(dir, "override.oml");
        JobRunner.Run(host, fixture, job, output);
        Assert.True(File.Exists(output));
        File.WriteAllText(job, """{"base":"job:dependency","ops":[]}""");
        File.WriteAllText(Path.Combine(dir, "dependency.json"), """{"base":"job:consumer","ops":[]}""");
        var failed = Path.Combine(dir, "failed.oml");
        Assert.Contains("job dependency cycle", Assert.Throws<ArgumentException>(
            () => JobRunner.Run(host, null, job, failed)).Message);
        Assert.False(File.Exists(failed));
        Assert.Equal(0, ModelHost.LoadedModules().Count);
    }

    [Fact]
    public void MissingProducerInCompositeReportsGlobalOpIndexAndSavesNothing()
    {
        if (!StudioAvailable()) return;
        var dir = Scratch();
        var host = new ModelHost(Path.Combine(dir, "work"));
        File.WriteAllText(Path.Combine(dir, "first.json"), """{"ops":[{"op":"find","name":"A"},{"op":"find","name":"B"}]}""");
        File.WriteAllText(Path.Combine(dir, "second.json"), """{"ops":[{"op":"find","name":"C"},{"op":"reference","producer":"Missing","elements":[]}]}""");
        var job = Path.Combine(dir, "consumer.json");
        File.WriteAllText(job, """{"base":"blank-service.oml","jobs":["job:first","job:second"]}""");
        var output = Path.Combine(dir, "consumer.oml");
        var error = Assert.Throws<InvalidOperationException>(() => JobRunner.Run(host, null, job, output));
        var (_, message, _) = Errors.Describe(error);
        Assert.StartsWith("op #3 (reference)", message);
        Assert.Contains("producer Missing not bound", error.Message);
        Assert.False(File.Exists(output));
        Assert.Equal(0, ModelHost.LoadedModules().Count);
    }

    private static string Scratch()
    {
        var dir = Path.Combine(Root, ".local", "source-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static bool StudioAvailable()
    {
        try { StudioAssemblies.Bind(null); return Directory.Exists(StudioAssemblies.Directory ?? ""); } catch { return false; }
    }

    private static string FindRoot()
    {
        var dir = Path.GetDirectoryName(typeof(JobSourceTests).Assembly.Location);
        while (dir != null && !File.Exists(Path.Combine(dir, "MANIFESTO.md"))) dir = Path.GetDirectoryName(dir);
        return dir!;
    }
}
