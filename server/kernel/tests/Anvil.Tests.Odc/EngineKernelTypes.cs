// platforms/odc/studio/engine/NativeMergeOrder.cs (linked into this project) names MergeOrder and DeferredDefault without a
// namespace: the ODC bridge compiles its own copy of them (platforms/odc/studio/bridge/MergeOrderCopy.cs, so the agent pack
// carries no kernel type); these tests bind the kernel's originals, the ones the copy is kept equal to.
global using MergeOrder = Anvil.Core.MergeOrder;
global using DeferredDefault = Anvil.Core.DeferredDefault;
