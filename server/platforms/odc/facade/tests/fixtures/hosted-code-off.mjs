// The texts of the hosted server at b606ee7b (fase4-26/marco-a7), before ssam_code was served hosted: what the session
// reads while the switch (the class of ssam_code in hosted/tools.json) is off. Copied verbatim from that commit.
export const OFF_HOSTED_INSTRUCTIONS = 'This SSAM server is hosted: it runs on the SSAM owner\'s machine and drives the user\'s own '
  + 'Studios through the SSAM agent on the user\'s machine. ssam_debug, ssam_debug_run, ssam_debug_invoke, context, propose, '
  + 'continue and status are unavailable here (HOSTED_UNAVAILABLE). Files are named ws:<path> (the workspace of this account on '
  + 'the server: ODC files under ws:odc/, O11 files under ws:o11/, files the user delivered under ws:inbox/); pass them back '
  + 'exactly as returned. A file from the user\'s machine reaches SSAM when the user puts it in the agent inbox folder and you '
  + 'pass agent:inbox/<file>. Before any O11 tool, connect the Service Studio with ssam_connect {lane:"o11"}. When the agent is '
  + 'not connected, tools that need the user\'s Studio answer AGENT_NOT_CONNECTED; ssam_doctor shows the agent and the Studio '
  + 'versions of both sides. ssam_code is unavailable here too: read a module as text with ssam_map (views ddl, flow, html) and deliver '
  + 'the change as ONE job of o11_deliver or studio_deliver. The generator ops not offered here yet (entity-actions, '
  + 'rest-consume, screen with data.generate) are refused (GENERATOR_PENDING). No credential window opens here: odc_portal_login '
  + 'prompt and focus answer HOSTED_PROMPT_UNAVAILABLE.';
export const OFF_HOSTED_RULES = 'Jobs: ONE job per module, with every change of the request for that module (separate jobs only for different modules, '
  + 'never one action or one step per call), sent inline in the job argument as compact JSON (no indentation), whatever its size: '
  + 'the call goes straight to this server (up to 16 MiB), so a large job is still one call, with no upload through the agent. '
  + 'Never write a job to a file for this server, never with a shell heredoc or a script; a correction is patch + basedOn (nextBasedOn of the answer). '
  + 'An answer lists normalizations {total, byRule, items} when the kernel rewrote a shape of the job instead of refusing it (a sort, a null, an '
  + 'entity segment): they are applied already; read them, never resend the job to undo or repeat them. '
  + 'agent:inbox/<file> is only for the user\'s own files in the agent inbox folder (an OML, an image, an asset); an absolute path under '
  + 'the agent folder is taken as the same agent: path, any other path is refused with the exact folder. '
  + 'AGENT_RECONNECTING means the agent is reconnecting by itself: repeat the same call after retryAfterSeconds; ask the user to '
  + 'start the agent only when an answer says AGENT_NOT_CONNECTED. '
  + 'An approved prototype is ported 1:1 (html op plus its <style> in the theme), never replaced by OutSystems UI patterns; '
  + 'nothing is done until the app link (appLinks of the answer, or ssam_app_url) is given to the user. '
  + 'A subagent prompt loads the SSAM tools with ToolSearch before its first SSAM call.';
export const OFF_CAUSE = "SSAM_CODE_HOSTED_PENDING";
export const OFF_CONTINUATION = Object.freeze({"tool":"ssam_map","arguments":{"view":"flow"},"why":"Reads the module as text (view ddl, flow or html, target: the capture or the open module); the change then goes as ONE job of o11_deliver (O11) or studio_deliver (ODC)."});
