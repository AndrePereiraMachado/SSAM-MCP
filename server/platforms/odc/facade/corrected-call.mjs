// A suggestion is not an executable correction when it still needs a placeholder.
export const executableCorrection = (call, code) => !/^(?:INVALID_JSON|READ_FAILED|FILE_TOO_LARGE|ANSWER_ORIGIN_UNKNOWN|EVIDENCE_NOT_FOUND|CLI_NOT_BUILT|CLI_REFUSED)$/.test(code ?? '')
  && !!call?.tool && !!call.arguments
  && !/<[^>]+>/.test(JSON.stringify(call.arguments));
