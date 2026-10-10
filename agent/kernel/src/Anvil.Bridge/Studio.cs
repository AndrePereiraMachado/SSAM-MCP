using System.Reflection;
using OutSystems.Communication.ServiceCenter;
using ServiceStudio.Model;
using ServiceStudio.Presenter;

namespace Anvil.Bridge;

/// <summary>Acesso ao Studio vivo pela sua propria API: Runtime.Instance -> aggregators -> modulo ativo.</summary>
internal static class Studio
{
    private const BindingFlags All = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static;

    /// <summary>Todos os aggregator presenters abertos (cada aba de modulo e um).</summary>
    public static IReadOnlyList<IAggregatorPresenter> Aggregators()
    {
        var rt = ServiceStudio.Runtime.Instance as RuntimeImplementation;
        var all = rt?.GetAllAggregators() ?? Enumerable.Empty<IBaseAggregatorPresenter>();
        return all.OfType<IAggregatorPresenter>().ToList();
    }

    /// <summary>O aggregator com modulo aberto (o ativo primeiro).</summary>
    public static IAggregatorPresenter? ActiveAggregator()
    {
        // a aba selecionada na janela e o modulo ativo; so depois o primeiro com modulo aberto
        var rt = ServiceStudio.Runtime.Instance as RuntimeImplementation;
        var selected = rt?.AggregatorWindows.Select(w => w.SelectedTopLevelPresenter).OfType<IAggregatorPresenter>().FirstOrDefault(a => a.ActiveESpace != null);
        if (selected != null) return selected;
        var aggs = Aggregators();
        return aggs.FirstOrDefault(a => a.HasOpenedActiveESpace && a.ActiveESpace != null)
            ?? aggs.FirstOrDefault(a => a.ActiveESpace != null)
            ?? aggs.FirstOrDefault();
    }

    public static (IAggregatorPresenter Aggregator, ESpace ESpace) Active()
    {
        var a = ActiveAggregator() ?? throw new InvalidOperationException("no aggregator presenter: open the environment in the Studio first");
        var e = a.ActiveESpace ?? throw new InvalidOperationException("no module open in the Studio");
        return (a, e);
    }

    /// <summary>C41: the module a call names by module_key, in any tab, not only the selected one: the aggregator whose
    /// ActiveESpace.Key is module_key (and on the requested environment, when given), an opened one first. Without module_key,
    /// Active(). A key no open tab has refuses before anything runs. Capability merge_from_oml:module_key.</summary>
    public static (IAggregatorPresenter Aggregator, ESpace ESpace) Target(System.Text.Json.Nodes.JsonObject? parameters)
    {
        var key = parameters?["module_key"]?.ToString();
        if (string.IsNullOrEmpty(key)) return Active();
        var environment = parameters?["environment"]?.ToString();
        var active = ActiveAggregator();
        if (active?.ActiveESpace is { } selected && selected.Key.ToString() == key) return (active, selected);
        var match = Aggregators().Where(a => a.ActiveESpace?.Key.ToString() == key
                && (environment == null || string.Equals(EnvironmentHost(a), environment, StringComparison.OrdinalIgnoreCase)))
            .OrderByDescending(a => a.HasOpenedActiveESpace).FirstOrDefault();
        if (match?.ActiveESpace is { } module) return (match, module);
        throw new InvalidOperationException("Requested module identity is not open in any Studio tab; nothing was executed");
    }

    /// <summary>Providers with a logged user. An open module may own a different provider instance from its window;
    /// both belong to the live Studio session.</summary>
    public static object[] LoggedInProviders()
    {
        var runtime = ServiceStudio.Runtime.Instance as RuntimeImplementation;
        if (runtime == null) return [];
        return runtime.AggregatorWindows.Select(w => (object?)w.ServerCommunicationsProvider)
            .Concat(Aggregators().Select(a => (object?)a.ServerCommunicationsProvider))
            .Where(p => p != null && Prop(Prop(p, "LoginInfo"), "UserName") is string user && !string.IsNullOrWhiteSpace(user))
            .Cast<object>().Distinct(ReferenceEqualityComparer.Instance).ToArray();
    }

    public static string? ProviderHost(object provider) => Prop(Prop(Prop(provider, "LoginInfo"), "HostInfo"), "HostName")?.ToString();

    /// <summary>IServiceCenter do provider: ServiceCenterAPI e protegido, por isso reflexao aqui.</summary>
    internal static IServiceCenter? ServiceCenterApi(object provider)
    {
        var candidates = new List<object> { provider };
        var concrete = provider.GetType().GetMethods(All).FirstOrDefault(x => x.Name == "Concrete" && x.GetParameters().Length == 0)?.Invoke(provider, null);
        if (concrete != null) candidates.Add(concrete);
        foreach (var c in candidates)
        {
            foreach (var name in new[] { "ServiceCenterAPI", "ServiceCenterApi" })
                if (Studio.Prop(c, name) is IServiceCenter sc) return sc;
            var comm = Studio.Prop(c, "CommunicationsApi");
            if (comm != null && (Studio.Prop(comm, "ServiceCenterApi") ?? Studio.Prop(comm, "ServiceCenterAPI")) is IServiceCenter sc2) return sc2;
        }
        return null;
    }

    public static string? EnvironmentHost(IAggregatorPresenter aggregator)
    {
        var login = Prop(aggregator.ServerCommunicationsProvider, "LoginInfo");
        return Prop(Prop(login, "HostInfo"), "HostName")?.ToString()?.ToLowerInvariant();
    }

    public static void RequireTarget(IAggregatorPresenter aggregator, ESpace module, System.Text.Json.Nodes.JsonObject? parameters)
    {
        if (parameters?["module_key"] is { } key && key.ToString() != module.Key.ToString())
            throw new InvalidOperationException("Requested module identity is no longer active; nothing was executed");
        if (parameters?["environment"] is { } environment && !string.Equals(environment.ToString(), EnvironmentHost(aggregator), StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Requested environment is no longer active; nothing was executed");
    }

    public static object? Prop(object? obj, string name)
    {
        if (obj == null) return null;
        var t = obj.GetType();
        var p = t.GetProperty(name, All);
        if (p == null) foreach (var i in t.GetInterfaces()) { p = i.GetProperty(name); if (p != null) break; }
        if (p != null) { try { return p.GetValue(obj); } catch { return null; } }
        return t.GetField(name, All)?.GetValue(obj);
    }

    public static bool? Flag(object obj, params string[] names)
    {
        foreach (var n in names) if (Prop(obj, n) is bool b) return b;
        return null;
    }
}
