// Source: sintese/s5-espera-dono.mjs; sha256: 234b5e5a7abfce5541c8cdb0e3ab4a19a30a8728f189d267bc25d6cb0b76b486.
// Port changes: parameterized input, pure functions, English filenames; drivers and output removed.
const CONT = /^\s*(siga|segue|seguir|pode|ok|okay|sim|s|beleza|blz|pronto|continue|continua|continuar|liberado|vai|bora|isso|autorizo|tudo bem|perfeito|obrigad|maravilha|show|top|valeu|certo|fechou|manda|faça|faca|go|yes|tentar novamente|1|2|3|a|b|c)\b/i;
export const isCont = t => /^\s*<(send_user_message_question_reply|in-app-browser-context|realtime_delegation)/.test(t) || /^\s*\[Request interrupted/.test(t) || (t.length < 90 && CONT.test(t));
// Preserve only this lexical evidence when sanitizing a real human message.
export const continuationWord = t => t.length < 90 ? CONT.exec(t)?.[1] ?? null : null;
