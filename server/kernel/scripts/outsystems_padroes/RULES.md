# Rules of the OutSystems standards

There are 35 OutSystems implementation rules and one product rule (P7). The **Checking** column says how much the tool
can decide by itself: automatic (the detector decides), partial (the detector flags what it can see and the rest goes
to review questions) or manual (a review question only). The **Stages** column says at which stage there is a detector
today. The **Platforms** column says where the rule applies.

Today every detection reads O11 jobs and OML. In a run with `--platform odc`, the job, truechange and oml stages do not
run, and every rule that applies to ODC comes out as "not checked on ODC yet"; AR1 comes out as "does not apply to ODC".
The runtime stage does not depend on the platform. The prerequisite K0 of the truechange stage (ok, accepted, isValid and
no policyMessage) is internal: it is not a rule and takes no exception.

| Id | Rule | Checking | Stages | Platforms |
|---|---|---|---|---|
| L1 | Simple and direct. Before creating anything, ask whether a shorter native form exists: a built-in function, a list action, a mapping or a filter in the aggregate. | manual | — | O11 and ODC |
| L2 | No auxiliary variable when the value can be computed directly. Use the expression where it is used. Create a local only when the value is reused or when it makes the flow easier to read. | partial | job | O11 and ODC |
| L3 | At most one If per value in an Assign. With more than one, use an If node in the flow or a client or server action with a clear name. | automatic | job, oml | O11 and ODC |
| L4 | One Assign per intent. An Assign named "Apply defaults" must not also clear errors. | manual | — | O11 and ODC |
| L5 | No JavaScript for business logic. JavaScript only for what the runtime does not offer, such as the clipboard or the focus on an element, always isolated and named. | automatic | job, truechange, oml | O11 and ODC |
| L6 | No JSONSerialize or JSONDeserialize to pass data inside the app. Use typed structures and parameters. | partial | job, oml | O11 and ODC |
| L7 | No fixed values in the code. Configuration goes in Site Properties, and fixed domains go in Static Entities. | partial | job | O11 and ODC |
| T1 | List actions instead of For Each whenever possible: ListFilter, ListAny, ListAll, ListIndexOf, ListSort, ListDistinct and ListAppendAll. | partial | job | O11 and ODC |
| T2 | Mapping instead of For Each with ListAppend. To convert a list of one type into another, use the data mapping of the Assign or of the parameter. | partial | job | O11 and ODC |
| T3 | For Each only when each item needs an effect or a decision the list actions cannot express. Never put a call to the server or to the database inside a For Each: it makes N+1 calls. | automatic | job, oml | O11 and ODC |
| T4 | Validate the list filters at runtime. On ODC, a client ListFilter condition written as List.Current.X passed the build and failed when running. Whether O11 has the same problem is not known. Do not trust the Studio validation alone: test. | partial | job, oml, runtime | O11 and ODC |
| D1 | Database reads only through a Screen Aggregate or a Data Action in Reactive and Mobile. In Traditional Web, through the Preparation. | partial (review only today) | — | O11 and ODC |
| D2 | Filter, sort and join inside the aggregate, not on the client afterwards. Fetch only the attributes used and set Max Records. | partial | job, oml | O11 and ODC |
| D3 | SQL only when the aggregate cannot do it. Always with parameters, and Expand Inline only with validated values. | partial | job, truechange, oml | O11 and ODC |
| D4 | An API that fills the screen goes in a Data Action. An API called on a submit may stay in the screen action, through a server action wrapper. | partial | job | O11 and ODC |
| D5 | No aggregate or server action inside loops. | automatic | job, truechange, oml | O11 and ODC |
| S1 | Do not use lifecycle events to call server or service actions. This applies to OnInitialize, OnReady, OnRender, OnParametersChanged and OnAfterFetch. That data comes from Data Actions or Aggregates with Fetch at start. | automatic | job, truechange, oml | O11 and ODC |
| S2 | A client or screen action makes at most one call to the server. When it needs several, create a server action that orchestrates them all. That gives one round trip, one transaction and one single point of error handling. | automatic | job, oml | O11 and ODC |
| S3 | Every external integration (REST or SOAP) stays in a server action wrapper, with exception handling, a suitable timeout and without logging tokens or personal data. | partial | job, oml | O11 and ODC |
| S4 | A timeout thought out for the real API. The default 20 s of screen requests is not always enough. | partial | job | O11 and ODC |
| U1 | Do not use the Visible property. Control visibility with If widgets. | automatic | job, oml | O11 and ODC |
| U2 | Reuse first the patterns of the app's pattern library (configurable) and then OutSystems UI. Do not create blocks without need. Prefer a simple structure on the screen itself. | partial (review only today) | — | O11 and ODC |
| U3 | No heavy logic in widget expressions. Compute it in the flow, only once. | partial | job | O11 and ODC |
| U4 | CSS in the theme or in the library, not inline. Use the OutSystems UI utility classes. | partial | job, truechange, oml | O11 and ODC |
| U5 | Blocks communicate through parameters and events, never by reading the state of the parent screen. | manual | — | O11 and ODC |
| N1 | Every element created has a short, meaningful name and description: actions, variables, parameters, relevant widgets and flow nodes. Actions: verb + object (ValidateAddress, GetOrderOptions). Booleans: the prefix Is, Has or Can. If nodes: a question (Order load succeeded?). Assigns: the intent (Apply default values). | partial | job, oml | O11 and ODC |
| N2 | Descriptions explain the why, they do not repeat the name. | partial | job, oml | O11 and ODC |
| N3 | Large flows carry floating comments marking each logical block. If the flow does not fit in one screen, extract parts into actions with their own names. | partial | job | O11 and ODC |
| N4 | No dead nodes: no orphan End, unreachable branch or unused variable. The TrueChange warnings stay at zero. | automatic | job, truechange, oml | O11 and ODC |
| E1 | Avoid unneeded locals: few, scalar whenever possible. | partial | job | O11 and ODC |
| E2 | Client Variables only with basic types, few and never sensitive. Session Variables in Traditional Web follow the same rule. | partial | job, oml | O11 and ODC |
| E3 | Configuration in Site Properties, never in a variable with a fixed default value. | partial | job, oml | O11 and ODC |
| AR1 | Respect the Architecture Canvas (End-user, Core and Foundation): no upward references, no cycles. Entities stay in the Core, exposed as read-only, and writes go through actions. | automatic | job, oml | O11 only |
| AR2 | Role checks on the server, not only by hiding a button in the UI. Never trust input coming from the client. | partial | job, truechange, oml | O11 and ODC |
| AR3 | Long processes go to Timers or BPT, never in a screen request. | partial | job, oml | O11 and ODC |
| P7 | Product rule. Automatic entry points (tools, runners, timers) do not write protected entities nor call actions reserved to a human decision, and the code never assigns switch site properties. Configurable in `config.p7`; the write check stays off while the list of protected entities is empty. Takes no exception. | automatic | job, oml | O11 and ODC |

