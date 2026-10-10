using Anvil.Reading;
using OutSystems.Model;

namespace Anvil.Core;

public static class KernelSnapshotReading
{
    public static int Serve(string state, string generation, string work) => Hosting.SnapshotReadServer.Run(state, generation, bytes => {
        var host = new ModelHost(work);
        var model = host.Load(bytes);
        return new ReadSnapshot<IObjectSignature>(model, new KernelModelReader(), model.Name, () => ModelHost.Release(model));
    });
}
