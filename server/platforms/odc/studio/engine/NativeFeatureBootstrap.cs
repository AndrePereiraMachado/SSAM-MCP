using System.Collections.Concurrent;
using System.Reflection;
using System.Security.Cryptography;

internal static class NativeFeatureBootstrap {
    public static object Initialize(string evidenceDirectory) {
        var assembly = Assembly.Load("ServiceStudio.Common");
        var providerType = assembly.GetType("ServiceStudio.Common.FeatureManagement.FeaturesProvider", throwOnError: true)!;
        if((bool)providerType.GetProperty("IsInitialized")!.GetValue(null)!) throw new InvalidOperationException("Unexpected preinitialized Studio feature provider.");
        var configurationType = assembly.GetType("ServiceStudio.Common.FeatureManagement.FeaturesProviderConfiguration", throwOnError: true)!;
        // The kernel's rule (OdcFeatures.CacheDirectory): ANVIL_ODC_FEATURES_DIR when set, and then Features.xml must be
        // there, never taken from the installed Studio's cache instead; unset, the installed Studio's cache, as before.
        var configured = Environment.GetEnvironmentVariable("ANVIL_ODC_FEATURES_DIR");
        var source = Path.Combine(configured ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "OutSystems", "ODC Studio"), "Features.xml");
        if(configured != null && (string.IsNullOrWhiteSpace(configured) || !Path.IsPathFullyQualified(configured) || !File.Exists(source)))
            throw new FileNotFoundException("ODC Studio feature cache not found in ANVIL_ODC_FEATURES_DIR: " + configured, source);
        if(!File.Exists(source)) throw new FileNotFoundException("Local Studio feature cache required for the authorship proof.", source);
        var folder = Path.Combine(evidenceDirectory, "native-feature-cache");
        Directory.CreateDirectory(folder);
        var bytes = File.ReadAllBytes(source);
        File.WriteAllBytes(Path.Combine(folder, "Features.xml"), bytes);
        var overrideSource = Path.Combine(Path.GetDirectoryName(source)!, "FeaturesOverride.xml");
        string? overrideHash = null;
        if(File.Exists(overrideSource)) {
            var overrides = File.ReadAllBytes(overrideSource);
            File.WriteAllBytes(Path.Combine(folder, "FeaturesOverride.xml"), overrides);
            overrideHash = Convert.ToHexString(SHA256.HashData(overrides));
        }
                if(!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("This native configuration bootstrap was verified on Windows only.");
        var encryptionAssembly = Assembly.Load("OutSystems.ServiceStudio.Encryption");
        var encryptionInterface = encryptionAssembly.GetType("OutSystems.ServiceStudio.Encryption.IEncryptionService", true)!;
        var productType = encryptionAssembly.GetType("OutSystems.ServiceStudio.Encryption.ProductIdentifier", true)!;
        var factory = encryptionAssembly.GetType("OutSystems.ServiceStudio.Encryption.EncryptionServiceFactory", true)!;
        var encryption = factory.GetMethod("GetEncryptionService")!.Invoke(null, new object[] { folder, Enum.Parse(productType, "OdcStudio") });
        var constructorType = typeof(Func<>).MakeGenericType(encryptionInterface);
        var constructor = System.Linq.Expressions.Expression.Lambda(constructorType, System.Linq.Expressions.Expression.Constant(encryption, encryptionInterface)).Compile();
        assembly.GetType("ServiceStudio.Common.EncryptionService", true)!.GetMethod("SetInstance")!.Invoke(null, new object?[] { constructor, null });
        using var http = new HttpClient();
        Func<string> empty = () => "";
        var configuration = Activator.CreateInstance(configurationType, new object?[] { empty, empty, empty, folder, empty, http, false, null })!;
        var errors = new ConcurrentQueue<Exception>();
        var ready = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        Action onReady = () => ready.TrySetResult();
        var signal = providerType.GetEvent("InitializeAndLoad")!;
        signal.AddEventHandler(null, onReady);
        try {
            providerType.GetMethod("Initialize")!.Invoke(null, new object[] { configuration, (Action<Exception>)(error => errors.Enqueue(error)) });
            ready.Task.WaitAsync(TimeSpan.FromSeconds(30)).GetAwaiter().GetResult();
            if(!errors.IsEmpty) throw new AggregateException("Native feature provider could not load the local configuration.", errors);
        } finally { signal.RemoveEventHandler(null, onReady); }
        return new { initialized = true, remoteSources = false, copiedLocalCacheSha256 = Convert.ToHexString(SHA256.HashData(bytes)), copiedOverrideSha256 = overrideHash };
    }
}
