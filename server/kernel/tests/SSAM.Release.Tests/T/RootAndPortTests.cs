extern alias odccore;
extern alias odcbuilder;

using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.Loader;
using System.Text.Json.Nodes;
using Anvil.Core;
using Anvil.Core.Delivery;
using Ssam.Runtime;
using Xunit;
using BuilderStore = odcbuilder::Anvil.Reading.ModuleIndexStore;
using OdcDeliveryTask = odccore::Anvil.Core.Delivery.DeliveryTask;
using OdcJobRunner = odccore::Anvil.Core.JobRunner;
using OdcJobSources = odccore::Anvil.Core.JobSources;
using OdcSessions = odccore::Anvil.Core.Delivery.AppSessions;
using OdcStore = odccore::Anvil.Reading.ModuleIndexStore;
using Store = Anvil.Reading.ModuleIndexStore;

namespace SSAM.Release.Tests.T;

/// <summary>Kernel root and ports of the release build (overlays of lane T): the module index in the lane data root, the
/// kernel root found by release.json (&lt;release&gt;\app\data), never a repository nor the current directory, and the
/// delivery port of the runtime contract, never a fixed 4516/4536. Always on a temporary profile (TempProfile); no test
/// opens a fixed port (one asks the system for an ephemeral port number and closes it at once).</summary>
[Collection(EnvironmentCollection.Name)]
public sealed class RootAndPortTests
{
    private const string Sha = "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789";

    // Anvil.Core, Anvil.Core.Odc and ODC3.Builder all compile ModuleIndex.cs: every answer is checked on the three copies.
    private static readonly (string Assembly, string Lane, string Adapter, Func<(string Root, string Lane, string Adapter, string File)?> Default)[] Stores =
    {
        ("Anvil.Core", "o11", "kernel", () => Store.Default() is { } s ? (s.Root, s.Lane, s.Adapter, s.PathOf(Sha)) : null),
        ("Anvil.Core.Odc", "odc", "kernel", () => OdcStore.Default() is { } s ? (s.Root, s.Lane, s.Adapter, s.PathOf(Sha)) : null),
        ("ODC3.Builder", "odc", "builder", () => BuilderStore.Default() is { } s ? (s.Root, s.Lane, s.Adapter, s.PathOf(Sha)) : null),
    };

    [Fact]
    public void Module_index_lives_in_the_lane_data_root_never_in_the_workspace_above_the_assembly()
    {
        using var profile = new TempProfile();
        using var variable = new Variable("SSAM_MODULE_INDEX_ROOT", null);
        // The checkout code would take <workspace>\.local\module-index: the staging has the marker above this assembly.
        Assert.NotNull(Above(Path.GetDirectoryName(typeof(Store).Assembly.Location)!, ".ssam-workspace.json"));
        foreach (var (assembly, lane, adapter, open) in Stores)
        {
            var store = open() ?? throw new Xunit.Sdk.XunitException(assembly + ": no module index store");
            var expected = Path.Combine(profile.Profile, ".ssam-hybrid", "data", lane, "module-index");
            Assert.Equal((expected, lane, adapter), (store.Root, store.Lane, store.Adapter));
            Assert.Equal(Path.Combine(RuntimeContract.LaneDataDir(lane), "module-index"), store.Root);
            Assert.Equal(Path.Combine(expected, Store.Generation, lane, Sha.ToLowerInvariant() + "." + adapter + ".json"), store.File);
        }
    }

    [Fact]
    public void An_absolute_module_index_variable_wins_and_a_relative_one_gives_no_index()
    {
        using var profile = new TempProfile();
        var given = Path.Combine(profile.Root, "given-index");
        using var variable = new Variable("SSAM_MODULE_INDEX_ROOT", given);
        foreach (var (_, lane, adapter, open) in Stores) Assert.Equal((given, lane, adapter), open() is { } s ? (s.Root, s.Lane, s.Adapter) : default);
        Environment.SetEnvironmentVariable("SSAM_MODULE_INDEX_ROOT", "relative-index");
        foreach (var (_, _, _, open) in Stores) Assert.Null(open());
    }

