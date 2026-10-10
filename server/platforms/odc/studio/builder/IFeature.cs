using OutSystems.Model;
using OutSystems.Model.Enumerations;

// One class per feature, placed under builder\features. The builder discovers implementations
// by reflection and selects one by Name, so adding a feature is one file and one build,
// never a new project. Module key, tenant and author come from snapshots\modules.json unless
// a feature overrides them. Address targets with ModelPath, never with keys copied from old receipts.
internal interface IFeature {
    string Name { get; }
    string Module { get; }
    string? ModuleKey => null;
    string? Author => null;
    string? Tenant => null;
    string Transaction { get; }
    // Top-level element names whose empty grid metadata the native merge may add (see NativeMergeVerification).
    string[] Owners => Array.Empty<string>();
    string[] Changes { get; }
    void Apply(IESpace model);
    // Features that need more than the module itself (a producer's published model, the output directory)
    // override this overload; the default forwards to Apply(model).
    void Apply(IESpace model, BuildContext context) => Apply(model);
    // Return the labels of the checks that passed; throw on failure. Blocking for the builder, informative for the bridge.
    IEnumerable<string> Verify(IESpace model);
}

// A feature that creates a module instead of changing one. The builder runs it with the verb "new":
// the module is created headlessly with the native CreateESpace, the feature fills it, and the bridge
// command "create" uploads the candidate as a new asset of the tenant through the native CreateAsset.
internal interface INewModule : IFeature {
    SegmentationKind Kind { get; }
}

// What a feature may consult besides the module: the model services, the evidence output directory and,
// when the builder was given --producer, the producer model loaded read-only in the same services.
internal sealed record BuildContext(IModelServices Services, string Output, string? ProducerPath, IESpace? Producer);

// Resolved identity of a feature run: module key, tenant and author after catalog lookup.
internal sealed record FeatureIdentity(string Module, string ModuleKey, string Tenant, string Author);
