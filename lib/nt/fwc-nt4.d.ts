// The package's type path for this entry point points at a folder, so TypeScript can't find it. These are the parts
// of FRC Web Components' NT4 client that Live mode uses.
declare module "@frc-web-components/fwc/source-providers/nt4" {
  export class Nt4Topic {
    uid: number
    name: string
    type: string
    properties: Record<string, unknown>
  }

  export class Nt4Client {
    constructor(
      serverAddr: string,
      appName: string,
      onTopicAnnounce: (topic: Nt4Topic) => void,
      onTopicUnannounce: (topic: Nt4Topic) => void,
      onNewTopicData: (topic: Nt4Topic, timestampUs: number, value: unknown) => void,
      onConnect: () => void,
      onDisconnect: () => void,
    )
    connect(): void
    disconnect(): void
    subscribePeriodic(topicPatterns: string[], prefixMode: boolean, period: number): number
    subscribeAll(topicPatterns: string[], prefixMode: boolean): number
    publishNewTopic(topic: string, type: string): void
    addSample(topic: string, value: unknown): void
    addTimestampedSample(topic: string, timestamp: number, value: unknown): void
    getServerTime_us(): number | null
  }
}
