namespace Anvil.Core;

/// <summary>The public reference families understood by O11 signatures. Private model elements
/// (timers, site properties and action nodes) are deliberately not referenceable.</summary>
public static class NativeReferenceKinds
{
    public sealed record Family(string Kind, string Tag, string Interface, params string[] Aliases) {
        public bool SignatureImport => Kind is not ("web-theme" or "mobile-theme");
    }
    public static readonly IReadOnlyList<Family> All = Array.AsReadOnly(new[] {
        new Family("action", "ReferenceAction", "IServerActionSignature", "IServerAction"),
        new Family("entity", "ReferenceEntity", "IEntitySignature", "IServerEntity", "IServerEntitySignature", "IStaticEntity", "IStaticEntitySignature", "IClientEntity", "IClientEntitySignature"),
        new Family("structure", "ReferenceStructure", "IStructureSignature", "IStructure"),
        new Family("service-action", "ReferenceServiceAPIMethod", "IServiceActionSignature", "IServiceAction"),
        new Family("client-action", "ReferenceClientAction", "IClientActionSignature", "IClientAction"),
        new Family("role", "ReferenceRole", "IRoleSignature", "IRole"),
        new Family("image", "ReferenceImage", "IImageSignature", "IImage"),
        new Family("resource", "ReferenceResource", "IResourceSignature", "IResource"),
        new Family("script", "ReferenceScript", "IScriptSignature", "IScript"),
        new Family("process", "ReferenceProcess", "IProcessSignature", "IProcess"),
        new Family("web-theme", "ReferenceTheme", "IWebThemeSignature", "IWebTheme"),
        new Family("mobile-theme", "NewRuntime.ReferenceTheme", "IMobileThemeSignature", "IMobileTheme"),
        new Family("web-flow", "ReferenceWebFlow", "IWebFlowSignature", "IWebFlow"),
        new Family("mobile-flow", "NewRuntime.ReferenceWebFlow", "IMobileFlowSignature", "IMobileFlow"),
        new Family("web-block", "ReferenceWebBlock", "IWebBlockSignature", "IWebBlock"),
        new Family("mobile-block", "NewRuntime.ReferenceWebBlock", "IMobileBlockSignature", "IBlockSignature", "IBlock", "IMobileBlock"),
        new Family("web-screen", "ReferenceWebScreen", "IWebScreenSignature", "IWebScreen"),
        new Family("mobile-screen", "NewRuntime.ReferenceWebScreen", "IMobileScreenSignature", "IScreenSignature", "IScreen", "IMobileScreen")
    });
    public static Family? ForType(string type) => All.SingleOrDefault(f => f.Interface == type || f.Aliases.Contains(type));
    public static Family? ForTag(string tag) => All.SingleOrDefault(f => f.Tag == tag);
    public static Family ForKind(string kind) => All.SingleOrDefault(f => f.Kind == kind)
        ?? throw new ArgumentException("Unsupported producer element kind: " + kind);
}
