/** Providers can request a pause for quota/auth failures without coupling the room to their SDK. */
export class InferenceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly blocksInference = false) { super(message); }
}
