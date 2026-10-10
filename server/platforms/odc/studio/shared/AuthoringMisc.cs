using OutSystems.Model;
using OutSystems.Model.Data;
using OutSystems.Model.Events;
using OutSystems.Model.Logic;
using OutSystems.Model.Processes;
using OutSystems.Model.Types;
using OutSystems.Model.UI;
using OutSystems.Model.UI.Mobile;
using ITimer = OutSystems.Model.Processes.ITimer;

// Scripts, timers, global events, site properties (settings), client variables, exceptions and roles.
internal static partial class Authoring {
    public static IScript Script(IESpace space, string name, string javaScript, string description, bool isPublic = false) {
        Require(!Walk(space).OfType<IScript>().Any(s => s.Name == name), "Script already exists: " + name);
        var script = space.CreateScript(name); script.JavaScript = javaScript; script.Description = description; script.Public = isPublic; return script;
    }
    public static void RequireScript(IMobileScreen screen, IScript script) { if (!screen.RequiredScripts.Contains(script)) screen.RequiredScripts.Add(script); }
    // A timer running a server action without parameters on a cron schedule (ODC uses cron expressions).
    public static ITimer Timer(IESpace space, string name, IServerAction action, string cron, string description, int timeoutMinutes = 20) {
        Require(!Walk(space).OfType<ITimer>().Any(t => t.Name == name), "Timer already exists: " + name);
        var timer = space.CreateTimer(name); timer.Description = description; timer.Action = action; timer.CronSchedule = cron; timer.TimeoutInMinutes = timeoutMinutes; return timer;
    }
    public static IGlobalEvent GlobalEvent(IESpace space, string name, string description, params (string Name, ITypeSignature Type)[] parameters) {
        Require(!Walk(space).OfType<IGlobalEvent>().Any(e => e.Name == name), "Global event already exists: " + name);
        var evt = space.CreateGlobalEvent(name); evt.Description = description; evt.Public = false;
        foreach (var (parameterName, type) in parameters) { var p = evt.CreateInputParameter(parameterName); p.DataType = type; p.IsMandatory = true; }
        return evt;
    }
    public static ISiteProperty Setting(IESpace space, string name, IBasicType type, string defaultValue, string description) {
        Require(!Walk(space).OfType<ISiteProperty>().Any(s => s.Name == name), "Setting already exists: " + name);
        var setting = space.CreateSiteProperty(false, name); setting.DataType = type; setting.SetDefaultValue(E(defaultValue)); setting.Description = description; return setting;
    }
    public static IClientVariable ClientVariable(IESpace space, string name, ITypeSignature type, string description, string? defaultValue = null) {
        Require(!Walk(space).OfType<IClientVariable>().Any(v => v.Name == name), "Client variable already exists: " + name);
        var variable = space.CreateClientVariable(name); variable.DataType = type; variable.Description = description;
        if (defaultValue != null) variable.SetDefaultValue(E(defaultValue));
        return variable;
    }
    public static IUserException UserException(IESpace space, string name) {
        Require(!Walk(space).OfType<IUserException>().Any(x => x.Name == name), "Exception already exists: " + name);
        return space.CreateUserException(name);
    }
    public static IAppRole Role(IESpace space, string name) {
        Require(!Walk(space).OfType<IAppRole>().Any(r => r.Name == name), "Role already exists: " + name);
        return space.CreateRole(name);
    }
    // Creating a role also creates its "Not <Role>" role exception, which references the role; both go together.
    public static void DeleteRole(IESpace space, string name) {
        var role = ModelPath.Single<IAppRole>(space, name);
        foreach (var exception in role.Referrers.OfType<IRoleException>().ToArray()) { RequireDeletable(exception); exception.Delete(); }
        RequireDeletable(role);
        role.Delete();
    }
}
