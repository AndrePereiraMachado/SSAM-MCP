using System.Collections.Concurrent;
using System.Reflection;

namespace Anvil.Core;

/// <summary>
/// Headless bootstrap of the ODC Studio feature provider (ServiceStudio.Common.FeatureManagement.FeaturesProvider).
/// Parts of the model (aggregates, for one) ask the provider whether a feature is on and throw "Provider not
/// initialized." otherwise. The Studio fills it from the server; headless we feed it the local cache the installed
/// Studio keeps in %LocalAppData%\OutSystems\ODC Studio\Features.xml (plus FeaturesOverride.xml when present), copied
/// into the work directory, with the Studio's own encryption service. Same steps as SSAM-Hybrid-ODC's builder
/// (studio\engine\NativeFeatureBootstrap.cs), which delivered with it. Idempotent; no remote source is contacted.
/// Linux (the ssam-server image): the Studio's encryption service there is ASP.NET Core Data Protection with its key ring
/// in the folder it is given, so the Features.xml a Windows Studio wrote (DPAPI, user scope) cannot be read ("The provided
/// payload cannot be decrypted because it was not protected with this protection provider", seen in the Docker Desktop
/// rehearsal). There the owner drops the DECRYPTED cache as Features.plain.xml (server/deploy/odc-features-export.ps1 on
/// the Windows machine whose ODC Studio signed in), and it is encrypted here with the service of the work folder before the
/// provider reads it. Windows is unchanged.
/// </summary>
public static class OdcFeatures
{
    private static readonly object Gate = new();
    public const string PlainCacheFile = "Features.plain.xml";

