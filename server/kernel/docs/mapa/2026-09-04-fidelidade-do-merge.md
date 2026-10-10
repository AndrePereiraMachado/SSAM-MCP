# Fidelidade do merge (plano, item 17): causa raiz e correcao (2026-09-04)

Incidente: o merge automatico de `Headless_UI.foreign.084203.oml` (valido, 25.516 objetos, 212 warnings) deixou o modulo aberto
com 2 erros, 10 warnings a mais e 56 objetos a menos (`base.084358.oml`). Investigado por subagente, read-only, com reproducao
headless sem Studio (MatchTree + Publisher.Mutate(local, tree.Merge)).

## Resumo

1. Os 2 erros sao `RequiredPropertyValue_PropertyIn_WithPrevious` ("Unknown 'Utilities\MouseEvents' Source Block in 'MouseEvents1'",
   idem `TouchEvents1`) na tela `Gallery_UI_Utilities`; os 10 warnings sao 6 `UnusedAction` (handlers Start/Move/End dos dois blocos),
   2 `UnusedArgument` e 2 `UnusedElement` derivados.
2. Os 56 objetos perdidos sao exatamente os filhos das duas instancias de bloco: 2 x (1 Argument PreventDefaults + 3
   CustomEventHandler + 12 Argument dos handlers + 12 ParsedExpression). Todos NOVOS no foreign (criados pelo job).
3. CAUSA RAIZ (certa, reproduzida): o job instanciou `MouseEvents` e `TouchEvents` do OutSystemsUI cujo `ReferenceWebBlock` ja
   existia no base como referencia OCULTA (`Hidden=True`, dependencia indireta) e o job nao a desocultou. No merge automatico
   (`checkDependencies:false`), `SourceWebBlock` da instancia fica nulo com `PreviousValue`, `SynchronizeArguments` corre sem
   provider e apaga handlers e argumentos.
4. Correcao provada: com `Hidden=false` nos dois `ReferenceWebBlock` do foreign antes do merge, o resultado e identico ao
   foreign (25.516 objetos, 212 warnings, valido). Desocultar so no local tambem resolve (com `hasConflicts=True`).
5. `byStructure` NAO estava em true (`MergeHandler.cs` omissao false; `proof_merge.py` nao passa `match_by_structure`).
   `automaticMerge=true` desliga a verificacao de dependencias, o unico caminho do Studio que puxa referencias ocultas.

## Evidencia

- Delta de mensagens e objetos calculado com `ModelHost.ValidationDetails` sem teto e `DirectChildren`: mensagens so no pos-merge
  = 10 (2 Error + 6 UnusedAction + 2 UnusedArgument); objetos so no foreign = 56 = {CustomEventHandler 6, Argument 26,
  ParsedExpression 24}, todos sob `.../Gallery_UI_Utilities/.../MouseEvents1|TouchEvents1`; objetos a mais no pos-merge = 0.
- Referencias: `ReferenceWebBlock MouseEvents` `Hidden=True` no base, no foreign e no pos-merge; os parametros `WidgetId`/
  `PreventDefaults` `Hidden=True` no base e `False` no foreign; no pos-merge a instancia tem 1 Argument com `Parameter=null,
  IsUnused=True` e 0 handlers.
- Matchtree das 08:42 (27.612 linhas): zero `Conflict`; 81 blocos de referencia `[AddedToForeign]` intactos; so os 2 blocos
  pre-existentes-ocultos com `[DifferenceInForeignChildren]` e `Hidden[True] / Hidden[False] [Not Visible]` perderam filhos.
- Reproducao headless: `plain` = 25.460 objetos, 222 msgs, 2 Error identicos; `unhideforeign` = 25.516 objetos, 212 warnings,
  valido; `unhidelocal` = instancia integra, valido.
- Studio (ServiceStudio.Framework descompilado): `ReferenceWebBlock.IsUserVisible => Hidden ? IsBeingUpgradedToNonHidden() : true`
  (:406178-406184); `Match.IsHiddenMergeUnit` (:26389-26397); `UpdateMergeActionInner` -> `SetIsChecked(..., checkDependencies:false)`
  (:26947, :26963); regra que puxa `ITopLevelReferenceElement` oculto exige `checkDependencies` (:29848-29856);
  `WebBlockInstance.MergeRegularProperties` poe `PreviousSourceWebBlockValue` quando `ForeignToLocal(SourceWebBlock)` nao da objeto
  (:353297-353308); `SynchronizeArguments` apaga argumentos sem provider (:644701-644760);
  `ReferedByNamePropertyDescriptor.GetMandatoryVerifyMessages` gera `RequiredPropertyValue_PropertyIn_WithPrevious` (:797934-797946).

## Correcao no produto

1. `Verbs.cs` (Create com `source` e Set de `SourceBlock`/`SourceWebBlock`): se o alvo e `ITopLevelReferenceElement` com
   `Hidden==true`, por `Hidden=false` (setter publico) e desocultar parametros/eventos filhos; generalizar a qualquer propriedade
   ReferedByName que aponte para elemento de referencia oculto (actions, entidades). Alternativa oficial: `IESpace.RefreshDependencies`
   com o bloco como shareable (ja usado pelo verbo `reference`).
2. `Verbs.Resolve`: quando o hit vier so por `*Signature` e estiver oculto, registar `hiddenReference:true` no resultado.
3. `MergeHandler`: antes de `CompareAndMerge`, varrer o foreign por `ITopLevelReferenceElement.Hidden==true` com referers no
   proprio modulo e recusar (`foreign uses hidden reference X: unhide it in the job`): gate barato, fail-closed.
4. Teste: job `tests/jobs/hidden-reference-block.json` sobre `mobile-ui.oml` (instancia de `MouseEvents` com handler) e Fact que
   monta `MatchTree(local, foreign, base, false, true)` + `Publisher.Mutate(local, tree.Merge)` e exige objetos(local) ==
   objetos(foreign) e Verify sem Error (`MergeProbe` em Anvil.Core). Aceite vivo: `proof_merge.py --module Headless_UI --job
   .local/gallery/gallery-reactive-job.json` com `novas=0` (delta do item 16b).

## Nao verificado

Merge interativo (mode=dialog) com o mesmo par; outros tipos de elemento oculto (entidades, actions) com o mesmo sintoma; o
ponto interno exato da rejeicao (ForeignToLocal nulo para unidade oculta vs CoerceValueAndKeepPrevious). Ferramentas do
subagente no scratchpad da sessao (msgs/Program.cs).