    [Fact]
    public void The_kernel_root_is_the_data_folder_of_the_release_found_by_release_json()
    {
        using var profile = new TempProfile();
        var release = FakeRelease(profile);
        var data = Path.Combine(release, "app", "data");
        var part = Write(Path.Combine(data, "tests", "jobs", "part.json"), "{\"ops\":[]}");
        var fixture = Write(Path.Combine(data, "tests", "fixtures", "blank-service.oml"), "oml");
        var odcJobs = Directory.CreateDirectory(Path.Combine(data, "tests", "jobs-odc")).FullName;
        Write(Path.Combine(data, "catalog", "verify-hints-t.json"), "[{\"id\":\"T-1\",\"hint\":\"from app\\\\data\",\"origin\":\"lane T\"}]");

        Assert.Equal(part, JobRunner.ResolveJobFile("job:part", odcJobs));
        Assert.Equal(part, OdcJobRunner.ResolveJobFile("job:part", odcJobs));
        Assert.Equal(part, Path.GetFullPath(JobRunner.ResolveJobFile("tests/jobs/part.json", Path.Combine(release, "studio", "o11", "bridge", "b1"))));
        Assert.Equal(fixture, JobSources.FixturePath("tests/fixtures/blank-service.oml", odcJobs, "base"));
        Assert.Equal(fixture, JobSources.FixturePath("blank-service.oml", odcJobs, "base"));
        Assert.Equal(fixture, OdcJobSources.FixturePath("tests/fixtures/blank-service.oml", odcJobs, "base"));
        Assert.Equal(fixture, JobSources.Resolve("tests/fixtures/blank-service.oml", odcJobs, "base").Path);

        // Readers of catalog\ that look from the current directory (VerifyHints, ApiCatalog) reach the same data root.
        using (new CurrentDirectory(Path.Combine(release, "studio", "o11", "bridge", "b1")))
            Assert.Equal("from app\\data", VerifyHints.Read()["T-1"].Hint);
    }

    [Fact]
    public void A_repository_and_the_current_directory_are_never_a_kernel_root()
    {
        using var profile = new TempProfile();
        // A checkout as the checkout code sees it: MANIFESTO.md with tests\jobs and tests\fixtures below.
        var repository = Path.Combine(profile.Root, "repository");
        Write(Path.Combine(repository, "MANIFESTO.md"), "# kernel");
        Write(Path.Combine(repository, "tests", "jobs", "part.json"), "{\"ops\":[]}");
        Write(Path.Combine(repository, "tests", "fixtures", "blank-service.oml"), "oml");
        var jobs = Path.Combine(repository, "tests", "jobs");
        var odcJobs = Directory.CreateDirectory(Path.Combine(repository, "tests", "jobs-odc")).FullName;
        var release = FakeRelease(profile);

        // This test assembly (and the Anvil.Core next to it) is not inside a release.
        Assert.Null(RuntimeContract.FindReleaseRoot());
        foreach (var current in new[] { repository, release, Path.Combine(release, "app", "data") })
            using (new CurrentDirectory(current))
            {
                Assert.Null(JobSources.KernelRoot());
                Assert.Null(OdcJobSources.KernelRoot());
                Assert.Throws<FileNotFoundException>(() => JobRunner.ResolveJobFile("job:part", odcJobs));
                Assert.Throws<ArgumentException>(() => JobSources.FixturePath("tests/fixtures/blank-service.oml", jobs, "base"));
                Assert.Throws<ArgumentException>(() => OdcJobSources.FixturePath("blank-service.oml", jobs, "base"));
            }
        // A job in the folder itself is still found; only the root moved.
        Assert.Equal(Path.Combine(jobs, "part.json"), JobRunner.ResolveJobFile("job:part", jobs));
    }

