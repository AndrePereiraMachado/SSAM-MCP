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
            var folder = Path.Combine(workDirectory, "odc-features");
            Directory.CreateDirectory(folder);
            if (!fromPlain) File.Copy(source, Path.Combine(folder, "Features.xml"), overwrite: true);
            var overrideSource = Path.Combine(CacheDirectory, "FeaturesOverride.xml");
            if (File.Exists(overrideSource)) File.Copy(overrideSource, Path.Combine(folder, "FeaturesOverride.xml"), overwrite: true);

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
}
