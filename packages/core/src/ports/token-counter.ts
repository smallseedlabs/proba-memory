/** TokenCounter port: how many model tokens a text costs. Used for context packing. */
export interface TokenCounter {
  readonly name: string;
  count(text: string): number;
}
