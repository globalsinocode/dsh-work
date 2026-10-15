/** Run lifecycle states and JSON payload types shared by the domain layer and the run module. */
export type RunState = 'queued' | 'running' | 'waiting' | 'cancel_requested' | 'succeeded' | 'failed' | 'cancelled'

export type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue }

export type JsonObject = { [key: string]: JsonValue }
