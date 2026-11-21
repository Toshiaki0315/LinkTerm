/** マクロの文法・実行時のエラー。`line` は 1 から数える行番号。 */
export class TtlError extends Error {
  constructor(
    message: string,
    public line?: number,
  ) {
    super(message);
    this.name = "TtlError";
  }
}
