using Anvil.Reading;
using OutSystems.Model;

namespace Anvil.Core;

public static class KernelSnapshotReading
{
    public static int Serve(string state, string generation, string work) => Hosting.SnapshotReadServer.Run(state, generation, bytes => Open(new ModelHost(work), bytes));

    // One capture loaded as the read process serves it (tests read the selective reading through the same snapshot).
    public static IReadSnapshot Open(ModelHost host, byte[] bytes)
    {
        var model = host.Load(bytes);
        return new ReadSnapshot<IObjectSignature>(model, new KernelModelReader(), model.Name, () => ModelHost.Release(model));
    }
}