    [Fact]
    public void The_kernel_root_follows_its_own_assembly_into_a_release_not_the_process_folder()
    {
        using var profile = new TempProfile();
        var release = FakeRelease(profile);
        var data = Path.Combine(release, "app", "data");
        // A copy of this release Anvil.Core where the CLI lives and where the O11 bridge lives inside a Studio; the
        // process (testhost) and the current directory stay outside the release.
        using (new CurrentDirectory(profile.Root))
            foreach (var folder in new[] { Path.Combine(release, "bin", "o11"), Path.Combine(release, "studio", "o11", "bridge", "b1") })
            {
                var copy = Path.Combine(Directory.CreateDirectory(folder).FullName, "Anvil.Core.dll");
                File.Copy(typeof(JobSources).Assembly.Location, copy);
                Assert.Equal(data, KernelRootOfCopy(copy));
            }
        Assert.Null(JobSources.KernelRoot());
    }

    [Fact]
    public void The_delivery_port_is_the_runtime_contract_port_never_the_fixed_port_of_the_lane()
    {
        using var profile = new TempProfile();
        foreach (var (_, prepare) in Deliveries)
        {
            // No config.json, no record: the first bridge port of the contract's default range (plan D10), for both
            // lanes; the checkout's fixed 4536 of ss5 is gone.
            Clear(profile);
            Assert.Equal(RuntimeContract.Ports.Bridges[0], prepare(Work(profile), "ss5"));
            Assert.Equal(RuntimeContract.Ports.Bridges[0], prepare(Work(profile), "ss4"));
            Assert.NotEqual(4536, prepare(Work(profile), "ss5"));

            // The range of config.json (one that is neither 4516 nor 4536).
            profile.Write(@".ssam-hybrid\config.json", "{\"ports\":{\"first\":52000,\"last\":52019}}");
            Assert.Equal(52000, prepare(Work(profile), "ss5"));
            Assert.Equal(52000, prepare(Work(profile), "ss4"));

            // The connection record's port, here a port number the system chose (ephemeral), closed at once.
            var ephemeral = EphemeralPort();
            profile.Write(@".ssam-hybrid\data\o11\connection.json", "{\"ok\":true,\"lane\":\"o11\",\"port\":" + ephemeral + "}");
            Assert.Equal(ephemeral, prepare(Work(profile), "ss5"));
            Assert.Equal(ephemeral, prepare(Work(profile), "ss4"));

            // The port the facade exports to its children comes first.
            Environment.SetEnvironmentVariable("ANVIL_BRIDGE_PORT", "52011");
            Assert.Equal(52011, prepare(Work(profile), "ss5"));
            Assert.Equal(52011, prepare(Work(profile), "ss4"));
        }
    }

    [Fact]
    public void An_invalid_configuration_or_record_refuses_the_delivery_before_anything_is_written()
    {
        using var profile = new TempProfile();
        foreach (var (_, prepare) in Deliveries)
            foreach (var (file, content) in new[] { (@".ssam-hybrid\config.json", "{\"ports\":{\"first\":52000,\"last\":52005}}"),
                (@".ssam-hybrid\data\o11\connection.json", "{ not json") })
            {
                Clear(profile);
                profile.Write(file, content);
                var work = Work(profile);
                Assert.Throws<InvalidOperationException>(() => prepare(work, "ss5"));
                Assert.False(Directory.Exists(Path.Combine(work, "contracts")));
                Assert.False(Directory.Exists(Path.Combine(work, "deliveries")));
            }
    }

    // Anvil.Core and Anvil.Core.Odc both compile AppSessions.cs: capture, propose and prepare on each copy, then read the
    // port the delivery task recorded.
    private static readonly (string Name, Func<string, string, int?> Prepare)[] Deliveries =
    {
        ("Anvil.Core", (directory, lane) =>
        {
            var sessions = new AppSessions(directory);
            var id = sessions.Capture(Input())["taskId"]!.ToString();
            sessions.Propose(id, Proposal(lane));
            var prepared = sessions.PrepareDelivery(id);
            return DeliveryTask.ResumeRequest(prepared["work"]!.ToString(), prepared["deliveryTaskId"]!.ToString()).BridgePort;
        }),
        ("Anvil.Core.Odc", (directory, lane) =>
        {
            var sessions = new OdcSessions(directory);
            var id = sessions.Capture(Input())["taskId"]!.ToString();
            sessions.Propose(id, Proposal(lane));
            var prepared = sessions.PrepareDelivery(id);
            return OdcDeliveryTask.ResumeRequest(prepared["work"]!.ToString(), prepared["deliveryTaskId"]!.ToString()).BridgePort;
        }),
    };

