// ODC keeps the expression contract in OutSystems.Model.Expressions; SS11 keeps it in OutSystems.Model.
// The kernel names it unqualified (IExpression), so each build resolves it from its own platform: SS11 through
// `using OutSystems.Model;`, ODC through this alias. Nothing else is aliased: every other kernel name is the same on both.
global using IExpression = OutSystems.Model.Expressions.IExpression;
