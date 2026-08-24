export function assertSessionEnvelope(record: Record<string, any>, session: Record<string, any>): void;
export function handleDriverRequest(request: Record<string, any>, driver?: Record<string, any>): Promise<any>;
export function requestedSelection(value: string | Record<string, unknown>): { model?: string; effort?: string };

export class DesktopCdpDriver {
  constructor(env?: Record<string, string | undefined>);
}