    private static JsonObject Input() => new() { ["session_id"] = "s", ["turn_id"] = "t", ["prompt"] = "Create Entry with Title Text 120" };

    private static JsonObject Proposal(string lane) => new()
    {
        ["module"] = "Probe", ["lane"] = lane, ["environment"] = "fixture.test",
        ["data"] = JsonNode.Parse("{\"entities\":[{\"name\":\"Entry\",\"attributes\":[{\"name\":\"Title\",\"type\":\"Text\",\"length\":120}]}]}"),
    };

    private static string Work(TempProfile profile) => Path.Combine(profile.Root, "app-sessions", Guid.NewGuid().ToString("N"));

    // No config.json, no connection record, no exported port.
    private static void Clear(TempProfile profile)
    {
        foreach (var file in new[] { Path.Combine(RuntimeContract.UserRoot, "config.json"), RuntimeContract.ConnectionFile("o11") })
            if (File.Exists(file)) File.Delete(file);
        Assert.StartsWith(profile.Root, RuntimeContract.UserRoot, StringComparison.OrdinalIgnoreCase);
        Environment.SetEnvironmentVariable("ANVIL_BRIDGE_PORT", null);
    }

    private static int EphemeralPort()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        try { return ((IPEndPoint)listener.LocalEndpoint).Port; }
        finally { listener.Stop(); }
    }

    private static string FakeRelease(TempProfile profile)
    {
        var release = Path.Combine(profile.Root, "releases", "2026.10.1");
        Write(Path.Combine(release, "release.json"), "{\"schema\":\"ssam-release/1\"}");
        Directory.CreateDirectory(Path.Combine(release, "studio", "o11", "bridge", "b1"));
        return release;
    }

    private static string Write(string file, string content)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        File.WriteAllText(file, content);
        return file;
    }

    private static string? Above(string folder, string marker)
    {
        for (var directory = new DirectoryInfo(folder); directory != null; directory = directory.Parent)
            if (File.Exists(Path.Combine(directory.FullName, marker))) return directory.FullName;
        return null;
    }

    // Loads the copy in its own collectible context (its references resolve from the default one), asks its
    // JobSources.KernelRoot, then unloads it so the temporary folder can be removed.
    private static string? KernelRootOfCopy(string copy)
    {
        var (root, context) = Ask(copy);
        for (var i = 0; context.IsAlive && i < 10; i++) { GC.Collect(); GC.WaitForPendingFinalizers(); }
        return root;
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static (string? Root, WeakReference Context) Ask(string copy)
    {
        var context = new AssemblyLoadContext("SSAM.Release.Tests.T " + Path.GetFileName(Path.GetDirectoryName(copy)), isCollectible: true);
        try
        {
            var assembly = context.LoadFromAssemblyPath(copy);
            Assert.Equal(copy, assembly.Location);
            var root = (string?)assembly.GetType("Anvil.Core.JobSources", throwOnError: true)!
                .GetMethod("KernelRoot", BindingFlags.Public | BindingFlags.Static)!.Invoke(null, null);
            return (root, new WeakReference(context));
        }
        finally { context.Unload(); }
    }

    private sealed class Variable : IDisposable
    {
        private readonly string name;
        private readonly string? saved;
        public Variable(string name, string? value)
        {
            this.name = name;
            saved = Environment.GetEnvironmentVariable(name);
            Environment.SetEnvironmentVariable(name, value);
        }
        public void Dispose() => Environment.SetEnvironmentVariable(name, saved);
    }

    private sealed class CurrentDirectory : IDisposable
    {
        private readonly string saved = Directory.GetCurrentDirectory();
        public CurrentDirectory(string folder) => Directory.SetCurrentDirectory(Directory.CreateDirectory(folder).FullName);
        public void Dispose() => Directory.SetCurrentDirectory(saved);
    }
}