    public static string CacheDirectory =>
        Environment.GetEnvironmentVariable("ANVIL_ODC_FEATURES_DIR")
        ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "OutSystems", "ODC Studio");

    public static void Initialize(string workDirectory)
    {
        lock (Gate)
        {
            var common = Assembly.Load("ServiceStudio.Common");
            var providerType = common.GetType("ServiceStudio.Common.FeatureManagement.FeaturesProvider", throwOnError: true)!;
            if ((bool)providerType.GetProperty("IsInitialized")!.GetValue(null)!) return;
            var source = Path.Combine(CacheDirectory, "Features.xml");
            var plain = Path.Combine(CacheDirectory, PlainCacheFile);
            var fromPlain = !OperatingSystem.IsWindows() && File.Exists(plain);
            if (!fromPlain && !File.Exists(source))
                throw new FileNotFoundException(OperatingSystem.IsWindows()
                    ? "ODC Studio feature cache not found; open the ODC Studio once on this machine (or set ANVIL_ODC_FEATURES_DIR)."
                    : "ODC Studio feature cache not found: put " + PlainCacheFile + " (server/deploy/odc-features-export.ps1) in ANVIL_ODC_FEATURES_DIR.", OperatingSystem.IsWindows() ? source : plain);
            var folder = OwnFolder(workDirectory);
            if (!fromPlain) CopyShared(source, Path.Combine(folder, "Features.xml"));
            var overrideSource = Path.Combine(CacheDirectory, "FeaturesOverride.xml");
            if (File.Exists(overrideSource)) CopyShared(overrideSource, Path.Combine(folder, "FeaturesOverride.xml"));

            var encryptionAssembly = Assembly.Load("OutSystems.ServiceStudio.Encryption");
            var encryptionInterface = encryptionAssembly.GetType("OutSystems.ServiceStudio.Encryption.IEncryptionService", throwOnError: true)!;
            var productType = encryptionAssembly.GetType("OutSystems.ServiceStudio.Encryption.ProductIdentifier", throwOnError: true)!;
            var factory = encryptionAssembly.GetType("OutSystems.ServiceStudio.Encryption.EncryptionServiceFactory", throwOnError: true)!;
            var encryption = factory.GetMethod("GetEncryptionService")!.Invoke(null, [folder, Enum.Parse(productType, "OdcStudio")]);
            if (fromPlain)
            {
                var encrypt = encryptionInterface.GetMethod("Encrypt", [typeof(string)])
                    ?? encryption!.GetType().GetMethod("Encrypt", [typeof(string)])
                    ?? throw new MissingMethodException("OutSystems.ServiceStudio.Encryption.IEncryptionService", "Encrypt(string)");
                File.WriteAllText(Path.Combine(folder, "Features.xml"), (string)encrypt.Invoke(encryption, [File.ReadAllText(plain)])!);
            }
            var constructorType = typeof(Func<>).MakeGenericType(encryptionInterface);
            var constructor = System.Linq.Expressions.Expression.Lambda(constructorType, System.Linq.Expressions.Expression.Constant(encryption, encryptionInterface)).Compile();
            common.GetType("ServiceStudio.Common.EncryptionService", throwOnError: true)!.GetMethod("SetInstance")!.Invoke(null, [constructor, null]);

            var configurationType = common.GetType("ServiceStudio.Common.FeatureManagement.FeaturesProviderConfiguration", throwOnError: true)!;
            using var http = new HttpClient();
            Func<string> empty = () => "";
            var configuration = Activator.CreateInstance(configurationType, [empty, empty, empty, folder, empty, http, false, null])!;
            var errors = new ConcurrentQueue<Exception>();
            var ready = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            Action onReady = () => ready.TrySetResult();
            var signal = providerType.GetEvent("InitializeAndLoad")!;
            signal.AddEventHandler(null, onReady);
            try
            {
                providerType.GetMethod("Initialize")!.Invoke(null, [configuration, (Action<Exception>)(error => errors.Enqueue(error))]);
                ready.Task.WaitAsync(TimeSpan.FromSeconds(30)).GetAwaiter().GetResult();
                if (!errors.IsEmpty) throw new AggregateException("ODC feature provider could not load the local cache.", errors);
            }
            finally { signal.RemoveEventHandler(null, onReady); }
        }
    }

    internal const string FolderOwnerFile = "owner.lock";
    private static (FileStream Owner, string Folder)? _own; // the owner file stays open for the life of the process; the OS closes it when it ends

    /// <summary>The folder the feature provider reads, owned by this process alone. Every process with the same work
    /// directory (the default %TEMP%\anvil-odc-work) used one shared &lt;work&gt;\odc-features, and the Studio's provider opens
    /// its Features.xml for reading and writing with no sharing, then writes it back (61,108 B copied, 36,320 B left). Two
    /// processes starting together therefore failed one of them with "The process cannot access the file ...\odc-features\
    /// Features.xml because it is being used by another process": on the copy (marco-a2, 2026-10-13) and, after the copy
    /// was made to retry, on the provider's own load (marco-a3, 2026-10-14: ssam-code-edits E5 with 4 CLIs; the lock above is
    /// per process). Each process takes the first numbered folder &lt;work&gt;\odc-features\&lt;n&gt; whose owner file it can open
    /// exclusively and keeps that file open until it ends, so no folder is ever read by two live processes, and there are
    /// never more folders than processes that ran at the same time (a folder is reused once its owner has ended).</summary>
    private static string OwnFolder(string workDirectory)
    {
        if (_own is { } own) return own.Folder; // a retried Initialize in the same process keeps its folder
        var owner = TakeFolder(Path.Combine(workDirectory, "odc-features"), out var folder);
        _own = (owner, folder);
        return folder;
    }

    /// <summary>Opens, with no sharing, the owner file of the first numbered folder under <paramref name="root"/> that no
    /// open owner holds, and returns it; the folder is the caller's while the returned stream stays open.</summary>
    internal static FileStream TakeFolder(string root, out string folder)
    {
        for (var slot = 0; slot < 1024; slot++)
        {
            folder = Path.Combine(root, slot.ToString(System.Globalization.CultureInfo.InvariantCulture));
            Directory.CreateDirectory(folder);
            try { return new FileStream(Path.Combine(folder, FolderOwnerFile), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException) { } // a live process owns it
        }
        throw new IOException("No free ODC feature folder under " + root + ": 1024 live processes own one each.");
    }

    /// <summary>Copies the Studio's cache into this process's own folder (<see cref="OwnFolder"/>): only when the bytes differ,
    /// and a sharing violation (an antivirus or indexer scanning the file) is retried with backoff, bounded (about 9 s).</summary>
    private static void CopyShared(string source, string destination)
    {
        var bytes = File.ReadAllBytes(source);
        for (var attempt = 0; ; attempt++)
        {
            try
            {
                if (File.Exists(destination) && File.ReadAllBytes(destination).AsSpan().SequenceEqual(bytes)) return;
                File.Copy(source, destination, overwrite: true);
                return;
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException && attempt < 40)
            {
                Thread.Sleep(Math.Min(250, 10 << Math.Min(attempt, 5)));
            }
        }
    }
}