## What the detection looks for today (O11)

| Rule | Signals |
|---|---|
| L1 | Review only: asks whether a built-in, a list action, a mapping or an aggregate filter replaces some part. |
| L2 | A local written once and seldom read (warning). |
| L3 | More than one `If(` in the value of an Assign. |
| L4 | Review only. |
| L5 | A JavaScript node, Script, `html.scripts`, an `on*` attribute, JavaScript in the module or in the block, the warning `JavascriptInjection`. |
| L6 | A JSON node (passes only with an exception of the element itself), a Text named `*Json`, fields of `config.l6`. |
| L7 | A URL, host or e-mail literal; a text compared with `=` or `<>` (warning); a number outside `numericAllowProps` (warning); a secret site property with a DefaultValue. |
| T1 | A ForEach body that looks like a list action (warning); `html.derived`. |
| T2 | A ListAppend of `*.Current.*` inside a ForEach (warning). |
| T3 | Same as D5. |
| T4 | Each list action becomes an item of `runtimeTests` with its condition; the runtime stage asks for the E2E evidence. |
| D1 | No detector today; a review question. |
| D2 | An aggregate without Max Records, a `get` without `max`, a ListFilter or ListSort on the client over an aggregate, `html.derived`. The attributes used stay in the review. |
| D3 | Every SQL node needs an exception with its reason; ExpandInline outside a literal T-SQL token; `sp_executesql` or `EXEC()`; the warnings `SQLInjection` and `SQL_ExpandInlineNotValidated`. |
| D4 | REST outside `config.integrationModules`; REST called directly from the screen. |
| D5 | A query or a server call inside a loop or a cycle of the flow (Tarjan); the warning `EntityActionInsideLoop`. |
| S1 | A lifecycle event that reaches the server; the warnings `ClientActionWithServerRequestsOnLifecycleEvent` and `SelfRefreshingAggregate`. |
| S2 | More than one server call on the same path, including through called client actions; the `call` binding of the html op. |
| S3 | REST outside the integration modules; a site property that looks like a secret without IsSecret. |
| S4 | A REST method without `TimeoutinSeconds` or outside `config.timeoutPolicy`. |
| U1 | Visible other than empty and `True`; the `hidden` attribute; the `visible` binding. |
| U2 | No detector today; the review question names `config.patternLibrary` when it is filled. |
| U3 | A binding expression that calls a client function. |
| U4 | The `style` attribute, CustomStyle (warning), a screen StyleSheet, a block StyleSheet outside `config.libraries`, the warning `InvalidCSSStyle`. |
| U5 | Review only. |
| N1 | An empty description, a generic Label, an If that is no question, an action that does not start with a verb, a boolean without Is, Has or Can. |
| N2 | A description that is short, equal to the name, made only of the words of the name, or a marker. |
| N3 | A flow above `limits.commentAt` steps without a comment; above `limits.extractAt` (warning). |
| N4 | Every TrueChange warning (base and new), an orphan End, an unreachable node, a disabled node. |
| E1 | More locals than `limits.maxLocals`; a list or record local (warning). |
| E2 | Every client variable (needs an exception), a non-basic type, a sensitive name. |
| E3 | A local with a literal default never assigned; an expected site property missing (`config.expectedSiteProperties`). |
| AR1 | Layers (`config.modules`, `modulePatterns`, `forbiddenRefs`); an entity or static outside the Core; a public entity without ExposeReadOnly. |
| AR2 | A screen without Roles or with Anonymous; a write or read of the subject's data without a guard before it; AllExceptions over the guard; `GetUserId()` coming from the client. A public facade that only forwards to its own `<Name>_Impl` inherits the check of the `_Impl`. |
| AR3 | A screen that reaches `config.longRunning` or REST; a timer without TimeoutInMinutes (warning). |
| P7 | A write to `config.p7.protectedEntities` (except `allowedEntities`) from `config.p7.entryPatterns`; a call to `config.p7.forbiddenCalls`; an assign of `config.p7.siteSwitches`. |
