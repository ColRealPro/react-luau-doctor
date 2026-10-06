export class ExplanationTerminal {
  private columns = 120;
  private opened = false;
  private closed = false;
  private generation = 0;
  private render?: (columns: number) => Promise<string | null>;

  constructor(private readonly write: (text: string) => void) {}

  explain(render: (columns: number) => Promise<string | null>): void {
    this.render = render;
    this.generation++;
    if (this.opened) void this.refresh();
  }

  open(dimensions?: { columns: number }): void {
    this.opened = true;
    this.setDimensions(dimensions);
    void this.refresh();
  }

  setDimensions(dimensions?: { columns: number }): void {
    if (dimensions) this.columns = dimensions.columns;
  }

  close(): void {
    this.closed = true;
    this.generation++;
  }

  private async refresh(): Promise<void> {
    if (!this.render || this.closed) return;
    const generation = this.generation;
    let output: string;
    try {
      output = await this.render(this.columns) ??
        "This finding has changed\nRun Explain again from the current diagnostic\n";
    } catch (error) {
      output = `Unable to explain this finding: ${String(error)}\n`;
    }
    if (this.closed || generation !== this.generation) return;
    this.write(`\x1b[0m\x1b[2J\x1b[3J\x1b[H${output.replace(/\r?\n/g, "\r\n")}`);
  }
}
