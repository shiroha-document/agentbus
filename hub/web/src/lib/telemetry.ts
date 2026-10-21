// Web analytics (埋点). Stub created by the integrator; workstream Web-2 implements the queue
// (contract: docs/design/v06-contract.md §5). Callers only ever use `track`.
export type TrackProps = Record<string, string | number | boolean>;

export function track(name: string, props: TrackProps = {}): void {
  void name;
  void props;
}
